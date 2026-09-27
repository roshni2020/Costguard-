from __future__ import annotations
from typing import Optional

from pydantic import BaseModel, Field

from control_plane import llm
from control_plane.events import emit
from shared.schemas import Account, Run, Step, TestCase
from switchcore.dataset import luhn_pan
from switchcore.demo import demo_duplicate_case

PAN = "4111111111111111"


class GenCase(BaseModel):
    title: str
    rule: str
    accounts: list[Account]
    steps: list[Step]
    expected_codes: list[str]
    expected_balance_delta_cents: dict[str, int] = Field(default_factory=dict)
    rationale: str = ""
    check_script: Optional[str] = None


class GenOut(BaseModel):
    cases: list[GenCase]


SYSTEM = """You are the Test Generator agent of SwitchProof. Write concrete, executable ISO 8583 test cases for a
LEGACY card switch. A human reviews every case before anything runs.

Shapes (JSON):
Account = {"pan": 16-digit Luhn-valid card number, "balance_cents": int, "expiry_yymm": "2912", "status": "active"|"blocked"}
Step = {"mti": "0100"|"0200"|"0400", "pan": str, "amount_cents": int, "stan": 6 digits, "mcc": "5411",
        "entry_mode": "chip"|"swipe"|"online", "pin_ok": bool, "at_offset_s": float seconds after case start,
        "original_stan": 6 digits (0400 only: the purchase being reversed), "force_glitch": bool}
Case = {"title", "rule", "accounts": [Account], "steps": [Step], "expected_codes": [one per step],
        "expected_balance_delta_cents": {pan: net change}, "rationale", "check_script": optional short Python (reversal cases only;
        runs only inside a gVisor sandbox; `result` dict with steps and balance_delta_cents per switch is in scope)}

Response codes: 00 approved, 14 unknown card, 25 original not found, 51 insufficient funds, 54 expired, 55 bad PIN,
62 blocked card, 94 duplicate / already reversed, 96 system malfunction.
Legacy check order for 0100/0200: unknown card 14 -> blocked 62 -> expired 54 -> PIN 55 -> glitch 96 ->
duplicate (same card + STAN + amount within 60 s) 94 -> balance < amount 51 -> else 00 and debit.
0400: original STAN not found/not approved 25 -> already reversed 94 -> else 00 and credit back.
Virtual clock starts 2026-09-27T12:00:00Z; cards expiring 2609 are still valid this month.

Example 1: {"title": "Approve $42.50 purchase", "rule": "approve_purchase", "accounts": [{"pan": "4111111111111111", "balance_cents": 100000}],
 "steps": [{"mti": "0200", "pan": "4111111111111111", "amount_cents": 4250, "stan": "000101"}], "expected_codes": ["00"],
 "expected_balance_delta_cents": {"4111111111111111": -4250}, "rationale": "Funds available -> approve and debit."}
Example 2: {"title": "Reverse an approved $80 purchase", "rule": "reverse_approved", "accounts": [{"pan": "4111111111111111", "balance_cents": 100000}],
 "steps": [{"mti": "0200", "pan": "4111111111111111", "amount_cents": 8000, "stan": "000201"},
           {"mti": "0400", "pan": "4111111111111111", "amount_cents": 8000, "stan": "000202", "at_offset_s": 10, "original_stan": "000201"}],
 "expected_codes": ["00", "00"], "expected_balance_delta_cents": {"4111111111111111": 0}, "rationale": "Reversal restores the balance."}

Write 2-4 cases per planned rule, covering edge cases (boundaries, retries, repeats). Output {"cases": [Case, ...]}"""


def _s(amount, stan, off=0.0, mti="0200", pan=PAN, **kw):
    return Step(mti=mti, pan=pan, amount_cents=amount, stan=stan, at_offset_s=off, **kw)


def _c(title, rule, balance, steps, codes, delta, why, pan=PAN, script=None):
    return GenCase(title=title, rule=rule, accounts=[Account(pan=pan, balance_cents=balance)], steps=steps,
                   expected_codes=codes, expected_balance_delta_cents={pan: delta}, rationale=why, check_script=script)


def offline_templates(rule: str) -> list[GenCase]:
    rev_check = "d=result['balance_delta_cents']\nassert d['old_a']['4111111111111111']==0, d\nprint('legacy balance restored:', d)"
    return {
        "approve_purchase": [
            _c("Approve $42.50 grocery purchase", rule, 100000, [_s(4250, "000101")], ["00"], -4250, "Funds available -> 00 and debit."),
            _c("Approve $900.00 purchase within balance", rule, 100000, [_s(90000, "000102")], ["00"], -90000, "Large amount still below balance."),
            _c("Approve $120.00 authorization (0100)", rule, 100000, [_s(12000, "000103", mti="0100")], ["00"], -12000, "Auths also debit in this mock."),
        ],
        "decline_insufficient": [
            _c("Decline $250.00 purchase with $100.00 balance", rule, 10000, [_s(25000, "000201")], ["51"], 0, "Balance < amount -> 51, no debit."),
            _c("Approve purchase of exactly the balance", rule, 25000, [_s(25000, "000202")], ["00"], -25000, "Balance == amount is enough (not <)."),
            _c("Decline purchase $0.01 over the balance", rule, 24999, [_s(25000, "000203")], ["51"], 0, "Boundary: one cent short -> 51."),
        ],
        "reject_duplicate": [
            _c("Duplicate $250 purchase retried after 5 seconds", rule, 100000, [_s(25000, "000123"), _s(25000, "000123", 5.0)],
               ["00", "94"], -25000, "Same card, STAN and amount within 60 s -> 94; customer charged once."),
            _c("Same STAN, different amount is not a duplicate", rule, 100000, [_s(25000, "000124"), _s(9900, "000124", 5.0)],
               ["00", "00"], -34900, "Duplicate key includes the amount."),
            _c("Retry after 61 seconds is a new purchase", rule, 100000, [_s(25000, "000125"), _s(25000, "000125", 61.0)],
               ["00", "00"], -50000, "Outside the 60 s window -> approved again."),
        ],
        "reverse_approved": [
            _c("Reverse an approved $250 purchase", rule, 100000, [_s(25000, "000301"), _s(25000, "000302", 10, "0400", original_stan="000301")],
               ["00", "00"], 0, "Reversal credits the purchase back.", script=rev_check),
            _c("Second reversal of the same purchase is rejected", rule, 100000,
               [_s(25000, "000303"), _s(25000, "000304", 10, "0400", original_stan="000303"), _s(25000, "000305", 20, "0400", original_stan="000303")],
               ["00", "00", "94"], 0, "Already reversed -> 94, no double credit."),
            _c("Reversal of an unknown STAN", rule, 100000, [_s(25000, "000306", 0, "0400", original_stan="999999")], ["25"], 0,
               "Original not found -> 25."),
        ],
        "decline_bad_pin": [
            _c("Wrong PIN on chip is declined", rule, 100000, [_s(5000, "000401", pin_ok=False)], ["55"], 0, "PIN check -> 55."),
            _c("Wrong PIN on swipe is declined", rule, 100000, [_s(5000, "000402", pin_ok=False, entry_mode="swipe")], ["55"], 0, "Entry mode must not matter."),
        ],
        "technical_glitch": [
            _c("Issuer glitch returns 96 without debit", rule, 100000, [_s(5000, "000501", force_glitch=True)], ["96"], 0, "Fail closed."),
        ],
    }.get(rule, [_c("Approve $10.00 purchase", rule, 100000, [_s(1000, "000901")], ["00"], -1000, "Generic smoke test.")])


def _luhn_ok(pan: str) -> bool:
    return pan.isdigit() and len(pan) == 16 and luhn_pan(pan[:4], int(pan[4:15])) == pan


def validate_cases(run: Run, raw: list[GenCase], loop_iter: int | None = None) -> list[TestCase]:
    """Reject/repair what the model got wrong. Every repair is announced as a warning event."""
    b = run.bounds
    out: list[TestCase] = []
    start = len(run.cases)

    def warn(msg):
        emit(run.id, "generator", "warning", msg, loop_iter=loop_iter)

    for g in raw:
        if len(g.expected_codes) != len(g.steps) or not g.steps:
            warn(f"Rejected '{g.title}': {len(g.steps)} steps but {len(g.expected_codes)} expected codes")
            continue
        if any(s.mti not in b.allowed_mti for s in g.steps):
            warn(f"Rejected '{g.title}': message type outside the approved bounds {b.allowed_mti}")
            continue
        if any(s.amount_cents > b.max_amount_cents or s.amount_cents <= 0 for s in g.steps):
            warn(f"Rejected '{g.title}': amount outside bounds (max ${b.max_amount_cents / 100:,.2f})")
            continue
        fixes, bad = {}, False
        for pan in {a.pan for a in g.accounts} | {s.pan for s in g.steps}:
            if not (pan.isdigit() and len(pan) == 16):
                bad = True
            elif not _luhn_ok(pan):
                fixes[pan] = luhn_pan(pan[:4], int(pan[4:15]))
        if bad:
            warn(f"Rejected '{g.title}': card number is not 16 digits")
            continue
        for old, new in fixes.items():
            warn(f"Repaired '{g.title}': card ending {old[-4:]} failed the Luhn check, fixed check digit -> {new[-4:]}")
        for a in g.accounts:
            a.pan = fixes.get(a.pan, a.pan)
        for s in g.steps:
            s.pan = fixes.get(s.pan, s.pan)
            for attr in ("stan", "original_stan"):
                v = getattr(s, attr)
                if v is not None and not (v.isdigit() and len(v) == 6):
                    digits = "".join(ch for ch in v if ch.isdigit())[-6:].zfill(6)
                    warn(f"Repaired '{g.title}': {attr} {v!r} is not 6 digits -> {digits}")
                    setattr(s, attr, digits)
        g.expected_balance_delta_cents = {fixes.get(k, k): v for k, v in g.expected_balance_delta_cents.items()}
        out.append(TestCase(id=f"{run.id}-c{start + len(out) + 1:02d}", run_id=run.id, source="llm", status="proposed",
                            **g.model_dump()))
    return out


def has_duplicate_retry(cases: list[TestCase], min_gap: float = 2.0) -> bool:
    for c in cases:
        seen = {}
        for s in c.steps:
            if s.mti == "0400":
                continue
            key = (s.pan, s.stan, s.amount_cents)
            if key in seen and s.at_offset_s - seen[key] >= min_gap:
                return True
            seen.setdefault(key, s.at_offset_s)
    return False


async def _ask(run: Run, rules: list[dict], loop_iter) -> list[GenCase]:
    if llm.offline():
        return [g for p in rules for g in offline_templates(p["rule"])]
    user = (f"Planned rules:\n{rules}\n\nBounds: max amount {run.bounds.max_amount_cents} cents, allowed MTIs "
            f"{run.bounds.allowed_mti}.\nLegacy rules text:\n{run.rules_text}")
    return (await llm.complete_json(run.id, "generator", SYSTEM, user, GenOut, loop_iter=loop_iter)).cases


async def generate(run: Run, loop_iter: int | None = None) -> list[TestCase]:
    cases = validate_cases(run, await _ask(run, run.plan, loop_iter), loop_iter)

    missing = [p for p in run.plan if not any(c.rule == p["rule"] for c in cases)]
    if missing:   # coverage self-check: ask once for the missing rules
        emit(run.id, "generator", "warning", f"Coverage gap: no cases for {[p['rule'] for p in missing]}; asking again", loop_iter=loop_iter)
        tmp = run.model_copy(update={"cases": run.cases + cases})
        cases += validate_cases(tmp, await _ask(tmp, missing, loop_iter), loop_iter)

    if not has_duplicate_retry(cases):
        demo = demo_duplicate_case(run.id).model_copy(update={"status": "proposed"})
        cases.append(demo)
        emit(run.id, "generator", "warning", "The model produced no duplicate retry >= 2 s apart; added the standard "
             "library case 'Duplicate $250 purchase retried after 5 seconds' (source: human-written library).", loop_iter=loop_iter)
    for c in cases:
        emit(run.id, "generator", "info", f"Proposed: {c.title} [{c.rule}] expects {'/'.join(c.expected_codes)}",
             {"case_id": c.id}, loop_iter=loop_iter)
    return cases
