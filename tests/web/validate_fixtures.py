"""Validate every UI fixture against shared/schemas.py. Run with pytest or `python tests/web/validate_fixtures.py`."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from shared.schemas import AgentStatus, CaseResult, Event, ProbeResult, RLReport, Run, TestCase  # noqa: E402

FIX = ROOT / "docs" / "fixtures"
MOCK = ROOT / "web" / "mock"
RUNS = ["run_awaiting_approval.json", "run_running.json", "run_awaiting_decision.json"]


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def check_results(items):
    for it in items:
        TestCase(**it["case"])
        CaseResult(**it["result"])


def test_runs():
    for name in RUNS:
        Run(**load(name))
    aw = Run(**load("run_awaiting_decision.json"))
    assert (aw.counts.total, aw.counts.passed, aw.counts.regression, aw.counts.error) == (2012, 1968, 41, 3)
    assert aw.sandboxes_used == 8 and aw.triage and aw.github["status_state"] == "pending"
    assert all(p.runtime == "runsc" for p in aw.proofs)
    ap = Run(**load("run_awaiting_approval.json"))
    assert len(ap.cases) == 10 and all(c.status == "proposed" for c in ap.cases)


def test_results():
    items = load("results_regression.json")
    check_results(items)
    demo = next(i for i in items if i["case"]["id"] == "case_dup_250")["result"]
    s2 = demo["steps"][1]
    assert (s2["expected_code"], s2["old_a_code"], s2["old_b_code"], s2["new_code"]) == ("94", "94", "94", "00")
    gaps = sorted(i["case"]["steps"][1]["at_offset_s"] for i in items if i["case"]["source"] == "triage")
    assert gaps == [0, 0.5, 1, 2, 5, 30, 59, 61]


def test_events_agents_misc():
    for name in ("events.json", "events_conversation.json"):
        for e in load(name):
            Event(**e)
    for a in load("agents.json"):
        AgentStatus(**a)
    probe = ProbeResult(**load("probe.json"))
    assert sum(c.outcome == "BLOCKED" for c in probe.checks) >= 5
    RLReport(**load("rl_report.json"))
    system = load("system.json")
    assert {"control_plane", "sandbox_host", "llm"} <= system.keys()


def test_export():
    ex = load("export.json")
    Run(**ex["run"])
    check_results(ex["results"])
    for e in ex["events"]:
        Event(**e)


def test_mock_copies_identical():
    for f in FIX.glob("*.json"):
        assert (MOCK / f.name).read_bytes() == f.read_bytes(), f.name


def test_no_pan_word_in_ui():
    # UI must say "card number", never the acronym (field names in fixture JSON are fine).
    for f in ("index.html", "app.js"):
        p = ROOT / "web" / f
        if p.exists():
            assert ">PAN" not in p.read_text(encoding="utf-8") and " PAN " not in p.read_text(encoding="utf-8")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
