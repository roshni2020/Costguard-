"""IBM TabFormer replay (public SYNTHETIC benchmark) -> TestCases with dataset-derived expected codes."""
from __future__ import annotations
import csv
import logging
import os
import random

from shared.schemas import Account, Step, TestCase

log = logging.getLogger("switchcore.dataset")
MAX_ROWS_SCANNED = 500_000          # ponytail: sample from the first 500k rows, full 24M scan takes minutes
# TabFormer "Errors?" value -> legacy response code, in legacy check order (first match wins)
ERROR_CODES = [("Bad Card Number", "14"), ("Bad Expiration", "54"), ("Bad PIN", "55"),
               ("Technical Glitch", "96"), ("Insufficient Balance", "51")]
ENTRY = {"Chip Transaction": "chip", "Swipe Transaction": "swipe", "Online Transaction": "online"}
stats: dict[str, int] = {}          # last load: rows scanned, skipped errors, etc.


def luhn_pan(prefix: str, n: int) -> str:
    body = f"{prefix}{n:011d}"[:15]
    total = 0
    for i, ch in enumerate(reversed(body)):
        d = int(ch)
        if i % 2 == 0:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return body + str((10 - total % 10) % 10)


def _fake_rows(n: int, seed: int):
    log.warning("TABFORMER CSV NOT FOUND - using %d generated fake rows (development only)", n)
    stats["source"] = "generated fallback rows (TabFormer CSV not found)"
    rng = random.Random(seed)
    errs = [""] * 90 + ["Insufficient Balance", "Bad PIN", "Bad Card Number", "Bad Expiration", "Technical Glitch", "Bad CVV"]
    for i in range(n):
        amt = rng.choice([rng.uniform(1, 80), rng.uniform(80, 900)]) * (-1 if rng.random() < 0.02 else 1)
        yield {"User": str(i % 500), "Card": str(i % 3), "Amount": f"${amt:.2f}", "Use Chip": rng.choice(list(ENTRY)),
               "MCC": rng.choice(["5411", "5812", "5541", "5912", "4829"]), "Errors?": rng.choice(errs)}


def _rows(seed: int):
    path = os.environ.get("TABFORMER_CSV", "data/card_transaction.v1.csv")
    if not os.path.exists(path):
        yield from _fake_rows(5000, seed)
        return
    with open(path, newline="") as fh:
        for i, row in enumerate(csv.DictReader(fh)):
            if i >= MAX_ROWS_SCANNED:
                return
            yield row


def load_replay_cases(run_id: str, sample_size: int, seed: int = 7) -> list[TestCase]:
    stats.clear()
    rng = random.Random(seed)
    special, normal = [], []           # stratified: keep every error/refund row, reservoir-sample the rest
    for i, row in enumerate(_rows(seed)):
        if row.get("Errors?") or row["Amount"].startswith("-") or row["Amount"].startswith("$-"):
            special.append(row)
        elif len(normal) < sample_size:
            normal.append(row)
        else:
            j = rng.randint(0, i)
            if j < sample_size:
                normal[j] = row
    rng.shuffle(special)
    picked = special[: sample_size // 5] + normal
    picked = picked[:sample_size]
    rng.shuffle(picked)

    source = stats.get("source", "IBM TabFormer CSV")
    stats.clear()
    stats.update(source=source, rows_scanned=i + 1, skipped_unmapped_errors=0, duplicates_injected=0)
    cases = []
    for n, row in enumerate(picked):
        case = _to_case(run_id, n, row, rng)
        if case is None:
            stats["skipped_unmapped_errors"] += 1
            continue
        cases.append(case)
    log.info("replay: %s", stats)
    return cases


def _to_case(run_id: str, n: int, row: dict, rng: random.Random) -> TestCase | None:
    amount = abs(round(float(row["Amount"].replace("$", "").replace(",", "")) * 100)) or 1
    pan = luhn_pan("4000", int(row.get("User", 0)) * 10 + int(row.get("Card", 0)))
    base = dict(pan=pan, amount_cents=amount, stan=f"{n % 999999 + 1:06d}",
                mcc=(row.get("MCC") or "5411")[:4].zfill(4), entry_mode=ENTRY.get(row.get("Use Chip", ""), "chip"))
    acct = Account(pan=pan, balance_cents=amount + rng.randint(1_000, 500_000))
    steps = [Step(mti="0200", **base)]
    expected, delta = ["00"], {pan: -amount}
    title = f"Replay: ${amount / 100:,.2f} purchase"
    errors = row.get("Errors?") or ""

    if errors:
        code = next((c for name, c in ERROR_CODES if name in errors), None)
        if code is None:                 # Bad CVV / Bad Zipcode: no field for it in our spec
            return None
        expected, delta = [code], {pan: 0}
        title = f"Replay: {errors.strip(',')} -> {code}"
        if code == "14":
            steps = [Step(mti="0200", **{**base, "pan": luhn_pan("4999", n)})]
        elif code == "54":
            acct.expiry_yymm = "2508"
        elif code == "55":
            steps = [Step(mti="0200", **base, pin_ok=False)]
        elif code == "96":
            steps = [Step(mti="0200", **base, force_glitch=True)]
        elif code == "51":
            acct.balance_cents = amount // 2
    elif row["Amount"].replace("$", "").startswith("-"):   # refund -> purchase + reversal
        steps.append(Step(mti="0400", **{**base, "stan": f"{(n + 500_000) % 999999:06d}"}, at_offset_s=30, original_stan=base["stan"]))
        expected, delta = ["00", "00"], {pan: 0}
        title = f"Replay: ${amount / 100:,.2f} purchase then refund"
    elif rng.random() < 0.02:            # 2% injected retries (network resend 1-30 s later)
        steps.append(Step(mti="0200", **base, at_offset_s=float(rng.randint(1, 30))))
        expected = ["00", "94"]
        title = f"Replay: ${amount / 100:,.2f} purchase + retry after {steps[1].at_offset_s:.0f}s"
        stats["duplicates_injected"] += 1

    return TestCase(id=f"{run_id}-rp-{n:05d}", run_id=run_id, title=title, rule="replay", source="dataset",
                    status="approved", accounts=[acct], steps=steps, expected_codes=expected,
                    expected_balance_delta_cents=delta, rationale="Expected codes derived from the TabFormer row, not an LLM.")
