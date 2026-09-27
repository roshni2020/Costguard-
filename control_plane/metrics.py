"""Evaluation metrics for a run: did we catch the defect, how well did the AI do, what did it cost, how did sandboxes behave.
Everything is computed from stored results and events (no extra bookkeeping)."""
from __future__ import annotations
from collections import defaultdict
from datetime import datetime

from control_plane import db, llm

# USD per 1M completion tokens, from Vultr's live /v1/models (llm.prices, filled at startup); fallback for offline tests
FALLBACK_PRICE = {"glm-5.3": 3.0, "deepseek-v4.1-flash": 0.6, "laguna-s-2.1": 0.18}


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _pct(a: int, b: int) -> float | None:
    return round(100 * a / b, 1) if b else None


def _p95(xs: list[int]) -> int | None:
    return sorted(xs)[max(0, int(len(xs) * 0.95) - 1)] if xs else None


def run_metrics(run_id: str) -> dict:
    run = db.get_run(run_id)
    evs = db.events(run_id)
    items = db.results(run_id, limit=100_000)

    # --- detection: did the seeded defect get caught, how fast, and was the boundary isolated
    exec_start = next((e.ts for e in evs if e.agent == "human" and e.kind == "message" and "Run them" in e.message), None)
    first_find = next((e for e in evs if e.kind == "finding"), None)
    boundary = next((e.message.removeprefix("Boundary found: ") for e in evs if e.kind == "finding" and e.message.startswith("Boundary")), None)
    detection = {
        "defect_caught": run.counts.regression > 0,
        "seconds_to_first_finding": round((_ts(first_find.ts) - _ts(exec_start)).total_seconds(), 1) if first_find and exec_start else None,
        "boundary": boundary,
        "severity": run.triage.severity if run.triage else None,
        "root_cause": run.triage.root_cause_hypothesis if run.triage else None,
        "money_at_risk_cents": run.triage.money_at_risk_cents if run.triage else 0,
        "decision": run.decision.decision if run.decision else None,
    }

    # --- coverage: verdicts per rule (dataset replay shows as rule "replay")
    per_rule: dict[str, dict] = defaultdict(lambda: {"cases": 0, "pass": 0, "regression": 0, "both_wrong": 0, "error": 0, "noise": 0})
    by_source: dict[str, int] = defaultdict(int)
    for it in items:
        c, r = it["case"], it["result"]
        row = per_rule[c.rule]
        row["cases"] += 1
        row[r.verdict] += 1
        by_source[c.source] += 1
    coverage = {"rules_planned": len(run.plan), "rules_with_cases": sum(1 for p in run.plan if per_rule.get(p["rule"], {}).get("cases")),
                "per_rule": dict(per_rule), "cases_by_source": dict(by_source)}

    # --- AI test quality: what the model proposed vs what survived validation and review
    llm_cases = [c for c in run.cases if c.source == "llm"]
    ai_items = [it for it in items if it["case"].source == "llm"]
    gen_warnings = [e for e in evs if e.agent == "generator" and e.kind == "warning"]
    ai_quality = {
        "proposed": len(llm_cases),
        "rejected_by_validator": sum(e.message.startswith("Rejected") for e in gen_warnings),
        "repaired_by_validator": sum(e.message.startswith("Repaired") for e in gen_warnings),
        "rejected_by_human": sum(c.status == "rejected" for c in llm_cases),
        "executed": len(ai_items),
        "expectation_correct_pct": _pct(sum(it["result"].verdict != "both_wrong" for it in ai_items), len(ai_items)),
        "both_wrong": sum(it["result"].verdict == "both_wrong" for it in ai_items),
        "followups_designed_by_triage": sum(c.source == "triage" for c in run.cases),
    }

    # --- agents: calls, tokens, latency, estimated cost per model
    prices = {**FALLBACK_PRICE, **getattr(llm, "prices", {})}
    per_agent: dict[str, dict] = {}
    for e in (e for e in evs if e.kind == "llm_call"):
        a = per_agent.setdefault(e.agent, {"model": e.model, "calls": 0, "tokens_in": 0, "tokens_out": 0, "latencies_ms": []})
        a["calls"] += 1
        a["tokens_in"] += e.tokens_in or 0
        a["tokens_out"] += e.tokens_out or 0
        a["latencies_ms"].append(e.latency_ms or 0)
    for a in per_agent.values():
        lat = a.pop("latencies_ms")
        a["avg_latency_ms"] = int(sum(lat) / len(lat)) if lat else None
        a["p95_latency_ms"] = _p95(lat)
        a["cost_usd"] = round(a["tokens_out"] * prices.get(a["model"], 0) / 1e6, 4)
    agents = {"per_agent": per_agent, "llm_calls": sum(a["calls"] for a in per_agent.values()),
              "tokens": sum(a["tokens_in"] + a["tokens_out"] for a in per_agent.values()),
              "cost_usd": round(sum(a["cost_usd"] for a in per_agent.values()), 4),
              "loop_iterations": max((e.loop_iter or 0 for e in evs), default=0),
              "agent_messages": sum(e.kind == "message" for e in evs)}

    # --- sandboxes: how many, which pool, runtime, all destroyed?
    pools: dict[str, int] = defaultdict(int)
    for p in run.proofs:
        pools["data" if p.sandbox_id.startswith("sp-data-") else "agent"] += 1
    durations = [it["result"].duration_ms for it in items]
    sandboxes = {"count": run.sandboxes_used, "by_pool": dict(pools),
                 "gvisor": sum(p.runtime == "runsc" for p in run.proofs), "not_gvisor": sum(p.runtime != "runsc" for p in run.proofs),
                 "destroyed_all": all("destroyed=True" in e.message for e in evs if e.agent == "executor" and "destroyed=" in e.message),
                 "case_ms_avg": round(sum(durations) / len(durations), 1) if durations else None}

    wall = (_ts(evs[-1].ts) - _ts(evs[0].ts)).total_seconds() if len(evs) > 1 else 0
    return {"run_id": run_id, "title": run.title, "status": run.status, "counts": run.counts.model_dump(),
            "pass_rate_pct": _pct(run.counts.passed, run.counts.total), "wall_seconds": round(wall, 1),
            "tests_per_second": round(run.counts.total / wall, 1) if wall else None,
            "detection": detection, "coverage": coverage, "ai_quality": ai_quality, "agents": agents, "sandboxes": sandboxes}


def all_runs() -> list[dict]:
    """One comparison row per run (newest first)."""
    out = []
    for r in db.list_runs():
        m = run_metrics(r.id)
        out.append({"run_id": r.id, "title": r.title, "created_at": r.created_at, "status": r.status,
                    "tests": m["counts"]["total"], "regressions": m["counts"]["regression"], "errors": m["counts"]["error"],
                    "defect_caught": m["detection"]["defect_caught"], "seconds_to_first_finding": m["detection"]["seconds_to_first_finding"],
                    "ai_tests": m["ai_quality"]["proposed"], "expectation_correct_pct": m["ai_quality"]["expectation_correct_pct"],
                    "llm_calls": m["agents"]["llm_calls"], "tokens": m["agents"]["tokens"], "cost_usd": m["agents"]["cost_usd"],
                    "sandboxes": m["sandboxes"]["count"], "wall_seconds": m["wall_seconds"],
                    "models": sorted({a["model"] for a in m["agents"]["per_agent"].values() if a["model"]})})
    return out
