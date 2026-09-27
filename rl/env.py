"""Test-selection environment: an arm = mutation operator x parameter bucket applied to a base purchase.
Each step builds a TestCase and runs it through switchcore.engine.run_case against a mutant 'new' switch."""
from __future__ import annotations
from functools import lru_cache

from shared.schemas import Account, Step, TestCase
from switchcore import iso
from switchcore.engine import run_case
from switchcore.switch import Switch

PAN = "4111111111111111"
GAPS = [0, 0.5, 2, 10, 45]
AMOUNTS = {"small": 500, "medium": 25000, "large": 90000}
FAMILY = {
    "plain_purchase": "balance", "exact_balance": "balance", "balance_minus_1": "balance",
    "duplicate_retry": "duplicate", "same_stan_diff_amount": "duplicate",
    "reverse_once": "reversal", "reverse_twice": "reversal", "reverse_unknown": "reversal",
    "expired_this_month": "expiry", "expired_last_month": "expiry",
    "bad_pin_chip": "pin", "bad_pin_swipe": "pin", "glitch": "glitch",
}


def _arms() -> list[tuple[str, float | None, str]]:
    arms = []
    for op in FAMILY:
        if op == "duplicate_retry":
            arms += [(op, g, a) for g in GAPS for a in AMOUNTS]
        elif op == "same_stan_diff_amount":
            arms += [(op, g, "medium") for g in GAPS]
        else:
            arms += [(op, None, a) for a in AMOUNTS]
    return arms


ARMS = _arms()          # 53 discrete arms


def build_case(arm: tuple) -> TestCase:
    op, gap, bucket = arm
    amt = AMOUNTS[bucket]
    bal, expiry = 100_000, "2912"
    s = lambda **kw: Step(**{"mti": "0200", "pan": PAN, "amount_cents": amt, "stan": "000777", **kw})
    rev = lambda stan, off, orig="000777": Step(mti="0400", pan=PAN, amount_cents=amt, stan=stan, at_offset_s=off, original_stan=orig)
    steps = {
        "plain_purchase": lambda: [s()],
        "duplicate_retry": lambda: [s(), s(at_offset_s=gap)],
        "same_stan_diff_amount": lambda: [s(), s(at_offset_s=gap, amount_cents=amt - 1234)],
        "reverse_once": lambda: [s(), rev("000778", 10)],
        "reverse_twice": lambda: [s(), rev("000778", 10), rev("000779", 20)],
        "reverse_unknown": lambda: [rev("000778", 0, "999999")],
        "exact_balance": lambda: [s()],
        "balance_minus_1": lambda: [s()],
        "expired_this_month": lambda: [s()],
        "expired_last_month": lambda: [s()],
        "bad_pin_chip": lambda: [s(pin_ok=False)],
        "bad_pin_swipe": lambda: [s(pin_ok=False, entry_mode="swipe")],
        "glitch": lambda: [s(force_glitch=True)],
    }[op]()
    if op == "exact_balance":
        bal = amt
    elif op == "balance_minus_1":
        bal = amt - 1
    elif op == "expired_this_month":
        expiry = "2609"
    elif op == "expired_last_month":
        expiry = "2608"
    acct = Account(pan=PAN, balance_cents=bal, expiry_yymm=expiry)
    # expected results = what the legacy switch does (the oracle), so a verdict of `regression` means "new differs"
    legacy = Switch("legacy", set())
    legacy.load_accounts([acct])
    codes = [iso.parse(legacy.handle(iso.build_request(st, expiry)[0]))["39"] for st in steps]
    return TestCase(id=f"rl-{op}-{gap}-{bucket}", run_id="rl", title=f"{op} gap={gap} amount={bucket}", rule="custom",
                    source="rl", status="approved", accounts=[acct], steps=steps, expected_codes=codes,
                    expected_balance_delta_cents={PAN: legacy.balances()[PAN] - bal})


@lru_cache(maxsize=None)
def outcome(arm_idx: int, bugs: frozenset[str]) -> tuple[str, tuple, tuple]:
    """(verdict, legacy codes, new codes). Deterministic, so cached - that is what makes CPU training take seconds."""
    r = run_case(build_case(ARMS[arm_idx]), set(bugs))
    return r.verdict, tuple(s.old_a_code for s in r.steps), tuple(s.new_code for s in r.steps)


class Episode:
    def __init__(self, bugs: set[str], budget: int = 60):
        self.bugs, self.budget = frozenset(bugs), budget
        self.found: set = set()
        self.states: set = set()
        self.tried: list[int] = []
        self.misses: dict[str, int] = {}

    def step(self, arm_idx: int) -> tuple[float, bool]:
        """Returns (reward, found_new_regression)."""
        verdict, old, new = outcome(arm_idx, self.bugs)
        op = ARMS[arm_idx][0]
        self.tried.append(arm_idx)
        if verdict == "regression" and (op, old, new) not in self.found:
            self.found.add((op, old, new))
            return 1.0, True
        self.misses[FAMILY[op]] = self.misses.get(FAMILY[op], 0) + 1
        state = (op, new)
        if state not in self.states:
            self.states.add(state)
            return 0.05, False
        return 0.0, False
