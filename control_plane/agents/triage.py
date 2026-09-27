"""Triage: group regressions by signature, run bounded follow-ups autonomously, find the boundary, write the report."""
from __future__ import annotations
from typing import Literal

from pydantic import BaseModel, Field

from control_plane import db, llm
from control_plane.events import emit
from shared.schemas import Run, Step, TestCase, TriageReport


def signature(item: dict) -> tuple[str, str, str]:
    case, res = item["case"], item["result"]
    bad = next((s for s in res.steps if s.new_code != s.old_a_code), None)
    old, new = (bad.old_a_code, bad.new_code) if bad else ("same codes", "balance differs")
    return family(case), old, new


def family(case: TestCase) -> str:
    keys = [(s.pan, s.stan) for s in case.steps if s.mti != "0400"]
    if case.rule == "reject_duplicate" or len(keys) != len(set(keys)):
        return "duplicate"
    if any(s.mti == "0400" for s in case.steps):
        return "reversal"
    if case.rule == "decline_insufficient":
        return "nsf"
    return "other"


def groups(run_id: str) -> dict[tuple, list[dict]]:
    out: dict[tuple, list[dict]] = {}
    for it in db.results(run_id, "regression", limit=100_000):
        if it["case"].source != "triage":
            out.setdefault(signature(it), []).append(it)
    return out


def smallest(items: list[dict]) -> dict:
    # prefer human-reviewed cases over replay rows, then fewest steps, then lowest amount
    return min(items, key=lambda it: (it["case"].source == "dataset", len(it["case"].steps),
                                      max(s.amount_cents for s in it["case"].steps)))


class FollowupIdeas(BaseModel):
    reasoning: str
    extra_gaps_s: list[float] = Field(default_factory=list)
    extra_amounts_cents: list[int] = Field(default_factory=list)


def _legacy_dup(gap: float, same_amount: bool) -> tuple[list[str], int]:
    """Expected legacy outcome for purchase + retry: derived from the rule table, never from the LLM."""
    if same_amount and gap <= 60:
        return ["00", "94"], 1
    return ["00", "00"], 2


def _fu(parent: TestCase, n: int, title: str, steps: list[Step], codes: list[str], delta: int, why: str, balance=None) -> TestCase:
    acct = parent.accounts[0].model_copy(update={"balance_cents": balance} if balance is not None else {})
    return TestCase(id=f"{parent.id}-f{n:02d}", run_id=parent.run_id, title=title, rule=parent.rule, source="triage",
                    accounts=[acct], steps=steps, expected_codes=codes, expected_balance_delta_cents={acct.pan: delta},
                    rationale=why, status="approved", parent_case_id=parent.id)


def build_followups(run: Run, parent: TestCase, round_no: int, ideas: FollowupIdeas | None) -> list[TestCase]:
    """Deterministic sweep (+ LLM-suggested extras), all inside run.bounds."""
    b = run.bounds
    s0 = parent.steps[0]
    pan, amt = s0.pan, s0.amount_cents
    fam = family(parent)
    out: list[TestCase] = []
    base_n = round_no * 20
    ok_amt = lambda a: 0 < a <= b.max_amount_cents

    if fam == "duplicate":
        gaps = [0, 0.5, 1, 2, 5, 30, 59, 61] if round_no == 1 else []
        gaps += [g for g in (ideas.extra_gaps_s if ideas else []) if 0 <= g <= 600]
        prev = [c for c in run.cases if c.parent_case_id == parent.id]
        done = {c.steps[1].at_offset_s for c in prev if len(c.steps) == 2 and c.steps[1].amount_cents == amt}
        for g in sorted(set(gaps) - done):
            codes, debits = _legacy_dup(g, True)
            out.append(_fu(parent, base_n + len(out), f"Retry gap {g:g} s: ${amt / 100:,.2f} twice, same STAN",
                           [s0.model_copy(update={"at_offset_s": 0.0}), s0.model_copy(update={"at_offset_s": float(g)})],
                           codes, -amt * debits, f"Sweep retry gap to locate the duplicate-window boundary (gap={g:g} s)."))
        if round_no == 1:
            for other in [amt // 2] + [a for a in (ideas.extra_amounts_cents if ideas else [])]:
                if ok_amt(other) and other != amt:
                    out.append(_fu(parent, base_n + len(out), f"Different amount ${other / 100:,.2f} at 5 s, same STAN",
                                   [s0.model_copy(update={"at_offset_s": 0.0}), s0.model_copy(update={"at_offset_s": 5.0, "amount_cents": other})],
                                   ["00", "00"], -(amt + other), "Different amount is not a duplicate: checks the key."))
                    break
    elif fam == "reversal" and round_no == 1:
        rev = lambda stan, off, orig: Step(mti="0400", pan=pan, amount_cents=amt, stan=stan, at_offset_s=off, original_stan=orig)
        buy = s0.model_copy(update={"mti": "0200", "at_offset_s": 0.0, "stan": "700001"})
        out += [_fu(parent, base_n, "Reverse once", [buy, rev("700002", 10, "700001")], ["00", "00"], 0, "Single reversal restores balance."),
                _fu(parent, base_n + 1, "Reverse twice", [buy, rev("700002", 10, "700001"), rev("700003", 20, "700001")],
                    ["00", "00", "94"], 0, "Second reversal must be rejected."),
                _fu(parent, base_n + 2, "Reverse unknown STAN", [rev("700004", 0, "799999")], ["25"], 0, "Unknown original -> 25.")]
    elif round_no == 1:
        bal = parent.accounts[0].balance_cents
        for n, a in enumerate([bal, bal - 1, bal + 1]):
            if ok_amt(a):
                exp = "00" if a <= bal else "51"
                out.append(_fu(parent, base_n + n, f"Amount {'=' if a == bal else '<' if a < bal else '>'} balance (${a / 100:,.2f})",
                               [s0.model_copy(update={"amount_cents": a, "at_offset_s": 0.0})], [exp], -a if exp == "00" else 0,
                               "Balance boundary sweep.", balance=bal))
    return [c for c in out if all(s.mti in b.allowed_mti and ok_amt(s.amount_cents) for s in c.steps)]


async def plan_followups(run: Run, round_no: int, loop_iter: int | None) -> list[TestCase]:
    grp = groups(run.id)
    if not grp:
        return []
    sig, items = max(grp.items(), key=lambda kv: len(kv[1]))
    parent = smallest(items)["case"]
    ideas = None
    if not llm.offline():
        user = (f"Regression signature (rule, legacy code, new code): {sig}; {len(items)} failing cases.\n"
                f"Smallest failing case: {parent.model_dump_json()}\nRound {round_no}. Existing follow-up results:\n"
                f"{boundary_evidence(run.id, parent.id)}\nWhich variations would isolate the cause? Suggest retry gaps "
                f"(seconds) and/or amounts (cents, <= {run.bounds.max_amount_cents}).")
        ideas = await llm.complete_json(run.id, "triage", "You are the Triage agent of SwitchProof. Output "
                                        '{"reasoning": str, "extra_gaps_s": [float], "extra_amounts_cents": [int]}',
                                        user, FollowupIdeas, loop_iter=loop_iter)
        emit(run.id, "triage", "info", f"Model suggests: {ideas.reasoning[:300]}", loop_iter=loop_iter)
    cases = build_followups(run, parent, round_no, ideas)
    if cases:
        emit(run.id, "triage", "info", f"Round {round_no}: {len(cases)} follow-up tests for {sig} built from '{parent.title}'. "
             "Auto-approved because they stay inside your bounds "
             f"(max ${run.bounds.max_amount_cents / 100:,.2f}, message types {', '.join(run.bounds.allowed_mti)}).",
             {"case_ids": [c.id for c in cases]}, loop_iter=loop_iter)
    return cases


def boundary_evidence(run_id: str, parent_id: str) -> list[dict]:
    rows = []
    for it in db.results(run_id, limit=100_000):
        c, r = it["case"], it["result"]
        if c.parent_case_id == parent_id and r.steps:
            rows.append({"title": c.title, "gap_s": c.steps[-1].at_offset_s, "amount_cents": c.steps[-1].amount_cents,
                         "expected": c.expected_codes, "old": [s.old_a_code for s in r.steps],
                         "new": [s.new_code for s in r.steps], "verdict": r.verdict})
    return sorted(rows, key=lambda x: x["gap_s"])


def find_boundary(run_id: str) -> str | None:
    """For duplicate regressions: smallest gap the new switch approves vs largest it still rejects."""
    grp = groups(run_id)
    if not grp:
        return None
    parent = smallest(max(grp.values(), key=len))["case"]
    ev = [e for e in boundary_evidence(run_id, parent.id) if e["amount_cents"] == parent.steps[0].amount_cents and len(e["new"]) == 2]
    if family(parent) != "duplicate":
        failing = [e["title"] for e in boundary_evidence(run_id, parent.id) if e["verdict"] == "regression"]
        return f"Follow-ups that still regress: {', '.join(failing) or 'none'}" if failing or ev else None
    rejected = [e["gap_s"] for e in ev if e["new"][1] == "94"]
    approved = [e["gap_s"] for e in ev if e["new"][1] == "00" and e["gap_s"] <= 60]
    if not rejected or not approved:
        return None
    lo, hi = max(g for g in rejected if g < min(approved)) if any(g < min(approved) for g in rejected) else None, min(approved)
    if lo is None:
        return None
    return (f"Duplicates {hi:g} s or more apart are approved by the new switch (legacy rejects them with 94 up to 60 s); "
            f"retries {lo:g} s apart or less are still rejected.")


class ReportOut(BaseModel):
    summary_md: str
    severity: Literal["critical", "high", "medium", "low"]
    root_cause_hypothesis: str


def money_at_risk(run_id: str) -> int:
    total = 0
    for items in groups(run_id).values():
        for it in items:
            d = it["result"].balance_delta_cents
            for pan, old in d.get("old_a", {}).items():
                total += max(0, old - d.get("new", {}).get(pan, old))     # extra debit by the new switch
    return total


async def report(run: Run, boundary: str | None, loop_iter: int | None) -> TriageReport:
    grp = groups(run.id)
    sig, items = max(grp.items(), key=lambda kv: len(kv[1]))
    parent = smallest(items)["case"]
    evidence = boundary_evidence(run.id, parent.id)
    risk = money_at_risk(run.id)
    followups = [c.id for c in run.cases if c.source == "triage"]
    table = "| Retry gap | Amount | Expected | Legacy (old A) | New switch | Verdict |\n|---|---|---|---|---|---|\n" + "\n".join(
        f"| {e['gap_s']:g} s | ${e['amount_cents'] / 100:,.2f} | {'/'.join(e['expected'])} | {'/'.join(e['old'])} | "
        f"{'/'.join(e['new'])} | {e['verdict']} |" for e in evidence)
    sigs = "\n".join(f"- `{s[0]}`: legacy {s[1]} → new {s[2]} ({len(v)} cases)" for s, v in grp.items())
    if llm.offline():
        dup = family(parent) == "duplicate"
        out = ReportOut(
            severity="critical" if risk > 0 else "high",
            root_cause_hypothesis=("Duplicate-detection window configured as 60 but interpreted in milliseconds, so only "
                                   "same-second retries are caught." if dup else f"New switch diverges on {sig[0]}."),
            summary_md=(f"## New switch approves duplicate payments\n\n**{len(items)}** failing cases share the signature "
                        f"`{sig[0]}` legacy **{sig[1]}** → new **{sig[2]}**. Smallest reproduction: *{parent.title}*.\n\n"
                        f"**Boundary:** {boundary or 'not isolated'}\n\n**Money at risk:** ${risk / 100:,.2f} of extra debits "
                        f"across the failing cases.\n\n### Follow-up evidence\n\n{table}\n\n### All regression signatures\n\n{sigs}"
                        if dup else f"## Regression in {sig[0]}\n\n{len(items)} failing cases.\n\n{table}\n\n{sigs}"))
    else:
        user = (f"Regression signatures:\n{sigs}\nSmallest failing case: {parent.model_dump_json()}\n"
                f"Follow-up evidence table (markdown):\n{table}\nBoundary found: {boundary}\nMoney at risk (extra debits): "
                f"${risk / 100:,.2f}\nWrite summary_md (markdown, include the evidence table verbatim, plain English for a "
                f"payments tester), severity, root_cause_hypothesis (one sentence, specific).")
        out = await llm.complete_json(run.id, "triage", "You are the Triage agent of SwitchProof writing the regression report. "
                                      'Output {"summary_md": str, "severity": "critical|high|medium|low", "root_cause_hypothesis": str}',
                                      user, ReportOut, loop_iter=loop_iter)
    return TriageReport(summary_md=out.summary_md, severity=out.severity, affected_rule=parent.rule,
                        root_cause_hypothesis=out.root_cause_hypothesis, followup_case_ids=followups, money_at_risk_cents=risk)
