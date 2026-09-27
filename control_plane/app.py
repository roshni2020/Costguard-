"""SwitchProof control plane (VM #1).  uvicorn control_plane.app:app --host 127.0.0.1 --port 8000"""
from __future__ import annotations
import asyncio
import logging
import os
import platform
import socket
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from control_plane import analyst, db, llm, metrics, netbird, objstore, sandbox_client
from control_plane.agents import coordinator, reporter
from control_plane.events import agent_statuses, emit, now, say, set_state
from shared import vultr
from shared.schemas import (Bounds, Decision, JobRequest, ReplayConfig, RLReport, Run, Step, TestCase)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
WEB = Path(__file__).resolve().parent.parent / "web"

_env = WEB.parent / ".env"          # local dev convenience; on the VMs systemd loads /etc/switchproof.env
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _k, _, _v = _line.partition("=")
        if _k.strip() and not _k.startswith("#") and _v.strip():
            os.environ.setdefault(_k.strip(), _v.strip())
_bg: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(_app):
    db.conn()
    if os.environ.get("AUTH_MODE") != "netbird":
        logging.warning("AUTH_MODE is not netbird: every caller is treated as a tester. Expose this app only over "
                        "an SSH tunnel or localhost until NetBird is enabled (infra/setup_netbird_control.sh).")
    if sandbox_client.url() is None:
        logging.warning("SANDBOX_HOST_URL is unset: FAKE sandbox mode (tests run on this machine). Never demo like this.")
    t = asyncio.create_task(llm.check_models())
    _bg.add(t)
    yield


app = FastAPI(title="SwitchProof control plane", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def get(run_id: str) -> Run:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(404, f"run {run_id} not found")
    return run


def transition(run_id: str, allowed: tuple[str, ...], new: str | None = None, check=None) -> Run:
    """Server-side state machine: 409 unless the run is in one of `allowed`."""
    def fn(r: Run):
        if r.status not in allowed:
            raise HTTPException(409, f"run is '{r.status}', expected one of {list(allowed)}")
        if check:
            check(r)
        if new:
            r.status = new
    get(run_id)
    return db.mutate_run(run_id, fn)


class CreateRun(BaseModel):
    title: str
    requirements: list[str]
    rules_text: str = ""
    spec_text: str = ""
    bounds: Optional[Bounds] = None
    replay: Optional[ReplayConfig] = None


@app.post("/api/runs", dependencies=[Depends(netbird.require_tester)])
def create_run(body: CreateRun) -> Run:
    if not body.requirements:
        raise HTTPException(422, "at least one requirement is needed")
    run = Run(id=f"run-{uuid.uuid4().hex[:8]}", title=body.title, status="draft", created_at=now(),
              requirements=body.requirements, rules_text=body.rules_text, spec_text=body.spec_text,
              bounds=body.bounds or Bounds(), replay=body.replay or ReplayConfig())
    db.save_run(run)
    emit(run.id, "system", "info", f"Run created: {run.title}")
    return run


@app.get("/api/runs")
def list_runs() -> list[Run]:
    return [r.model_copy(update={"cases": []}) for r in db.list_runs()]


@app.get("/api/runs/{run_id}")
def read_run(run_id: str) -> Run:
    return get(run_id)


@app.post("/api/runs/{run_id}/generate", dependencies=[Depends(netbird.require_tester)])
async def generate(run_id: str):
    run = transition(run_id, ("draft",), "planning")
    say(run_id, "human", "coordinator", f"Test '{run.title}' against these {len(run.requirements)} rules.")
    coordinator.launch(run_id)
    return {"ok": True}


class CasePatch(BaseModel):
    status: Optional[Literal["proposed", "approved", "rejected"]] = None
    title: Optional[str] = None
    steps: Optional[list[Step]] = None
    expected_codes: Optional[list[str]] = None
    expected_balance_delta_cents: Optional[dict[str, int]] = None


@app.patch("/api/runs/{run_id}/cases/{case_id}", dependencies=[Depends(netbird.require_tester)])
def patch_case(run_id: str, case_id: str, body: CasePatch) -> TestCase:
    upd = body.model_dump(exclude_none=True)
    out: list[TestCase] = []

    def fn(r: Run):
        if r.status != "awaiting_approval":
            raise HTTPException(409, f"cases can only be edited while awaiting approval (run is '{r.status}')")
        for i, c in enumerate(r.cases):
            if c.id == case_id:
                new = TestCase.model_validate(c.model_dump() | upd)
                if len(new.expected_codes) != len(new.steps):
                    raise HTTPException(422, "expected_codes needs exactly one code per step")
                if any(s.amount_cents > r.bounds.max_amount_cents for s in new.steps):
                    raise HTTPException(422, "amount exceeds the run's bounds")
                r.cases[i] = new
                out.append(new)
                return
        raise HTTPException(404, f"case {case_id} not found")
    db.mutate_run(run_id, fn)
    db.save_cases(out)
    if "status" in upd:
        emit(run_id, "human", "info", f"{upd['status'].capitalize()} '{out[0].title}'", {"case_id": case_id})
    return out[0]


@app.post("/api/runs/{run_id}/cases", dependencies=[Depends(netbird.require_tester)])
def add_case(run_id: str, body: dict) -> TestCase:
    run = get(run_id)
    try:
        case = TestCase.model_validate({"status": "proposed", "rationale": "Written by the tester.", **body,
                                        "id": f"{run_id}-h{uuid.uuid4().hex[:6]}", "run_id": run_id, "source": "human"})
    except Exception as e:
        raise HTTPException(422, str(e))
    if len(case.expected_codes) != len(case.steps):
        raise HTTPException(422, "expected_codes needs exactly one code per step")
    transition(run_id, ("draft", "awaiting_approval"), check=lambda r: r.cases.append(case))
    db.save_cases([case])
    emit(run_id, "human", "info", f"Added a hand-written test: {case.title}")
    return case


@app.post("/api/runs/{run_id}/approve_all", dependencies=[Depends(netbird.require_tester)])
def approve_all(run_id: str):
    n = [0]

    def fn(r: Run):
        for c in r.cases:
            if c.status == "proposed":
                c.status = "approved"
                n[0] += 1
    run = transition(run_id, ("awaiting_approval",), check=fn)
    db.save_cases(run.cases)
    emit(run_id, "human", "info", f"Approved all remaining tests ({n[0]})")
    return {"approved": n[0]}


@app.patch("/api/runs/{run_id}/replay", dependencies=[Depends(netbird.require_tester)])
def set_replay(run_id: str, body: ReplayConfig) -> Run:
    if not 1 <= body.sample_size <= 20_000:
        raise HTTPException(422, "sample_size must be 1..20000")
    run = transition(run_id, ("draft", "planning", "awaiting_approval"), check=lambda r: setattr(r, "replay", body))
    emit(run_id, "human", "info", f"Replay pack {'approved' if body.enabled else 'disabled'}: {body.sample_size:,} TabFormer transactions")
    return run


@app.post("/api/runs/{run_id}/execute", dependencies=[Depends(netbird.require_tester)])
async def execute(run_id: str):
    def check(r: Run):
        waiting = [c.title for c in r.cases if c.status == "proposed"]
        if waiting:
            raise HTTPException(409, f"{len(waiting)} test(s) still awaiting approval, e.g. '{waiting[0]}'")
        if not any(c.status == "approved" for c in r.cases) and not r.replay.enabled:
            raise HTTPException(409, "nothing approved to run")
    run = transition(run_id, ("awaiting_approval",), "running", check)
    ok = sum(c.status == "approved" for c in run.cases)
    say(run_id, "human", "coordinator", f"Approved {ok} tests, rejected {len(run.cases) - ok}"
        + (f", and the {run.replay.sample_size:,}-transaction replay pack" if run.replay.enabled else "") + ". Run them.")
    coordinator.launch(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/events")
def events(run_id: str, after: int = 0):
    get(run_id)
    return db.events(run_id, after)


@app.get("/api/runs/{run_id}/results")
def results(run_id: str, verdict: Optional[str] = None, limit: int = 100):
    get(run_id)
    return db.results(run_id, verdict, min(max(limit, 1), 5000))


class DecisionIn(BaseModel):
    decision: Literal["block", "approve"]
    reviewer: str
    note: str = ""


@app.post("/api/runs/{run_id}/decision")
async def decision(run_id: str, body: DecisionIn, who: dict = Depends(netbird.require_tester)) -> Run:
    reviewer = who["user"] or body.reviewer.strip()          # NetBird SSO identity beats a typed name
    if not reviewer:
        raise HTTPException(422, "reviewer name is required")
    note = body.note + (" (authenticated by NetBird SSO)" if who["user"] else "")
    d = Decision(decision=body.decision, reviewer=reviewer, note=note.strip(), ts=now())

    def fn(r: Run):
        r.decision = d
    run = transition(run_id, ("awaiting_decision",), "blocked" if d.decision == "block" else "approved_for_release", fn)
    verb = "blocked the migration" if d.decision == "block" else "approved the release"
    emit(run_id, "human", "decision", f"{d.reviewer} {verb}" + (f": {d.note}" if d.note else ""), d.model_dump(), to_agent="coordinator")
    await netbird.close_share(run_id, f"decision recorded: {d.decision}")
    coordinator.launch(run_id)
    return run


@app.get("/api/runs/{run_id}/metrics")
def run_metrics(run_id: str):
    get(run_id)
    return metrics.run_metrics(run_id)


@app.get("/api/metrics")
def all_metrics():
    return metrics.all_runs()


class AskIn(BaseModel):
    question: str


@app.post("/api/runs/{run_id}/ask")
async def ask(run_id: str, body: AskIn):
    get(run_id)                     # read-only analyst: viewers may ask too
    return await analyst.ask(run_id, body.question)


@app.get("/api/me")
def whoami(request: Request):
    return netbird.me(request)


@app.get("/api/runs/{run_id}/share")
def get_share(run_id: str, request: Request):
    get(run_id)
    return netbird.share(run_id, show_pin=netbird.me(request)["can_act"])


@app.post("/api/runs/{run_id}/share", dependencies=[Depends(netbird.require_tester)])
async def open_share(run_id: str):
    if get(run_id).status != "awaiting_decision":
        raise HTTPException(409, "review links exist only while a run is awaiting its decision")
    return await netbird.open_share(run_id)


@app.delete("/api/runs/{run_id}/share", dependencies=[Depends(netbird.require_tester)])
async def close_share(run_id: str):
    await netbird.close_share(run_id, "closed by tester")
    return {"active": False}


async def _rl_job(run_id: str, args: dict):
    set_state(run_id, "rl", "acting")
    t0 = time.perf_counter()
    try:
        job = await sandbox_client.run_job(JobRequest(job_id=f"{run_id}-rl-{uuid.uuid4().hex[:6]}", module="rl.experiment", args=args))
        o = job.output
        rep = RLReport(status="done", episodes=o["episodes"], trained_on_bugs=o["trained_on_bugs"], holdout_bug=o["holdout_bug"],
                       curves=o["curves"], first_find=o["first_find"], seeds=o["seeds"])
        db.mutate_run(run_id, lambda r: setattr(r, "rl", rep))
        ff = rep.first_find
        emit(run_id, "rl", "info", f"RL explorer trained on {len(rep.trained_on_bugs)} mutant switches, {rep.episodes} episodes, "
             f"{time.perf_counter() - t0:.0f} s on CPU in sandbox {job.proof.sandbox_id} ({job.proof.runtime}). Held-out bug "
             f"'{rep.holdout_bug}': first found after {ff.get('learned', 0):.1f} executions (learned) vs {ff.get('random', 0):.1f} (random).",
             {"proof": job.proof.model_dump(), "train_seconds": o.get("train_seconds")})
        set_state(run_id, "rl", "done")
    except Exception as e:
        db.mutate_run(run_id, lambda r: setattr(r, "rl", RLReport(status="error")))
        emit(run_id, "rl", "error", f"RL job failed: {str(e)[:400]}")
        set_state(run_id, "rl", "error")


@app.post("/api/runs/{run_id}/rl", dependencies=[Depends(netbird.require_tester)])
async def start_rl(run_id: str, body: Optional[dict] = None):
    if get(run_id).rl.status == "running":
        raise HTTPException(409, "RL explorer is already running")
    db.mutate_run(run_id, lambda r: setattr(r, "rl", RLReport(status="running")))
    emit(run_id, "rl", "info", "Training the RL test explorer on CPU inside a fresh sandbox (held-out bug: dup_window_units)")
    args = {"train_episodes": 400, "eval_seeds": 30, "budget": 60} | (body or {})
    t = asyncio.create_task(_rl_job(run_id, args))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return {"ok": True}


@app.get("/api/runs/{run_id}/rl")
def read_rl(run_id: str) -> RLReport:
    return get(run_id).rl


@app.get("/api/runs/{run_id}/agents")
def agents(run_id: str):
    get(run_id)
    return agent_statuses(run_id)


@app.post("/api/runs/{run_id}/retry", dependencies=[Depends(netbird.require_tester)])
async def retry(run_id: str):
    run = get(run_id)
    if not coordinator.options(run, db.get_meta(run_id)):
        raise HTTPException(409, f"nothing to resume in state '{run.status}'")
    coordinator.launch(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/export")
def export(run_id: str):
    get(run_id)
    return reporter.export_bundle(run_id)


@app.get("/api/system")
async def system():
    return {"control_plane": {"hostname": socket.gethostname(), "uname": " ".join(x for x in platform.uname() if x),
                              "vultr": vultr.metadata(), "storage": vultr.storage(os.path.dirname(db.DB_PATH))},
            "object_storage": objstore.info(), "netbird": await asyncio.to_thread(netbird.status),
            "sandbox_host": await sandbox_client.health(),
            "llm": {"base_url": llm.base_url(), "model": llm.model_for("coordinator"), "offline": llm.offline(),
                    "reachable": bool(llm.reachable), "models": llm.available_models[:30]}}


@app.post("/api/system/probe", dependencies=[Depends(netbird.require_tester)])
async def probe():
    try:
        return await sandbox_client.probe()
    except Exception as e:
        raise HTTPException(503, str(e))


WEB.mkdir(exist_ok=True)
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
