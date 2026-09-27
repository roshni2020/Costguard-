"""Isolation probe. Runs ONLY inside the gVisor sandbox (refuses otherwise): tries hostile actions, reports each."""
from __future__ import annotations
import os
import socket
import subprocess

from shared.schemas import ProbeCheck, ProbeResult, SandboxProof


def _connect(host: str, port: int) -> str | None:
    try:
        socket.create_connection((host, port), timeout=3).close()
        return None
    except OSError as e:
        return f"{type(e).__name__}: {e}"


def _check(name: str, attempted: str, err: str | None) -> ProbeCheck:
    """err is None when the action SUCCEEDED (bad), else the error that stopped it."""
    return ProbeCheck(name=name, attempted=attempted, outcome="ALLOWED" if err is None else "BLOCKED",
                      detail=err or "action succeeded")


def run_probe(proof: SandboxProof) -> ProbeResult:
    if os.environ.get("SWITCHPROOF_IN_SANDBOX") != "1":
        raise SystemExit("refusing to run the isolation probe outside the sandbox image")
    checks = []

    p = subprocess.run(["rm", "-rf", "--no-preserve-root", "/"], capture_output=True, text=True, timeout=30)
    survived = os.path.exists("/usr/local/bin/python3") and os.path.exists("/app/switchcore/probe.py")
    tail = (p.stderr.strip().splitlines() or ["no output"])[-1]
    checks.append(ProbeCheck(name="Delete everything", attempted="rm -rf --no-preserve-root /",
                             outcome="BLOCKED" if survived else "ALLOWED",
                             detail=f"read-only root fs, files still present; rm said: {tail[:200]}" if survived
                             else "root filesystem was modified"))

    checks.append(_check("Internet egress", "TCP connect 1.1.1.1:443", _connect("1.1.1.1", 443)))
    try:
        socket.getaddrinfo("example.com", 443)
        dns_err = None
    except OSError as e:
        dns_err = f"{type(e).__name__}: {e}"
    checks.append(_check("DNS lookup", "resolve example.com", dns_err))
    cp = os.environ.get("CONTROL_PLANE_ADDR", "10.0.0.1:8000")
    host, port = cp.rsplit(":", 1)
    checks.append(_check("Reach control plane", f"TCP connect {cp}", _connect(host, int(port))))
    checks.append(_check("Cloud metadata service", "TCP connect 169.254.169.254:80", _connect("169.254.169.254", 80)))
    try:
        with open("/etc/switchproof-pwned", "w") as fh:
            fh.write("x")
        w_err = None
    except OSError as e:
        w_err = f"{type(e).__name__}: {e}"
    checks.append(_check("Write system files", "echo x > /etc/switchproof-pwned", w_err))
    sock = "/var/run/docker.sock"
    checks.append(_check("Escape via Docker socket", f"open {sock}", None if os.path.exists(sock) else "socket not mounted"))
    return ProbeResult(proof=proof, checks=checks, destroyed=False)
