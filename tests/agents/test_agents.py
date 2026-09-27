import asyncio

from fastapi.testclient import TestClient

from control_plane import db, llm
from control_plane.agents import coordinator, generator, triage
from control_plane.app import app
from control_plane.demo_flow import DEMO, main as demo_main
from shared.schemas import Account, Bounds, Run, Step
from switchcore.demo import demo_duplicate_case

PAN = "4111111111111111"


def run_obj(**kw):
    return Run(id="run-t", title="t", status="planning", created_at="2026-09-27T12:00:00Z", requirements=["x"], **kw)


def gen(title, steps, codes, pan=PAN):
    return generator.GenCase(title=title, rule="approve_purchase", accounts=[Account(pan=pan, balance_cents=100000)],
                             steps=steps, expected_codes=codes, expected_balance_delta_cents={pan: -100})


def test_validation_layer_repairs_and_rejects():
    s = lambda **kw: Step(**{"mti": "0200", "pan": PAN, "amount_cents": 100, "stan": "000001", **kw})
    raw = [
        gen("bad luhn", [s(pan="4111111111111112")], ["00"], pan="4111111111111112"),   # repaired
        gen("short stan", [s(stan="12")], ["00"]),                                        # repaired
        gen("too big", [s(amount_cents=500_000)], ["00"]),                                # rejected: bounds
        gen("mismatch", [s(), s(stan="000002")], ["00"]),                                 # rejected: len
        gen("bad mti", [s(mti="0100")], ["00"]),                                          # rejected: allowed_mti
    ]
    out = generator.validate_cases(run_obj(bounds=Bounds(allowed_mti=["0200", "0400"])), raw)
    assert [c.title for c in out] == ["bad luhn", "short stan"]
    assert out[0].steps[0].pan == out[0].accounts[0].pan == PAN and PAN in out[0].expected_balance_delta_cents
    assert out[1].steps[0].stan == "000012"
    assert all(c.status == "proposed" and c.source == "llm" for c in out)


def test_malformed_llm_reply_is_reprompted(monkeypatch):
    replies = iter(["Sure! ```json\n{\"plan\": [{\"rule\": \"not_a_rule\"}]}\n```",
                    "```json\n{\"plan\": [{\"rule\": \"reject_duplicate\", \"description\": \"d\", \"states\": [\"s\"]}]}\n```"])

    async def fake_chat(run_id, agent, messages, **kw):
        return {"content": next(replies)}
    monkeypatch.setattr(llm, "chat", fake_chat)
    from control_plane.agents.planner import PlanOut
    out = asyncio.run(llm.complete_json("run-t", "planner", "sys", "user", PlanOut))
    assert out.plan[0].rule == "reject_duplicate"


def test_extract_json_handles_fences_and_prose():
    assert llm.extract_json('Here you go:\n```json\n{"a": [1, 2]}\n``` hope it helps') == {"a": [1, 2]}


def test_coordinator_falls_back_after_two_invalid_tools(monkeypatch):
    monkeypatch.setenv("LLM_OFFLINE", "0")

    async def bad_chat(run_id, agent, messages, **kw):
        return {"content": "", "tool_calls": [{"id": "1", "function": {"name": "execute_tests", "arguments": "{}"}}]}
    monkeypatch.setattr(llm, "chat", bad_chat)
    run = db.save_run(run_obj())
    tool, _ = asyncio.run(coordinator.decide(run, {}, 1))
    assert tool == "plan_rules"            # execute_tests is refused while planning
    assert any(e.kind == "warning" and "fall" in e.message for e in db.events(run.id))


def test_execute_refused_while_cases_proposed():
    with TestClient(app) as c:
        rid = c.post("/api/runs", json=DEMO).json()["id"]
        assert c.post(f"/api/runs/{rid}/execute").status_code == 409          # wrong state
        c.post(f"/api/runs/{rid}/generate")
        for _ in range(100):
            if c.get(f"/api/runs/{rid}").json()["status"] == "awaiting_approval":
                break
            asyncio.run(asyncio.sleep(0.05))
        run = c.get(f"/api/runs/{rid}").json()
        assert run["status"] == "awaiting_approval" and all(k["status"] == "proposed" for k in run["cases"])
        r = c.post(f"/api/runs/{rid}/execute")
        assert r.status_code == 409 and "awaiting approval" in r.json()["detail"]
        states = {a["name"]: a["state"] for a in c.get(f"/api/runs/{rid}/agents").json()}
        assert states["coordinator"] == "waiting_human"
        case_id = run["cases"][0]["id"]
        assert c.patch(f"/api/runs/{rid}/cases/{case_id}", json={"status": "rejected"}).json()["status"] == "rejected"
        assert c.post(f"/api/runs/{rid}/approve_all").json()["approved"] == len(run["cases"]) - 1


def test_followups_stay_inside_bounds():
    parent = demo_duplicate_case("run-t")
    fu = triage.build_followups(run_obj(), parent, 1, None)
    assert len(fu) == 9 and all(c.status == "approved" and c.source == "triage" and c.parent_case_id == parent.id for c in fu)
    gaps = {c.steps[1].at_offset_s: c.expected_codes for c in fu if c.steps[1].amount_cents == 25000}
    assert gaps[5.0] == ["00", "94"] and gaps[61.0] == ["00", "00"]
    assert triage.build_followups(run_obj(bounds=Bounds(max_amount_cents=10000)), parent, 1, None) == []


def test_full_offline_flow_blocks_with_conversation():
    run = demo_main(replay=100)
    assert run["status"] == "blocked" and run["github"]["status_state"] == "failure"
    assert run["counts"]["regression"] >= 1 and run["triage"]["severity"] == "critical"
    assert "1 s or more" in run["triage"]["summary_md"]
    evs = db.events(run["id"])
    assert sum(e.kind == "message" for e in evs) >= 25
    assert any(e.kind == "finding" for e in evs)
    assert max(e.loop_iter or 0 for e in evs) <= 2 * coordinator.MAX_ITERS


def test_rl_experiment_smoke():
    from rl.experiment import main
    out = main({"train_episodes": 20, "eval_seeds": 3, "budget": 20})
    assert len(out["curves"]["learned"]) == 20 and "dup_window_units" not in out["trained_on_bugs"]
    assert set(out["first_find"]) >= {"learned", "random"}
