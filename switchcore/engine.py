"""Run one TestCase against old_a, old_b and new switches and compute the verdict."""
from __future__ import annotations
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time

from shared.schemas import CaseResult, StepResult, TestCase
from switchcore import iso
from switchcore.switch import Switch

ROLES = ("old_a", "old_b", "new")


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            try:
                raw = iso.read_frame(self.request)
            except ConnectionError:
                return
            self.request.sendall(iso.frame(self.server.switch.handle(raw)))


class _TcpPool:
    """One TCP server per role for the whole batch; the Switch object behind it is swapped per case."""

    def __init__(self):
        self.servers = {}
        for role in ROLES:
            srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
            srv.daemon_threads = True
            srv.switch = None
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers[role] = srv

    def connect(self, role: str, switch: Switch) -> socket.socket:
        self.servers[role].switch = switch
        return socket.create_connection(self.servers[role].server_address, timeout=5)

    def close(self):
        for srv in self.servers.values():
            srv.shutdown()
            srv.server_close()


_pool: _TcpPool | None = None


def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        _pool = None


def run_case(case: TestCase, new_bugs: set[str], old_bugs: set[str] = set(),
             transport: str = "inproc") -> CaseResult:
    global _pool
    t0 = time.perf_counter()
    switches = {"old_a": Switch("old_a", old_bugs), "old_b": Switch("old_b", old_bugs), "new": Switch("new", new_bugs)}
    for sw in switches.values():
        sw.load_accounts(case.accounts)
    before = {r: sw.balances() for r, sw in switches.items()}
    expiry = {a.pan: a.expiry_yymm for a in case.accounts}
    socks = {}
    try:
        if len(case.expected_codes) != len(case.steps):
            raise ValueError("expected_codes must have one code per step")
        if transport == "tcp":
            _pool = _pool or _TcpPool()
            socks = {r: _pool.connect(r, sw) for r, sw in switches.items()}

        steps: list[StepResult] = []
        for i, step in enumerate(case.steps):
            raw, fields = iso.build_request(step, expiry.get(step.pan, "2912"))
            resp = {}
            for role, sw in switches.items():
                if transport == "tcp":
                    socks[role].sendall(iso.frame(raw))
                    resp[role] = iso.read_frame(socks[role])
                else:
                    resp[role] = sw.handle(raw)
            codes = {r: iso.parse(b)["39"] for r, b in resp.items()}
            steps.append(StepResult(index=i, request_fields=fields, request_hex=raw.hex(),
                                    expected_code=case.expected_codes[i], old_a_code=codes["old_a"],
                                    old_b_code=codes["old_b"], new_code=codes["new"],
                                    new_response_hex=resp["new"].hex()))

        deltas = {r: {pan: sw.balances()[pan] - before[r][pan] for pan in before[r]} for r, sw in switches.items()}
        result = CaseResult(case_id=case.id, verdict=_verdict(case, steps, deltas), steps=steps,
                            balance_delta_cents=deltas, duration_ms=0)
        if case.check_script:
            result.check_output = _run_check_script(case.check_script, result)
            if result.check_output.startswith(("exit=", "timeout")) and not result.check_output.startswith("exit=0"):
                result.verdict, result.error = "error", "agent-written check_script failed (see check_output)"
    except Exception as e:  # malformed case, socket failure, ...
        result = CaseResult(case_id=case.id, verdict="error", steps=[], balance_delta_cents={},
                            error=f"{type(e).__name__}: {e}", duration_ms=0)
    finally:
        for s in socks.values():
            s.close()
    result.duration_ms = int((time.perf_counter() - t0) * 1000)
    return result


def _verdict(case: TestCase, steps: list[StepResult], deltas: dict[str, dict[str, int]]) -> str:
    codes = {r: [getattr(s, f"{r}_code") for s in steps] for r in ROLES}
    if codes["old_a"] != codes["old_b"] or deltas["old_a"] != deltas["old_b"]:
        return "noise"
    old_ok = codes["old_a"] == case.expected_codes and all(
        deltas["old_a"].get(pan, 0) == d for pan, d in case.expected_balance_delta_cents.items())
    if not old_ok:
        return "both_wrong"
    if codes["new"] == codes["old_a"] and deltas["new"] == deltas["old_a"]:
        return "pass"
    return "regression"


def _run_check_script(script: str, result: CaseResult) -> str:
    """Agent-written assertions. Executed ONLY inside the gVisor sandbox image."""
    if os.environ.get("SWITCHPROOF_IN_SANDBOX") != "1":
        return "skipped: not in sandbox"
    if os.environ.get("SANDBOX_POOL") == "data":
        return "refused: the data sandbox never runs agent-written code"
    ctx = json.dumps({"steps": [s.model_dump() for s in result.steps], "balance_delta_cents": result.balance_delta_cents})
    wrapped = "import json,sys\nresult=json.load(sys.stdin)\n" + script
    try:
        p = subprocess.run([sys.executable, "-c", wrapped], input=ctx, capture_output=True, text=True, timeout=5)
        out = (p.stdout + p.stderr)[-2048:]
        return f"exit={p.returncode}\n{out}"
    except subprocess.TimeoutExpired:
        return "timeout after 5 s"
