"""Client for the sandbox host (VM #2). Fake mode (SANDBOX_HOST_URL unset) runs cases in-process - DEV ONLY."""
from __future__ import annotations
import asyncio
import itertools
import json
import logging
import os
import platform
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone

import httpx

from control_plane import k8s
from shared.schemas import BatchRequest, BatchResult, JobRequest, JobResult, ProbeResult, SandboxProof

log = logging.getLogger("switchproof.sandbox")


def urls() -> list[str]:
    """SANDBOX_HOST_URL may list several sandbox VMs (comma-separated): batches are spread across them."""
    return [u.strip().rstrip("/") for u in os.environ.get("SANDBOX_HOST_URL", "").split(",") if u.strip()]


def url() -> str | None:
    return (urls() or [None])[0]


_next = itertools.count()


_warned = False


def fake() -> bool:
    global _warned
    if k8s.enabled():
        return False
    if url() is None:
        if not _warned:
            _warned = True
            log.warning("SANDBOX_HOST_URL unset: FAKE MODE, tests run on the control plane itself (development only!)")
        return True
    return False


async def _call(method: str, path: str, body: str | None = None, timeout: float = 180, host: str | None = None) -> dict:
    headers = {"X-SwitchProof-Token": os.environ.get("SANDBOX_TOKEN", ""), "Content-Type": "application/json"}
    for attempt in range(3):   # retry on connect errors only
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.request(method, (host or url()) + path, headers=headers, content=body)
            if r.status_code >= 400:
                raise RuntimeError(f"sandbox host {path} -> HTTP {r.status_code}: {r.text[:500]}")
            return r.json()
        except httpx.ConnectError:
            if attempt == 2:
                raise
            await asyncio.sleep(1)
    raise AssertionError("unreachable")


def _local_proof() -> SandboxProof:
    return SandboxProof(sandbox_id=f"fake-{uuid.uuid4().hex[:8]}", runtime="local-unsafe", hostname=socket.gethostname(),
                        uname=" ".join(x for x in platform.uname() if x), network="host", readonly_rootfs=False)


def _fake_batch(req: BatchRequest) -> BatchResult:
    from switchcore.engine import run_case
    started = datetime.now(timezone.utc).isoformat()
    results = [run_case(c, set(req.new_switch_bugs), set(req.old_switch_bugs)) for c in req.cases]
    return BatchResult(batch_id=req.batch_id, run_id=req.run_id, proof=_local_proof(), results=results,
                       started_at=started, finished_at=datetime.now(timezone.utc).isoformat(), destroyed=True)


async def run_batch(req: BatchRequest) -> BatchResult:
    if fake():
        return await asyncio.to_thread(_fake_batch, req)
    if k8s.enabled():
        out, _, destroyed = await k8s.run(["-m", "switchcore.runner"], req.model_dump_json(), req.timeout_s)
        return BatchResult.model_validate({**out, "destroyed": destroyed})
    hosts = urls()
    host = hosts[next(_next) % len(hosts)]              # round-robin: scale out by adding sandbox VMs
    return BatchResult.model_validate(await _call("POST", "/batch", req.model_dump_json(), timeout=req.timeout_s + 60, host=host))


def _fake_job(req: JobRequest) -> JobResult:
    p = subprocess.run([sys.executable, "-m", req.module], input=json.dumps(req.args), capture_output=True,
                       text=True, timeout=req.timeout_s)
    if p.returncode != 0:
        raise RuntimeError(f"{req.module} failed: {p.stderr[-800:]}")
    out = json.loads([l for l in p.stdout.splitlines() if l.strip()][-1])
    out.pop("_proof", None)
    return JobResult(job_id=req.job_id, proof=_local_proof(), output=out, destroyed=True)


async def run_job(req: JobRequest) -> JobResult:
    if fake():
        return await asyncio.to_thread(_fake_job, req)
    if k8s.enabled():
        out, _, destroyed = await k8s.run(["-m", req.module], json.dumps(req.args), req.timeout_s)
        return JobResult(job_id=req.job_id, proof=out.pop("_proof"), output=out, destroyed=destroyed)
    return JobResult.model_validate(await _call("POST", "/job", req.model_dump_json(), timeout=req.timeout_s + 60))


async def probe() -> ProbeResult:
    if k8s.enabled():
        out, _, destroyed = await k8s.run(["-m", "switchcore.runner", "--probe"], "{}", 60)
        return ProbeResult.model_validate({**out, "destroyed": destroyed})
    if fake():
        raise RuntimeError("isolation probe needs the real sandbox host (SANDBOX_HOST_URL) or SANDBOX_BACKEND=k8s")
    return ProbeResult.model_validate(await _call("POST", "/probe", timeout=120))


async def health() -> dict:
    if k8s.enabled():
        return await k8s.health()
    if url() is None:
        return {"mode": "fake", "kvm": False, "runsc": False, "active_sandboxes": 0,
                "hostname": socket.gethostname(), "uname": " ".join(x for x in platform.uname() if x),
                "warning": "SANDBOX_HOST_URL unset - tests run in-process (development only)"}
    async def one(h):
        try:
            return {**await _call("GET", "/health", timeout=10, host=h), "url": h}
        except Exception as e:
            return {"error": str(e), "url": h}
    hs = await asyncio.gather(*(one(h) for h in urls()))
    return {**hs[0], "hosts": hs} if len(hs) > 1 else hs[0]
