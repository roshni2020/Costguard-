"""Live external check against Stripe's TEST mode (real API calls, no money moves).

Old system = a payment client that sends an Idempotency-Key on every retry (Stripe dedupes the retry).
New system = the same client with the seeded bug: it drops the key on retry, so Stripe creates a second payment.
Only sk_test_ keys are accepted, so this can never touch real money.
"""
from __future__ import annotations
import os
import uuid

import httpx

from control_plane import db
from control_plane.events import emit

API = "https://api.stripe.com/v1"
_transport: httpx.AsyncBaseTransport | None = None      # tests inject a fake Stripe here


def key() -> str | None:
    k = os.environ.get("STRIPE_TEST_KEY", "").strip()
    return k if k.startswith("sk_test_") else None       # never a live key


def enabled() -> bool:
    return key() is not None


async def _post(c: httpx.AsyncClient, path: str, data: dict, idem: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {key()}"}
    if idem:
        headers["Idempotency-Key"] = idem
    r = await c.post(API + path, data=data, headers=headers)
    body = r.json()
    if r.status_code >= 400:
        err = body.get("error", {})
        return {"error": True, "code": err.get("code"), "decline_code": err.get("decline_code"),
                "message": err.get("message", "")[:160], "id": (err.get("payment_intent") or {}).get("id")}
    return body


async def _pay(c, amount: int, pm: str, idem: str | None, label: str) -> dict:
    res = await _post(c, "/payment_intents", {"amount": amount, "currency": "usd", "payment_method": pm, "confirm": "true",
                                              "payment_method_types[]": "card", "description": f"SwitchProof test: {label}"}, idem)
    return {"id": res.get("id"), "status": res.get("status") or ("declined" if res.get("error") else None),
            "decline_code": res.get("decline_code") or res.get("code")}


async def run_checks(run_id: str, amount_cents: int = 25000) -> list[dict]:
    """Runs the live Stripe scenarios, stores and returns them. Each row: scenario, expected, old, new, verdict, stripe ids."""
    rows = []
    async with httpx.AsyncClient(timeout=30, transport=_transport) as c:
        # 1) the demo defect: purchase + retry 5 s later
        k = f"sp-{run_id}-{uuid.uuid4().hex[:8]}"
        old = [await _pay(c, amount_cents, "pm_card_visa", k, "old client, first attempt"),
               await _pay(c, amount_cents, "pm_card_visa", k, "old client, retry (same idempotency key)")]
        new = [await _pay(c, amount_cents, "pm_card_visa", f"{k}-n1", "new client, first attempt"),
               await _pay(c, amount_cents, "pm_card_visa", None, "new client, retry (key dropped: seeded bug)")]
        charges = lambda xs: len({x["id"] for x in xs if x["status"] == "succeeded"})
        rows.append({"scenario": f"Duplicate ${amount_cents / 100:,.2f} purchase retried", "expected": "1 charge",
                     "old": f"{charges(old)} charge(s)", "new": f"{charges(new)} charge(s)",
                     "verdict": "pass" if charges(new) == charges(old) == 1 else "regression" if charges(old) == 1 else "both_wrong",
                     "stripe_ids": [x["id"] for x in old + new if x["id"]]})
        # 2) plain approval, declines (same behaviour expected from both clients)
        for label, pm, expect in (("Purchase with funds available", "pm_card_visa", "succeeded"),
                                  ("Insufficient funds", "pm_card_chargeDeclinedInsufficientFunds", "insufficient_funds"),
                                  ("Expired card", "pm_card_chargeDeclinedExpiredCard", "expired_card"),
                                  ("Issuer processing error", "pm_card_chargeDeclinedProcessingError", "processing_error")):
            r = await _pay(c, 4250, pm, f"sp-{uuid.uuid4().hex[:10]}", label)
            got = r["status"] if r["status"] == "succeeded" else r["decline_code"]
            rows.append({"scenario": label, "expected": expect, "old": got, "new": got,
                         "verdict": "pass" if got == expect else "both_wrong", "stripe_ids": [r["id"]] if r["id"] else []})
        # 3) refund once, then refund again (must be refused)
        pi = await _pay(c, 8000, "pm_card_visa", f"sp-{uuid.uuid4().hex[:10]}", "purchase to refund")
        first = await _post(c, "/refunds", {"payment_intent": pi["id"]}) if pi["id"] else {"error": True}
        second = await _post(c, "/refunds", {"payment_intent": pi["id"]}) if pi["id"] else {"error": True}
        got = f"{first.get('status', first.get('code'))} / {second.get('code') or second.get('status')}"
        rows.append({"scenario": "Refund, then refund the same payment again", "expected": "succeeded / charge_already_refunded",
                     "old": got, "new": got, "verdict": "pass" if got == "succeeded / charge_already_refunded" else "both_wrong",
                     "stripe_ids": [x for x in (pi["id"], first.get("id")) if x]})
    for r in rows:
        emit(run_id, "executor", "finding" if r["verdict"] == "regression" else "info",
             f"Stripe test mode · {r['scenario']}: old {r['old']}, new {r['new']} (expected {r['expected']}) → {r['verdict']}",
             {"stripe_ids": r["stripe_ids"]})
    db.set_meta(run_id, stripe=rows)
    return rows
