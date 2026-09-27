"""Executor (no LLM): batches of 250, up to 4 sandboxes in parallel, one retry per failed batch."""
from __future__ import annotations
import asyncio
import os
import uuid

from control_plane import db, k8s, sandbox_client
from control_plane.events import emit
from shared.schemas import BatchRequest, CaseResult, Counts, TestCase

BATCH = 250
PER_HOST = 4        # each sandbox VM runs up to 4 sandboxes at once (sandbox_host SEM)


def new_bugs() -> list[str]:
    return [b for b in os.environ.get("NEW_SWITCH_BUGS", "dup_window_units").split(",") if b]


def refresh_counts(run_id: str) -> Counts:
    vc = db.verdict_counts(run_id)
    counts = Counts(total=sum(vc.values()), passed=vc.get("pass", 0), regression=vc.get("regression", 0),
                    both_wrong=vc.get("both_wrong", 0), noise=vc.get("noise", 0), error=vc.get("error", 0))
    db.mutate_run(run_id, lambda r: setattr(r, "counts", counts))
    return counts


async def execute(run_id: str, cases: list[TestCase], loop_iter: int | None = None) -> list[CaseResult]:
    """Run `cases` in sandboxes. Caller guarantees they are human-approved (or triage follow-ups inside bounds)."""
    db.save_cases(cases)
    batches = [cases[i:i + BATCH] for i in range(0, len(cases), BATCH)]
    parallel = PER_HOST * max(1, len(sandbox_client.urls())) if not k8s.enabled() else int(os.environ.get("K8S_MAX_PARALLEL", "8"))
    emit(run_id, "executor", "info", f"Dispatching {len(cases):,} cases in {len(batches)} sandbox batch(es), "
         + (f"{parallel} gVisor pods in parallel on Vultr Kubernetes" if k8s.enabled() else f"{parallel} in parallel across {max(1, len(sandbox_client.urls()))} sandbox VM(s)"), loop_iter=loop_iter)
    sem = asyncio.Semaphore(parallel)
    all_results: list[CaseResult] = []
    first_regression = [db.verdict_counts(run_id).get("regression", 0) > 0]

    async def one(idx: int, batch: list[TestCase]):
        req = BatchRequest(batch_id=f"{run_id}-b{uuid.uuid4().hex[:6]}", run_id=run_id, cases=batch, new_switch_bugs=new_bugs())
        async with sem:
            for attempt in (1, 2):
                try:
                    res = await sandbox_client.run_batch(req)
                    break
                except Exception as e:
                    emit(run_id, "executor", "warning", f"Batch {idx + 1} failed (attempt {attempt}): {str(e)[:300]}", loop_iter=loop_iter)
            else:
                res = None
        if res is None:
            results = [CaseResult(case_id=c.id, verdict="error", steps=[], balance_delta_cents={},
                                  error="sandbox batch failed twice", duration_ms=0) for c in batch]
        else:
            results = res.results

            def add_proof(r):
                r.proofs.append(res.proof)
                r.sandboxes_used += 1
            db.mutate_run(run_id, add_proof)
            emit(run_id, "executor", "info", f"Sandbox {res.proof.sandbox_id} ({res.proof.runtime}) on {res.proof.hostname} ran "
                 f"{len(batch)} cases, destroyed={res.destroyed}", {"proof": res.proof.model_dump()}, loop_iter=loop_iter)
        db.save_results(run_id, results)
        all_results.extend(results)
        counts = refresh_counts(run_id)
        emit(run_id, "executor", "progress", f"{counts.total:,} done: {counts.passed:,} passed, {counts.regression:,} regressions, "
             f"{counts.error:,} errors", counts.model_dump(), loop_iter=loop_iter)
        if not first_regression[0]:
            reg = next((r for r in results if r.verdict == "regression"), None)
            if reg:
                first_regression[0] = True
                bad = next((s for s in reg.steps if s.new_code != s.old_a_code), reg.steps[-1] if reg.steps else None)
                case = next(c for c in batch if c.id == reg.case_id)
                old, new = (bad.old_a_code, bad.new_code) if bad else ("?", "?")
                emit(run_id, "executor", "finding",
                     f"Regression in '{case.title}': legacy switch answered {old}, new switch answered {new}",
                     {"case_id": reg.case_id, "old_code": old, "new_code": new,
                      "balance_delta_cents": reg.balance_delta_cents}, loop_iter=loop_iter)

    await asyncio.gather(*(one(i, b) for i, b in enumerate(batches)))
    return all_results
