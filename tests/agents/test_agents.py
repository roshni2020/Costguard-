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


def test_evidence_archived_to_vultr_object_storage(monkeypatch):
    import httpx
    from control_plane import objstore
    for k, v in {"VULTR_S3_ENDPOINT": "https://ewr1.vultrobjects.com", "VULTR_S3_ACCESS_KEY": "AK",
                 "VULTR_S3_SECRET_KEY": "SK", "VULTR_S3_BUCKET": "switchproof"}.items():
        monkeypatch.setenv(k, v)
    puts = []

    def fake_request(method, url, headers=None, content=b"", timeout=None):
        puts.append((method, url, headers))
        return httpx.Response(200)
    monkeypatch.setattr(objstore.httpx, "request", fake_request)
    run = demo_main(replay=0)
    assert run["github"]["evidence_url"] == f"https://ewr1.vultrobjects.com/switchproof/runs/{run['id']}/evidence.json"
    assert len(puts) == 2 and all(h["x-amz-acl"] == "public-read" and h["authorization"].startswith("AWS4-HMAC-SHA256") for _, _, h in puts)
    url = objstore.publish_site({"run": {}}, prefix="site-test")
    assert url.endswith("/switchproof/site-test/index.html?snapshot=export.json")
    assert any(u.endswith("/site-test/app.js") and h["content-type"].startswith("text/javascript") for _, u, h in puts)
    assert not any("/mock/" in u for _, u, _ in puts)


def test_netbird_roles_gate_mutations(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "netbird")
    tester = {"X-NetBird-User": "roshni@example.com", "X-NetBird-Groups": "All,testers"}
    viewer = {"X-NetBird-Groups": "All"}                       # PIN user: no tester group
    with TestClient(app) as c:
        assert c.get("/api/me", headers=viewer).json() == {"auth": "netbird", "user": None, "groups": ["All"], "role": "viewer", "can_act": False}
        r = c.post("/api/runs", json=DEMO, headers=viewer)
        assert r.status_code == 403 and "read-only" in r.json()["detail"]
        rid = c.post("/api/runs", json=DEMO, headers=tester).json()["id"]
        assert c.get(f"/api/runs/{rid}", headers=viewer).status_code == 200          # viewers can still read
        assert c.post(f"/api/runs/{rid}/share", headers=tester).status_code == 409   # only while awaiting decision
        assert c.get(f"/api/runs/{rid}/share", headers=viewer).json() == {"active": False}
        db.mutate_run(rid, lambda r: setattr(r, "status", "awaiting_decision"))
        d = c.post(f"/api/runs/{rid}/decision", json={"decision": "block", "reviewer": "someone else", "note": "dup"}, headers=tester).json()
        assert d["decision"]["reviewer"] == "roshni@example.com" and "NetBird SSO" in d["decision"]["note"]
        assert c.get("/api/system").json()["netbird"]["available"] in (True, False)


def test_netbird_status_parsing(monkeypatch):
    from control_plane import netbird
    fake = {"daemonStatus": "Connected", "management": {"connected": True},
            "netbirdIp": "100.92.1.2/16", "fqdn": "sp-control.netbird.cloud", "peers": {"details": [
        {"fqdn": "sp-sandbox.netbird.cloud", "netbirdIp": "100.92.1.3", "status": "Connected", "connectionType": "P2P", "latency": 1234567}]}}
    monkeypatch.setattr(netbird, "_raw_status", lambda: fake)
    monkeypatch.setattr(netbird, "_cache", (0.0, {}))
    monkeypatch.setenv("SANDBOX_HOST_URL", "http://100.92.1.3:9000")
    s = netbird.status()
    assert s["ip"] == "100.92.1.2" and s["sandbox_via_netbird"] is True
    assert s["peers"][0] == {"fqdn": "sp-sandbox.netbird.cloud", "ip": "100.92.1.3", "status": "Connected", "connection_type": "P2P", "latency_ms": 1.23}
    assert netbird._ms("850µs") == 0.85 and netbird._ms("2.5ms") == 2.5
    monkeypatch.setattr(netbird, "_raw_status", lambda: {"daemonStatus": "NeedsLogin", "management": {"connected": False}})
    monkeypatch.setattr(netbird, "_cache", (0.0, {}))
    assert netbird.status()["available"] is False, "installed-but-not-logged-in must not count as NetBird"


def test_kubernetes_backend_job_lifecycle(monkeypatch, tmp_path):
    """Fake Kubernetes API whose 'pod' really runs the runner; checks hardening, logs parsing and teardown."""
    import json as _json
    import os
    import subprocess
    import sys
    import httpx
    from control_plane import k8s, sandbox_client
    from shared.schemas import BatchRequest
    monkeypatch.setenv("SANDBOX_BACKEND", "k8s")
    monkeypatch.setenv("K8S_API", "https://vke.example:6443")
    monkeypatch.setenv("K8S_TOKEN", "t")
    state = {"cm": {}, "jobs": {}, "calls": []}

    def handler(req: httpx.Request) -> httpx.Response:
        p, m = req.url.path, req.method
        state["calls"].append((m, p))
        assert req.headers["authorization"] == "Bearer t"
        if m == "POST" and p.endswith("/configmaps"):
            body = _json.loads(req.content); state["cm"][body["metadata"]["name"]] = body["data"]["input.json"]
            return httpx.Response(201, json=body)
        if m == "POST" and p.endswith("/jobs"):
            job = _json.loads(req.content); state["jobs"][job["metadata"]["name"]] = job
            return httpx.Response(201, json=job)
        if m == "GET" and "/jobs/" in p:
            return httpx.Response(200, json={"status": {"succeeded": 1}})
        if m == "GET" and p.endswith("/pods"):
            sel = req.url.params["labelSelector"].split("=", 1)[1]
            return httpx.Response(200, json={"items": [{"metadata": {"name": sel + "-pod"}}] if sel in state["jobs"] else []})
        if m == "GET" and p.endswith("/log"):
            name = p.split("/pods/")[1][:-len("-pod/log")]
            f = tmp_path / "input.json"; f.write_text(state["cm"][name])
            ctr = state["jobs"][name]["spec"]["template"]["spec"]["containers"][0]
            env = {**os.environ, **{e["name"]: e["value"] for e in ctr["env"]}}
            env.pop("SANDBOX_RUNTIME", None)
            out = subprocess.run([sys.executable, *ctr["command"][1:-1], str(f)], capture_output=True, text=True, env=env).stdout
            return httpx.Response(200, text="INFO:switchcore some log line\n" + out, headers={"content-type": "text/plain"})
        if m == "DELETE":
            state["jobs"].pop(p.rsplit("/", 1)[1], None); state["cm"].pop(p.rsplit("/", 1)[1], None)
            return httpx.Response(200, json={})
        return httpx.Response(404, json={})
    monkeypatch.setattr(k8s, "_transport", httpx.MockTransport(handler))
    req = BatchRequest(batch_id="b1", run_id="r", cases=[demo_duplicate_case("r")])
    res = asyncio.run(sandbox_client.run_batch(req))
    assert res.results[0].verdict == "regression" and res.destroyed is True
    job = next(iter([c for c in state["calls"] if c[1].endswith("/jobs")]))
    assert not state["jobs"] and not state["cm"], "job and configmap must be deleted"
    spec = k8s.job_manifest("sp-x", ["-m", "switchcore.runner"], 60)["spec"]["template"]["spec"]
    c0 = spec["containers"][0]["securityContext"]
    assert spec["runtimeClassName"] == "gvisor" and spec["automountServiceAccountToken"] is False
    assert c0["readOnlyRootFilesystem"] and c0["capabilities"]["drop"] == ["ALL"] and not c0["allowPrivilegeEscalation"]
    assert res.proof.runtime == "local-unsafe", "not really gVisor here, so the proof must not claim runsc"


def test_agent_and_data_sandboxes_are_separate(monkeypatch):
    import pytest
    from control_plane import k8s
    from control_plane.agents import executor
    from switchcore.dataset import load_replay_cases
    from switchcore.engine import _run_check_script
    from shared.schemas import CaseResult
    # the data pool refuses anything that is not a dataset replay row
    with pytest.raises(ValueError):
        asyncio.run(executor.execute("run-t", [demo_duplicate_case("run-t")], pool="data"))
    # each pool gets its own namespace and, when configured, its own node pool (= separate Vultr VMs)
    monkeypatch.setenv("K8S_NODEPOOL_DATA", "data-pool")
    data = k8s.job_manifest("sp-data-1", ["-m", "switchcore.runner"], 60, "data")
    agent = k8s.job_manifest("sp-agent-1", ["-m", "switchcore.runner"], 60, "agent")
    assert data["spec"]["template"]["spec"]["nodeSelector"] == {"vke.vultr.com/node-pool": "data-pool"}
    assert "nodeSelector" not in agent["spec"]["template"]["spec"]
    assert k8s.ns("data") == "switchproof-data" and k8s.ns("agent") == "switchproof-agent"
    env = {e["name"]: e["value"] for e in data["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["SANDBOX_POOL"] == "data"
    # inside a data sandbox, agent-written code is refused even if it slipped through
    monkeypatch.setenv("SWITCHPROOF_IN_SANDBOX", "1")
    monkeypatch.setenv("SANDBOX_POOL", "data")
    empty = CaseResult(case_id="x", verdict="pass", steps=[], balance_delta_cents={}, duration_ms=0)
    assert _run_check_script("print('pwned')", empty).startswith("refused")


def test_coordinator_survives_a_model_that_keeps_replanning(monkeypatch):
    """Seen live on Vultr: the model chose plan_rules every turn. Finished steps must not be valid choices."""
    monkeypatch.setenv("LLM_OFFLINE", "0")
    from control_plane import llm as _llm
    from control_plane.agents import planner as _planner, generator as _generator

    async def stubborn_chat(run_id, agent, messages, **kw):
        return {"content": "", "tool_calls": [{"id": "1", "function": {"name": "plan_rules", "arguments": "{}"}}]}

    async def offline_plan(run, loop_iter=None):
        return [p.model_dump() for p in _planner.offline_plan(run.requirements)]

    async def offline_generate(run, loop_iter=None):
        return _generator.validate_cases(run, [g for p in run.plan for g in _generator.offline_templates(p["rule"])])
    monkeypatch.setattr(_llm, "chat", stubborn_chat)
    monkeypatch.setattr(_planner, "plan", offline_plan)
    monkeypatch.setattr(_generator, "generate", offline_generate)
    run = db.save_run(Run(id="run-stubborn", title="t", status="planning", created_at="2026-09-27T12:00:00Z", requirements=DEMO["requirements"]))
    asyncio.run(coordinator.loop(run.id))
    after = db.get_run(run.id)
    assert after.status == "awaiting_approval" and after.cases, "must reach the human gate despite the stubborn model"
    assert sum(e.kind == "tool_call" and e.tool == "plan_rules" for e in db.events(run.id)) == 1


def test_kubernetes_output_chunks_survive_log_line_limits():
    from control_plane.k8s import parse_output
    big = '{"x": "' + "a" * 100_000 + '"}'
    log = "INFO:x\n" + "\n".join("SPCHUNK " + big[i:i + 32_000] for i in range(0, len(big), 32_000)) + "\nSPEND\n"
    assert parse_output(log) == big
    assert parse_output("SPCHUNK {\"a\"") is None, "incomplete output must not be parsed"
    assert parse_output('noise\n{"ok": 1}\n') == '{"ok": 1}'


def test_metrics_endpoint_after_a_full_run():
    run = demo_main(replay=100)
    with TestClient(app) as c:
        m = c.get(f"/api/runs/{run['id']}/metrics").json()
        rows = c.get("/api/metrics").json()
    assert m["detection"]["defect_caught"] is True and "1 s or more" in m["detection"]["boundary"]
    assert m["coverage"]["rules_with_cases"] == m["coverage"]["rules_planned"] == 4
    assert m["ai_quality"]["proposed"] == 12 and m["ai_quality"]["expectation_correct_pct"] == 100.0
    assert m["sandboxes"]["count"] >= 2 and m["counts"]["total"] == sum(r["cases"] for r in m["coverage"]["per_rule"].values())
    assert any(r["run_id"] == run["id"] for r in rows)
