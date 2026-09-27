from __future__ import annotations
from typing import Literal

from pydantic import BaseModel

from control_plane import llm
from control_plane.events import emit
from shared.schemas import Run

Rule = Literal["approve_purchase", "decline_insufficient", "reject_duplicate", "reverse_approved",
               "decline_bad_pin", "decline_expired", "decline_bad_card", "technical_glitch", "custom"]


class PlanItem(BaseModel):
    rule: Rule
    description: str
    states: list[str]
    risk: Literal["critical", "high", "medium", "low"] = "medium"


class PlanOut(BaseModel):
    plan: list[PlanItem]


SYSTEM = """You are the Planner agent of SwitchProof, a testing platform for payment-switch migrations.
Turn the tester's requirements into a test plan. Each item maps ONE requirement to exactly one rule from this
vocabulary: approve_purchase, decline_insufficient, reject_duplicate, reverse_approved, decline_bad_pin,
decline_expired, decline_bad_card, technical_glitch, custom.
For each item give: rule, description (one sentence), states (the account/message states to cover, e.g.
"balance > amount", "retry 5 s later with same STAN"), risk (critical|high|medium|low - money movement bugs are critical).
Output: {"plan": [{"rule": ..., "description": ..., "states": [...], "risk": ...}]}"""

KEYWORDS = [  # offline mode: keyword -> (rule, states, risk)
    (("duplicate",), "reject_duplicate", ["first purchase approved", "same card+STAN+amount retried within 60 s", "retry after the window"], "critical"),
    (("reverse", "refund"), "reverse_approved", ["reverse an approved purchase", "reverse twice", "reverse an unknown STAN"], "critical"),
    (("insufficient",), "decline_insufficient", ["balance < amount", "balance == amount"], "high"),
    (("pin",), "decline_bad_pin", ["wrong PIN on chip", "wrong PIN on swipe"], "high"),
    (("expired",), "decline_expired", ["expired last month", "expires this month"], "medium"),
    (("card number",), "decline_bad_card", ["unknown card number"], "medium"),
    (("glitch",), "technical_glitch", ["issuer technical glitch"], "high"),
    (("approve", "purchase"), "approve_purchase", ["balance > amount", "small and large amounts"], "high"),
]


def offline_plan(requirements: list[str]) -> list[PlanItem]:
    out = []
    for req in requirements:
        low = req.lower()
        for words, rule, states, risk in KEYWORDS:
            if any(w in low for w in words):
                out.append(PlanItem(rule=rule, description=req, states=states, risk=risk))
                break
        else:
            out.append(PlanItem(rule="custom", description=req, states=["as described"], risk="medium"))
    return out


async def plan(run: Run, loop_iter: int | None = None) -> list[dict]:
    if llm.offline():
        items = offline_plan(run.requirements)
    else:
        user = (f"Requirements:\n- " + "\n- ".join(run.requirements) +
                f"\n\nLegacy rules:\n{run.rules_text}\n\nAPI spec:\n{run.spec_text}")
        items = (await llm.complete_json(run.id, "planner", SYSTEM, user, PlanOut, loop_iter=loop_iter)).plan
    for it in items:
        emit(run.id, "planner", "info", f"Planned {it.rule}: {it.description} ({it.risk} risk)", loop_iter=loop_iter)
    return [it.model_dump() for it in items]
