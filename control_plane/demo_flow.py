"""End-to-end demo through the real HTTP API:  LLM_OFFLINE=1 python -m control_plane.demo_flow [--replay N]"""
from __future__ import annotations
import sys
import time

from fastapi.testclient import TestClient

from control_plane.app import app

DEMO = {
    "title": "Core switch migration — Legacy v4 → NewSwitch v1",
    "requirements": [
        "Approve a purchase when funds are available",
        "Decline a purchase for insufficient funds",
        "Reject a duplicate purchase (same card, STAN and amount within 60 seconds)",
        "Reverse an approved payment and restore the balance",
    ],
    "rules_text": ("Check order for 0100/0200: unknown card -> 14; blocked -> 62; expired -> 54; bad PIN -> 55; issuer glitch -> 96; "
                   "duplicate (same card + STAN + amount within 60 seconds) -> 94; balance < amount -> 51; else 00 and debit. "
                   "0400 reversal: original not found or not approved -> 25; already reversed -> 94; else credit back -> 00."),
    "spec_text": ("ISO 8583 (ASCII): t MTI 0100/0200/0400; 2 card number; 3 processing code; 4 amount (cents, 12); 7 transmission "
                  "date-time MMDDhhmmss; 11 STAN; 14 expiry YYMM; 18 MCC; 22 entry mode; 37 retrieval ref (original STAN for "
                  "0400); 39 response code; 41 terminal id; 48 private data PIN/GLITCH; 49 currency 840."),
}


def wait(c: TestClient, rid: str, cond, what: str, timeout: float = 90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        run = c.get(f"/api/runs/{rid}").json()
        if cond(run):
            return run
        errs = [e for e in c.get(f"/api/runs/{rid}/events").json() if e["kind"] == "error"]
        if errs:
            raise SystemExit(f"error while waiting for {what}: {errs[-1]['message']}")
        time.sleep(0.2)
    raise SystemExit(f"timed out waiting for {what}")


def main(replay: int = 500) -> dict:
    t0 = time.time()
    with TestClient(app) as c:
        rid = c.post("/api/runs", json=DEMO).json()["id"]
        print("run", rid)
        c.patch(f"/api/runs/{rid}/replay", json={"enabled": replay > 0, "sample_size": max(replay, 1)})
        c.post(f"/api/runs/{rid}/generate")
        run = wait(c, rid, lambda r: r["status"] == "awaiting_approval", "awaiting_approval")
        print(f"{len(run['cases'])} proposed tests")
        assert c.post(f"/api/runs/{rid}/execute").status_code == 409, "execute must be refused before approval"
        print("approved", c.post(f"/api/runs/{rid}/approve_all").json())
        c.post(f"/api/runs/{rid}/execute").raise_for_status()
        run = wait(c, rid, lambda r: r["status"] == "awaiting_decision", "awaiting_decision")
        print("counts", run["counts"], "sandboxes", run["sandboxes_used"])
        print("--- triage summary ---\n" + (run["triage"] or {}).get("summary_md", "(no triage)"))
        c.post(f"/api/runs/{rid}/decision", json={"decision": "block", "reviewer": "Roshni", "note": "Duplicate charges."}).raise_for_status()
        run = wait(c, rid, lambda r: r["github"].get("status_state") in ("failure", "success")
                   and any(e["kind"] == "tool_result" and e["tool"] == "finish" for e in c.get(f"/api/runs/{rid}/events").json()),
                   "decision published")
        evs = c.get(f"/api/runs/{rid}/events").json()
        msgs = [e for e in evs if e["kind"] == "message"]
        print(f"--- conversation ({len(msgs)} messages) ---")
        for e in msgs:
            print(f"  #{e['loop_iter'] or '-'} {e['agent']} -> {e['to_agent']}: {e['message']}")
        print("final status:", run["status"], "| gate:", run["github"].get("status_state"), f"| {time.time() - t0:.1f} s")
        return run


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    n = int(sys.argv[sys.argv.index("--replay") + 1]) if "--replay" in sys.argv else 500
    main(n)
