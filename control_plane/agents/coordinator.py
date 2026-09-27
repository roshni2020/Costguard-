"""Coordinator: a tool-calling loop on Vultr Serverless Inference. observe -> decide -> act -> record, repeat.

Guardrails live HERE in code, not in the prompt:
  * max 12 iterations per segment (a segment runs between two human gates)
  * only tools valid for the current state are accepted; an invalid choice goes back to the model as a tool error,
    after 2 invalid choices we take the deterministic next step and emit a warning
  * request_human_approval / request_human_decision pause the loop; /execute and /decision resume it
  * execute_tests is refused while any case is still `proposed`
  * triage follow-ups are auto-approved only inside run.bounds (see triage.build_followups)
"""
from __future__ import annotations
import asyncio
import json
import logging

from control_plane import db, llm
from control_plane.agents import executor, generator, planner, reporter, triage
from control_plane.events import emit, say, set_state
from shared.schemas import Run
from switchcore.dataset import load_replay_cases

log = logging.getLogger("switchproof.coordinator")
MAX_ITERS = 12
TERMINAL = ("blocked", "approved_for_release")
TOOLS = {
    "plan_rules": ("planner", "Ask the Planner to turn the requirements into a rule-by-rule test plan."),
    "generate_tests": ("generator", "Ask the Test Generator to write concrete test cases for the plan."),
    "request_human_approval": ("human", "Hand the proposed tests to the human tester for review. Pauses the loop."),
    "execute_tests": ("executor", "Run every approved test that has no result yet in gVisor sandboxes (plus the replay pack the first time)."),
    "generate_followups": ("triage", "Ask Triage to design follow-up tests (inside the human's bounds) that isolate the regression's cause."),
    "triage_findings": ("triage", "Ask Triage to write the final regression report from all evidence."),
    "file_report": ("reporter", "Ask the Reporter to file the GitHub issue / set the release gate (or publish the human decision to it)."),
    "request_human_decision": ("human", "Ask the human to block or approve the release. Pauses the loop."),
    "finish": ("human", "End the run after the decision has been published."),
}
SYSTEM = """You are the Coordinator agent of SwitchProof, which tests a bank's new payment switch against the legacy one
before go-live. You run a loop: each turn you receive the run state as JSON and call exactly ONE tool to hand work to
the right agent. Workflow: plan -> generate tests -> human approves -> execute in sandboxes -> if regressions: follow-ups
(up to 3 rounds, until the boundary is found) -> triage report -> file report -> human decides -> publish decision -> finish.
Rules enforced by the platform: tests never run before human approval; follow-ups must stay inside the human's bounds;
you cannot decide for the human. In the tool's `instruction` write one short sentence to the agent (US English, USD)."""

_tasks: set[asyncio.Task] = set()


def pending_cases(run: Run):
    done = db.result_ids(run.id)
    return [c for c in run.cases if c.status == "approved" and c.id not in done]


def options(run: Run, meta: dict) -> list[str]:
    """Tools valid right now; the first one is the deterministic (offline/fallback) choice."""
    s = run.status
    if s == "planning":
        if not run.plan:
            return ["plan_rules"]
        if not run.cases:
            return ["generate_tests", "plan_rules"]
        return ["request_human_approval", "generate_tests"]
    if s in ("running", "triaging"):
        if not meta.get("executed") or pending_cases(run):
            return ["execute_tests"]
        if run.counts.regression and run.triage is None:
            more = (run.bounds.auto_followups and meta.get("rounds", 0) < 3 and not meta.get("boundary")
                    and not meta.get("rounds_empty"))
            return (["generate_followups"] if more else []) + ["triage_findings"]
        if not meta.get("reported"):
            return ["file_report"]
        return ["request_human_decision"]
    if s in TERMINAL:
        return ["finish"] if meta.get("gate_final") else ["file_report"]
    return []


def observe(run: Run, meta: dict) -> dict:
    return {"status": run.status, "requirements": len(run.requirements), "planned_rules": [p["rule"] for p in run.plan],
            "cases": {k: sum(c.status == k for c in run.cases) for k in ("proposed", "approved", "rejected")},
            "pending_execution": len(pending_cases(run)), "counts": run.counts.model_dump(),
            "replay": run.replay.model_dump(), "bounds": run.bounds.model_dump(),
            "followup_rounds": meta.get("rounds", 0), "boundary": meta.get("boundary"),
            "triage_report": bool(run.triage), "report_filed": bool(meta.get("reported")),
            "decision": run.decision.decision if run.decision else None, "gate_published": bool(meta.get("gate_final")),
            "iterations_left_in_segment": MAX_ITERS - meta.get("seg_iters", 0)}


def template(tool: str, run: Run, meta: dict) -> str:
    mx = f"${run.bounds.max_amount_cents / 100:,.0f}"
    n_app = sum(c.status == "approved" for c in run.cases)
    return {
        "plan_rules": f"Plan tests for these {len(run.requirements)} requirements.",
        "generate_tests": f"Write tests for {len(run.plan)} rules, max {mx}.",
        "request_human_approval": f"{len(run.cases)} tests are ready for your review. Nothing runs until you approve or reject every one.",
        "execute_tests": (f"Run the {n_app} approved tests" + (f" plus {run.replay.sample_size:,} TabFormer replay transactions"
                          if run.replay.enabled else "") + " in gVisor sandboxes.") if not meta.get("executed")
        else f"Run the {len(pending_cases(run))} follow-up tests in a fresh sandbox.",
        "generate_followups": f"{run.counts.regression} regressions. Find the boundary with follow-ups inside the bounds (max {mx}).",
        "triage_findings": "Write the triage report with the evidence table and money at risk.",
        "file_report": "Publish the human decision to the release gate." if run.status in TERMINAL
        else "File the GitHub issue and hold the release gate.",
        "request_human_decision": (f"Triage is done: {run.triage.severity} - {run.triage.root_cause_hypothesis} Please block or approve."
                                   if run.triage else f"{run.counts.total:,} tests ran, no regressions. Please block or approve."),
        "finish": (f"Run complete: {'migration blocked' if run.decision.decision == 'block' else 'release approved'} by "
                   f"{run.decision.reviewer}; release gate {run.github.get('status_state')}.") if run.decision else "Run complete.",
    }[tool]


def _tool_defs() -> list[dict]:
    return [{"type": "function", "function": {"name": n, "description": d, "parameters": {
        "type": "object", "properties": {"instruction": {"type": "string", "description": "One sentence for the agent."}}}}}
        for n, (_, d) in TOOLS.items()]


async def decide(run: Run, meta: dict, it: int) -> tuple[str, str]:
    opts = options(run, meta)
    if llm.offline():
        return opts[0], template(opts[0], run, meta)
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": "Run state:\n" + json.dumps(observe(run, meta))}]
    invalid = 0
    while invalid < 2:
        try:
            msg = await llm.chat(run.id, "coordinator", messages, tools=_tool_defs(), loop_iter=it)
        except Exception as e:
            emit(run.id, "coordinator", "warning", f"Vultr inference call failed ({str(e)[:200]}); taking the deterministic next step",
                 loop_iter=it)
            return opts[0], template(opts[0], run, meta)
        calls = msg.get("tool_calls") or []
        if not calls:
            invalid += 1
            messages += [{"role": "assistant", "content": msg.get("content") or ""},
                         {"role": "user", "content": "You must call exactly one tool."}]
            continue
        call = calls[0]
        name = call["function"]["name"]
        try:
            instruction = (json.loads(call["function"].get("arguments") or "{}") or {}).get("instruction", "")
        except ValueError:
            instruction = ""
        if name in opts:
            return name, instruction or template(name, run, meta)
        invalid += 1
        err = f"error: '{name}' is not allowed in state '{run.status}'. Valid now: {opts}"
        emit(run.id, "coordinator", "tool_result", err, tool=name, loop_iter=it)
        messages += [{"role": "assistant", "content": msg.get("content") or "", "tool_calls": [call]},
                     {"role": "tool", "tool_call_id": call.get("id", "call"), "content": err}]
    emit(run.id, "coordinator", "warning", f"2 invalid tool choices; falling back to the deterministic next step: {opts[0]}", loop_iter=it)
    return opts[0], template(opts[0], run, meta)


async def act(tool: str, run: Run, meta: dict, it: int) -> tuple[str, bool]:
    """Runs one agent. Returns (result sentence, pause_loop)."""
    rid = run.id
    agent = TOOLS[tool][0]
    if agent != "human":
        set_state(rid, agent, "acting")

    if tool == "plan_rules":
        plan = await planner.plan(run, it)
        db.mutate_run(rid, lambda r: setattr(r, "plan", plan))
        res = f"Plan ready: {len(plan)} rules ({', '.join(p['rule'] for p in plan)})."
        crit = [p["rule"] for p in plan if p.get("risk") == "critical"]
        say(rid, "planner", "generator", f"Plan handed over: {len(plan)} rules" + (f"; {', '.join(crit)} move money and are critical." if crit else "."), it)
    elif tool == "generate_tests":
        cases = await generator.generate(run, it)
        db.save_cases(cases)
        db.mutate_run(rid, lambda r: setattr(r, "cases", [c for c in r.cases if c.source not in ("llm",)] + cases))
        dup = next((c for c in cases if c.rule == "reject_duplicate" and len(c.steps) == 2
                    and c.steps[1].at_offset_s >= 2 and c.steps[1].amount_cents == c.steps[0].amount_cents), None)
        res = f"{len(cases)} tests ready" + (f"; 1 duplicate test with a {dup.steps[1].at_offset_s:g} s retry." if dup else ".")
    elif tool == "request_human_approval":
        db.mutate_run(rid, lambda r: setattr(r, "status", "awaiting_approval"))
        set_state(rid, "coordinator", "waiting_human")
        return "Waiting for the human to approve or reject every test.", True
    elif tool == "execute_tests":
        if any(c.status == "proposed" for c in run.cases):
            return "Refused: some tests are still awaiting human approval.", False
        if not meta.get("executed"):
            approved = [c for c in run.cases if c.status == "approved"]
            await executor.execute(rid, approved, it)
            if run.replay.enabled:
                emit(rid, "executor", "info", f"Loading {run.replay.sample_size:,} replay transactions from IBM TabFormer "
                     "(public synthetic benchmark) - expected codes come from the dataset, not the LLM.", loop_iter=it)
                replay = await asyncio.to_thread(load_replay_cases, rid, run.replay.sample_size)
                await executor.execute(rid, replay, it, pool="data")
            db.set_meta(rid, executed=True)
        else:
            await executor.execute(rid, pending_cases(run), it)
            boundary = triage.find_boundary(rid)
            if boundary:
                db.set_meta(rid, boundary=boundary)
                say(rid, "executor", "triage", "Follow-up results are in.", it)
                emit(rid, "triage", "finding", f"Boundary found: {boundary}", loop_iter=it)
        c = executor.refresh_counts(rid)
        res = f"{c.total:,} tests done: {c.passed:,} passed, {c.regression:,} regressions, {c.error:,} errors."
        if c.regression and not meta.get("executed"):
            res += " Handing regressions to triage."
            say(rid, "executor", "triage", f"{c.regression} regressions for you; evidence is stored per step (codes, balances, raw ISO 8583).", it)
    elif tool == "generate_followups":
        db.mutate_run(rid, lambda r: setattr(r, "status", "triaging"))
        rounds = meta.get("rounds", 0) + 1
        cases = await triage.plan_followups(db.get_run(rid), rounds, it)
        db.set_meta(rid, rounds=rounds, rounds_empty=not cases)
        db.save_cases(cases)
        db.mutate_run(rid, lambda r: r.cases.extend(cases))
        if cases:
            say(rid, "triage", "executor", f"Please run these {len(cases)} follow-ups in one sandbox.", it)
        res = (f"Round {rounds}: {len(cases)} follow-up tests queued, auto-approved inside your bounds." if cases
               else f"Round {rounds}: no further useful variations inside the bounds.")
    elif tool == "triage_findings":
        db.mutate_run(rid, lambda r: setattr(r, "status", "triaging"))
        rep = await triage.report(db.get_run(rid), meta.get("boundary"), it)
        db.mutate_run(rid, lambda r: setattr(r, "triage", rep))
        res = f"{rep.severity.capitalize()}: {rep.root_cause_hypothesis} ${rep.money_at_risk_cents / 100:,.2f} at risk."
        say(rid, "triage", "reporter", f"Report ready for filing: {rep.severity}, affected rule {rep.affected_rule}.", it)
    elif tool == "file_report":
        if run.status in TERMINAL:
            gh = await reporter.publish_decision(run, it)
            db.set_meta(rid, gate_final=True)
            res = f"Release gate is now {gh['status_state']}."
        else:
            gh = await reporter.file_report(db.get_run(rid), it)
            db.set_meta(rid, reported=True)
            res = (f"Issue filed: {gh['issue_url']}. " if gh.get("issue_url") else "") + f"Release gate held: {gh['status_state']}."
            say(rid, "reporter", "human", "The release gate stays on hold (pending) until you decide.", it)
        db.mutate_run(rid, lambda r: setattr(r, "github", gh))
    elif tool == "request_human_decision":
        db.mutate_run(rid, lambda r: setattr(r, "status", "awaiting_decision"))
        set_state(rid, "coordinator", "waiting_human")
        return "Waiting for the human decision.", True
    elif tool == "finish":
        for a in ("coordinator", "planner", "generator", "executor", "triage", "reporter"):
            set_state(rid, a, "done")
        return "Finished.", True
    else:
        raise ValueError(tool)
    if agent != "human":
        set_state(rid, agent, "done")
    return res, False


async def loop(run_id: str) -> None:
    db.set_meta(run_id, seg_iters=0)
    while True:
        run, meta = db.get_run(run_id), db.get_meta(run_id)
        if meta.get("seg_iters", 0) >= MAX_ITERS:
            emit(run_id, "coordinator", "warning", f"Hit the {MAX_ITERS}-iteration limit; handing control to the human.")
            if run.status in ("running", "triaging"):
                db.mutate_run(run_id, lambda r: setattr(r, "status", "awaiting_decision"))
            elif run.status == "planning":
                db.mutate_run(run_id, lambda r: setattr(r, "status", "awaiting_approval" if r.cases else "draft"))
            set_state(run_id, "coordinator", "waiting_human")
            return
        if not options(run, meta):
            return
        it = meta.get("loop_iter", 0) + 1
        meta = db.set_meta(run_id, loop_iter=it, seg_iters=meta.get("seg_iters", 0) + 1)
        set_state(run_id, "coordinator", "thinking")
        tool, instruction = await decide(run, meta, it)
        receiver = TOOLS[tool][0]
        emit(run_id, "coordinator", "tool_call", f"{tool}()", {"observation": observe(run, meta)}, tool=tool, loop_iter=it)
        say(run_id, "coordinator", receiver, instruction, it)
        set_state(run_id, "coordinator", "acting")
        result, pause = await act(tool, db.get_run(run_id), db.get_meta(run_id), it)
        emit(run_id, "coordinator", "tool_result", result, tool=tool, loop_iter=it)
        if receiver != "human":
            say(run_id, receiver, "coordinator", result, it)
        if pause:
            return


def launch(run_id: str) -> asyncio.Task:
    async def guarded():
        try:
            await loop(run_id)
        except Exception as e:
            log.exception("coordinator loop crashed")
            set_state(run_id, "coordinator", "error")
            emit(run_id, "system", "error", f"Coordinator loop failed: {type(e).__name__}: {str(e)[:400]}. "
                 "POST /api/runs/{id}/retry resumes from the current state.")
    t = asyncio.create_task(guarded())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return t
