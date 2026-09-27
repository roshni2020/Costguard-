from shared.schemas import Account, Step, TestCase

DEMO_PAN = "4111111111111111"


def demo_duplicate_case(run_id: str) -> TestCase:
    step = dict(mti="0200", pan=DEMO_PAN, amount_cents=25000, stan="000123")
    return TestCase(
        id=f"{run_id}-demo-duplicate", run_id=run_id,
        title="Duplicate $250 purchase retried after 5 seconds",
        rule="reject_duplicate", source="human", status="approved",
        accounts=[Account(pan=DEMO_PAN, balance_cents=100_000)],
        steps=[Step(**step, at_offset_s=0.0), Step(**step, at_offset_s=5.0)],
        expected_codes=["00", "94"],
        expected_balance_delta_cents={DEMO_PAN: -25000},
        rationale="Same card, STAN and amount within 60 seconds must be rejected as a duplicate (94).",
    )
