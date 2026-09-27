"""Event log + live agent registry. AgentStatus counters are derived from events; only `state` lives in memory."""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from control_plane import db
from shared.schemas import AgentStatus, Event

log = logging.getLogger("switchproof")

AGENTS = {  # name -> (role, uses an LLM)
    "coordinator": ("Runs the loop: observes the run and picks the next agent", True),
    "planner": ("Turns payment rules into a test plan", True),
    "generator": ("Writes concrete ISO 8583 test cases", True),
    "executor": ("Dispatches approved tests to gVisor sandboxes", False),
    "triage": ("Isolates the cause of regressions with follow-up tests", True),
    "reporter": ("Files the GitHub issue and holds the release gate", False),   # templated, no LLM
    "rl": ("RL test explorer trained on CPU inside a sandbox", False),
    "analyst": ("Answers questions about this run: logs, metrics, test cases", True),
}
_state: dict[tuple[str, str], str] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(run_id: str, agent: str, kind: str, message: str, data: dict | None = None, **extra) -> Event:
    ev = db.add_event(run_id, lambda seq: Event(seq=seq, ts=now(), agent=agent, kind=kind, message=message,
                                                 data=data or {}, **extra))
    log.info("[%s] %s/%s: %s", run_id, agent, kind, message)
    return ev


def say(run_id: str, sender: str, receiver: str, message: str, loop_iter: int | None = None, **data) -> Event:
    """A handoff between agents (kind=message) - the Agent Console renders these as a conversation."""
    return emit(run_id, sender, "message", message, data, to_agent=receiver, loop_iter=loop_iter)


def set_state(run_id: str, agent: str, state: str) -> None:
    _state[(run_id, agent)] = state


def model_for(agent: str) -> str | None:
    from control_plane import llm
    return llm.model_for(agent) if AGENTS[agent][1] else None


def agent_statuses(run_id: str) -> list[AgentStatus]:
    evs = db.events(run_id)
    out = []
    for name, (role, _) in AGENTS.items():
        mine = [e for e in evs if e.agent == name]
        calls = [e for e in mine if e.kind == "llm_call"]
        spoken = [e for e in mine if e.kind in ("message", "info", "finding", "warning", "error")]
        out.append(AgentStatus(
            name=name, role=role, model=model_for(name), state=_state.get((run_id, name), "done" if mine else "idle"),
            last_message=spoken[-1].message if spoken else "", llm_calls=len(calls),
            tokens=sum((e.tokens_in or 0) + (e.tokens_out or 0) for e in calls)))
    return out
