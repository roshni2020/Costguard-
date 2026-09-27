"""Runs INSIDE the sandbox: BatchRequest JSON on stdin (or file arg) -> one BatchResult JSON line on stdout.

    python -m switchcore.runner [batch.json]
    python -m switchcore.runner --probe
"""
from __future__ import annotations
import logging
import os
import platform
import socket
import sys
import uuid
from datetime import datetime, timezone

from shared.schemas import BatchRequest, BatchResult, SandboxProof
from switchcore.engine import close_pool, run_case


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _interfaces() -> list[str]:
    try:
        with open("/proc/net/dev") as fh:
            return [l.split(":")[0].strip() for l in fh.readlines()[2:]]
    except OSError:
        return ["unknown"]


def _readonly_root() -> bool:
    try:
        with open("/probe_ro", "w") as fh:
            fh.write("x")
        os.remove("/probe_ro")
        return False
    except OSError:
        return True


def proof() -> SandboxProof:
    ifaces = [i for i in _interfaces() if i != "lo"]
    sandboxed = os.environ.get("SANDBOX_RUNTIME") == "runsc"
    return SandboxProof(
        sandbox_id=os.environ.get("SANDBOX_ID", f"local-{uuid.uuid4().hex[:8]}"),
        runtime="runsc" if sandboxed else "local-unsafe",
        hostname=socket.gethostname(),
        uname=" ".join(platform.uname()),
        network="none" if not ifaces else ",".join(ifaces),
        readonly_rootfs=sandboxed and _readonly_root(),     # outside the sandbox the root fs is the host's: never claim it
    )


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    if "--probe" in sys.argv:
        from switchcore.probe import run_probe
        print(run_probe(proof()).model_dump_json())
        return
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw = open(args[0]).read() if args else sys.stdin.read()
    req = BatchRequest.model_validate_json(raw)
    started = now()
    try:
        results = [run_case(c, set(req.new_switch_bugs), set(req.old_switch_bugs), transport="tcp") for c in req.cases]
    finally:
        close_pool()
    print(BatchResult(batch_id=req.batch_id, run_id=req.run_id, proof=proof(), results=results,
                      started_at=started, finished_at=now(), destroyed=False).model_dump_json())


if __name__ == "__main__":
    main()
