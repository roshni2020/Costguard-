"""Sandbox host (VM #2). One fresh gVisor container per /batch, /job, /probe; destroyed afterwards.

    SANDBOX_MODE=gvisor|local SANDBOX_TOKEN=... uvicorn sandbox_host.app:app --host <private-ip> --port 9000
"""
from __future__ import annotations
import asyncio
import hmac
import json
import logging
import os
import platform
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException

from shared.schemas import BatchRequest, BatchResult, JobRequest, JobResult, ProbeResult

log = logging.getLogger("sandbox_host")
MODE = os.environ.get("SANDBOX_MODE", "local")
IMAGE = os.environ.get("RUNNER_IMAGE", "switchproof-runner:latest")
REPO = Path(__file__).resolve().parent.parent
SEM = asyncio.Semaphore(4)
ACTIVE: dict[str, str] = {}

app = FastAPI(title="SwitchProof sandbox host")


def auth(x_switchproof_token: str = Header(default="")):
    expected = os.environ.get("SANDBOX_TOKEN", "")
    if not expected:
        raise HTTPException(500, "SANDBOX_TOKEN is not set on the sandbox host")
    if not hmac.compare_digest(x_switchproof_token, expected):
        raise HTTPException(401, "bad token")


def _docker_cmd(sid: str, argv: list[str]) -> list[str]:
    return ["docker", "run", "-i", "--rm", "--name", sid, "--hostname", sid,
            "--runtime=runsc", "--network=none", "--read-only",
            "--tmpfs", "/tmp:rw,size=64m,mode=1777", "--memory=512m", "--cpus=1", "--pids-limit=256",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "-e", f"SANDBOX_ID={sid}", "-e", "SANDBOX_RUNTIME=runsc",
            "-e", f"CONTROL_PLANE_ADDR={os.environ.get('CONTROL_PLANE_ADDR', '10.0.0.1:8000')}",
            IMAGE, *argv]


def _run(argv: list[str], stdin: str, timeout: int) -> tuple[dict, str, bool]:
    """Runs `python <argv>` in a fresh sandbox. Returns (last stdout JSON line, sandbox id, destroyed)."""
    sid = f"sp-{uuid.uuid4().hex[:10]}"
    ACTIVE[sid] = datetime.now(timezone.utc).isoformat()
    try:
        if MODE == "gvisor":
            cmd = _docker_cmd(sid, ["python", *argv])
            env = None
        else:  # dev only: plain subprocess on this machine
            cmd = [sys.executable, *argv]
            env = {**os.environ, "SANDBOX_ID": sid, "SANDBOX_RUNTIME": "local-unsafe"}
            env.pop("SWITCHPROOF_IN_SANDBOX", None)
        try:
            p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, cwd=REPO, env=env)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, f"sandbox {sid} timed out after {timeout}s")
        if p.returncode != 0:
            raise HTTPException(502, f"sandbox {sid} exited {p.returncode}: {p.stderr[-1500:]}")
        lines = [l for l in p.stdout.splitlines() if l.strip()]
        if not lines:
            raise HTTPException(502, f"sandbox {sid} printed nothing: {p.stderr[-1500:]}")
        return json.loads(lines[-1]), sid, True
    finally:
        if MODE == "gvisor":
            subprocess.run(["docker", "rm", "-f", sid], capture_output=True)
        ACTIVE.pop(sid, None)


def _destroyed(sid: str) -> bool:
    if MODE != "gvisor":
        return True
    out = subprocess.run(["docker", "ps", "-a", "-q", "--filter", f"name=^{sid}$"], capture_output=True, text=True)
    return out.returncode == 0 and not out.stdout.strip()


async def _sandboxed(argv: list[str], stdin: str, timeout: int) -> tuple[dict, str]:
    async with SEM:
        out, sid, _ = await asyncio.to_thread(_run, argv, stdin, timeout)
        return out, sid


@app.get("/health", dependencies=[Depends(auth)])
def health():
    runsc = False
    try:
        info = subprocess.run(["docker", "info", "--format", "{{json .Runtimes}}"], capture_output=True, text=True, timeout=10)
        runsc = "runsc" in info.stdout
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"kvm": os.path.exists("/dev/kvm") and os.access("/dev/kvm", os.R_OK | os.W_OK), "runsc": runsc,
            "mode": MODE, "active_sandboxes": len(ACTIVE), "hostname": socket.gethostname(), "uname": " ".join(x for x in platform.uname() if x)}


@app.post("/batch", dependencies=[Depends(auth)])
async def batch(req: BatchRequest) -> BatchResult:
    out, sid = await _sandboxed(["-m", "switchcore.runner"], req.model_dump_json(), req.timeout_s)
    res = BatchResult.model_validate(out)
    res.destroyed = await asyncio.to_thread(_destroyed, res.proof.sandbox_id)
    return res


@app.post("/job", dependencies=[Depends(auth)])
async def job(req: JobRequest) -> JobResult:
    out, sid = await _sandboxed(["-m", req.module], json.dumps(req.args), req.timeout_s)
    sandbox_proof = out.pop("_proof")          # whitelisted modules report proof() from inside the sandbox
    return JobResult(job_id=req.job_id, proof=sandbox_proof, output=out, destroyed=await asyncio.to_thread(_destroyed, sid))


@app.post("/probe", dependencies=[Depends(auth)])
async def probe() -> ProbeResult:
    if MODE != "gvisor":
        raise HTTPException(400, "the isolation probe only runs in gvisor mode (it executes rm -rf /)")
    out, sid = await _sandboxed(["-m", "switchcore.runner", "--probe"], "", 60)
    res = ProbeResult.model_validate(out)
    res.destroyed = await asyncio.to_thread(_destroyed, sid)
    return res


@app.get("/sandboxes", dependencies=[Depends(auth)])
def sandboxes():
    return {"active": [{"sandbox_id": k, "started_at": v} for k, v in ACTIVE.items()]}
