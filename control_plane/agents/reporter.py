"""Reporter: GitHub issue + commit status (release gate), optional Discord alert. Skips gracefully without tokens."""
from __future__ import annotations
import os

import asyncio
import json

import httpx

from control_plane import db, objstore
from control_plane.events import agent_statuses, emit
from shared.schemas import Run

CONTEXT = "switchproof/migration-gate"


def _gh() -> tuple[str, str, str] | None:
    tok, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPO")
    return (tok, repo, os.environ.get("GITHUB_SHA", "")) if tok and repo else None


async def _post(path: str, body: dict) -> dict:
    tok = os.environ["GITHUB_TOKEN"]
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"https://api.github.com{path}", json=body,
                         headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"})
    if r.status_code >= 300:
        raise RuntimeError(f"GitHub {path} -> {r.status_code}: {r.text[:300]}")
    return r.json()


def export_bundle(run_id: str) -> dict:
    """Run + every non-pass result + 50 sample passes + all events: the evidence bundle / snapshot."""
    res = [x for v in ("regression", "both_wrong", "error", "noise") for x in db.results(run_id, v, 5000)]
    res += db.results(run_id, "pass", 50)
    return {"run": db.get_run(run_id), "results": res, "events": db.events(run_id), "agents": agent_statuses(run_id)}


async def archive_evidence(run_id: str, loop_iter: int | None = None) -> str | None:
    """Immutable-ish audit copy on Vultr Object Storage (overwritten per stage: report, then decision)."""
    if not objstore.configured():
        return None
    try:
        body = json.dumps(export_bundle(run_id), default=lambda o: o.model_dump()).encode()
        url = await asyncio.to_thread(objstore.put, f"runs/{run_id}/evidence.json", body)
        emit(run_id, "reporter", "info", f"Evidence bundle archived to Vultr Object Storage ({len(body) / 1024:,.0f} KB)",
             {"url": url}, loop_iter=loop_iter)
        return url
    except Exception as e:
        emit(run_id, "reporter", "warning", f"Vultr Object Storage upload failed: {str(e)[:300]}", loop_iter=loop_iter)
        return None


def _run_link(run: Run) -> str:
    return f"{os.environ.get('PUBLIC_URL', 'http://localhost:8000').rstrip('/')}/?run={run.id}"


def issue_body(run: Run) -> str:
    t = run.triage
    worst = db.results(run.id, "regression", limit=1)
    rows, hexes = "", ""
    if worst:
        case, res = worst[0]["case"], worst[0]["result"]
        rows = "| Step | Type | Amount | STAN | Expected | Old A | Old B | New |\n|---|---|---|---|---|---|---|---|\n" + "\n".join(
            f"| {s.index + 1} | {s.request_fields.get('t')} | ${int(s.request_fields.get('4', '0')) / 100:,.2f} | "
            f"{s.request_fields.get('11')} | {s.expected_code} | {s.old_a_code} | {s.old_b_code} | {s.new_code} |" for s in res.steps)
        bad = next((s for s in res.steps if s.new_code != s.old_a_code), res.steps[-1])
        hexes = f"Failing request (ISO 8583, hex):\n```\n{bad.request_hex}\n```\nNew switch response:\n```\n{bad.new_response_hex}\n```"
        rows = f"**Case:** {case.title}\n\n{rows}"
    p = run.proofs[-1] if run.proofs else None
    proof = (f"- sandbox `{p.sandbox_id}` runtime `{p.runtime}` host `{p.hostname}`\n- uname `{p.uname}`\n- network `{p.network}`, "
             f"read-only root `{p.readonly_rootfs}`") if p else "n/a"
    return (f"{t.summary_md if t else ''}\n\n**Root cause hypothesis:** {t.root_cause_hypothesis if t else 'n/a'}\n\n"
            f"### Failing steps\n{rows}\n\n{hexes}\n\n### Sandbox proof\n{proof}\n\n"
            f"Counts: {run.counts.model_dump()}\n\n[Open run in SwitchProof]({_run_link(run)})"
            + (f" · [Evidence bundle on Vultr Object Storage]({run.github['evidence_url']})" if run.github.get("evidence_url") else "")
            + "\n\n_Data: IBM TabFormer public synthetic benchmark; the defect is seeded for the demo._")


async def set_status(run: Run, state: str, description: str) -> None:
    gh = _gh()
    if gh and gh[2]:
        await _post(f"/repos/{gh[1]}/statuses/{gh[2]}", {"state": state, "description": description[:140],
                                                         "context": CONTEXT, "target_url": _run_link(run)})


async def file_report(run: Run, loop_iter: int | None = None) -> dict:
    github = dict(run.github)
    if url := await archive_evidence(run.id, loop_iter):
        github["evidence_url"] = url
        run = run.model_copy(update={"github": github})
    n_reg = run.counts.regression
    sev = run.triage.severity.upper() if run.triage else "INFO"
    gh = _gh()
    if not gh:
        github.update(status_state="pending", configured=False)
        emit(run.id, "reporter", "info", "GitHub not configured (GITHUB_TOKEN/GITHUB_REPO unset): release gate held "
             "locally as 'pending', no issue filed.", loop_iter=loop_iter)
    else:
        try:
            if n_reg:
                issue = await _post(f"/repos/{gh[1]}/issues", {
                    "title": f"[SwitchProof] {sev}: new switch approves duplicate payments (run {run.id})"
                    if run.triage and run.triage.affected_rule in ("reject_duplicate", "replay") else
                    f"[SwitchProof] {sev}: regression in {run.triage.affected_rule if run.triage else 'run'} (run {run.id})",
                    "body": issue_body(run)})
                github.update(issue_url=issue["html_url"], issue_number=issue["number"])
                emit(run.id, "reporter", "info", f"Filed GitHub issue #{issue['number']}", {"url": issue["html_url"]}, loop_iter=loop_iter)
            desc = f"Awaiting human decision: {n_reg} regression(s)" if n_reg else "Awaiting human decision: no regressions"
            await set_status(run, "pending", desc)
            github.update(status_state="pending", configured=True, sha=gh[2])
            emit(run.id, "reporter", "info", f"Release gate {CONTEXT} set to pending on {gh[2][:7] or '(no GITHUB_SHA)'}", loop_iter=loop_iter)
        except Exception as e:
            github.update(status_state="pending", error=str(e)[:300])
            emit(run.id, "reporter", "warning", f"GitHub call failed: {str(e)[:300]}", loop_iter=loop_iter)
    hook = os.environ.get("DISCORD_WEBHOOK_URL")
    if hook and n_reg:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(hook, json={"content": f"SwitchProof run {run.id}: {n_reg} regression(s), "
                                         f"{sev}. {run.triage.root_cause_hypothesis if run.triage else ''} Release held. {_run_link(run)}"})
        except httpx.HTTPError as e:
            emit(run.id, "reporter", "warning", f"Discord alert failed: {e}", loop_iter=loop_iter)
    return github


async def publish_decision(run: Run, loop_iter: int | None = None) -> dict:
    github = dict(run.github)
    d = run.decision
    state = "failure" if d.decision == "block" else "success"
    desc = f"Migration blocked by {d.reviewer}" if d.decision == "block" else f"Release approved by {d.reviewer}"
    github["status_state"] = state
    if _gh():
        try:
            await set_status(run, state, desc)
            if github.get("issue_number"):
                await _post(f"/repos/{_gh()[1]}/issues/{github['issue_number']}/comments",
                            {"body": f"**{desc}** at {d.ts}.\n\n{d.note}"})
            emit(run.id, "reporter", "info", f"GitHub gate {CONTEXT} -> {state}: {desc}", loop_iter=loop_iter)
        except Exception as e:
            github["error"] = str(e)[:300]
            emit(run.id, "reporter", "warning", f"GitHub update failed: {str(e)[:300]}", loop_iter=loop_iter)
    else:
        emit(run.id, "reporter", "info", f"Release gate -> {state} (local; GitHub not configured): {desc}", loop_iter=loop_iter)
    db.mutate_run(run.id, lambda r: setattr(r, "github", github))       # bundle must contain the final gate state
    if url := await archive_evidence(run.id, loop_iter):
        github["evidence_url"] = url
    return github
