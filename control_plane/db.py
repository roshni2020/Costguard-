"""SQLite persistence (stdlib). Pydantic models stored as JSON. One global lock; ponytail: fine for one VM."""
from __future__ import annotations
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Callable

from shared.schemas import CaseResult, Event, Run, TestCase

DB_PATH = os.environ.get("SWITCHPROOF_DB", "data/switchproof.db")
LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, json TEXT);
            CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, run_id TEXT, json TEXT);
            CREATE TABLE IF NOT EXISTS results(case_id TEXT PRIMARY KEY, run_id TEXT, verdict TEXT, json TEXT);
            CREATE INDEX IF NOT EXISTS results_run_verdict ON results(run_id, verdict);
            CREATE TABLE IF NOT EXISTS events(run_id TEXT, seq INTEGER, json TEXT, PRIMARY KEY(run_id, seq));
            CREATE TABLE IF NOT EXISTS meta(run_id TEXT PRIMARY KEY, json TEXT);
        """)
    return _conn


@contextmanager
def tx():
    with LOCK:
        c = conn()
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


# --- runs -------------------------------------------------------------------
def save_run(run: Run) -> Run:
    with tx() as c:
        c.execute("INSERT OR REPLACE INTO runs VALUES(?,?)", (run.id, run.model_dump_json()))
    return run


def get_run(run_id: str) -> Run | None:
    with LOCK:
        row = conn().execute("SELECT json FROM runs WHERE id=?", (run_id,)).fetchone()
    return Run.model_validate_json(row[0]) if row else None


def list_runs() -> list[Run]:
    with LOCK:
        rows = conn().execute("SELECT json FROM runs").fetchall()
    runs = [Run.model_validate_json(r[0]) for r in rows]
    return sorted(runs, key=lambda r: r.created_at, reverse=True)


def mutate_run(run_id: str, fn: Callable[[Run], None]) -> Run:
    """Read-modify-write under the lock, so background tasks and API calls never clobber each other."""
    with LOCK:
        run = get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        fn(run)
        return save_run(run)


# --- cases + results ----------------------------------------------------------
def save_cases(cases: list[TestCase]) -> None:
    with tx() as c:
        c.executemany("INSERT OR REPLACE INTO cases VALUES(?,?,?)", [(k.id, k.run_id, k.model_dump_json()) for k in cases])


def get_case(case_id: str) -> TestCase | None:
    with LOCK:
        row = conn().execute("SELECT json FROM cases WHERE id=?", (case_id,)).fetchone()
    return TestCase.model_validate_json(row[0]) if row else None


def save_results(run_id: str, results: list[CaseResult]) -> None:
    with tx() as c:
        c.executemany("INSERT OR REPLACE INTO results VALUES(?,?,?,?)",
                      [(r.case_id, run_id, r.verdict, r.model_dump_json()) for r in results])


def result_ids(run_id: str) -> set[str]:
    with LOCK:
        return {r[0] for r in conn().execute("SELECT case_id FROM results WHERE run_id=?", (run_id,))}


def results(run_id: str, verdict: str | None = None, limit: int = 100) -> list[dict]:
    q = "SELECT c.json, r.json FROM results r JOIN cases c ON c.id = r.case_id WHERE r.run_id=?"
    args: list = [run_id]
    if verdict:
        q += " AND r.verdict=?"
        args.append(verdict)
    q += " ORDER BY r.rowid LIMIT ?"
    args.append(limit)
    with LOCK:
        rows = conn().execute(q, args).fetchall()
    return [{"case": TestCase.model_validate_json(a), "result": CaseResult.model_validate_json(b)} for a, b in rows]


def verdict_counts(run_id: str) -> dict[str, int]:
    with LOCK:
        return dict(conn().execute("SELECT verdict, COUNT(*) FROM results WHERE run_id=? GROUP BY verdict", (run_id,)).fetchall())


# --- events -------------------------------------------------------------------
def add_event(run_id: str, make: Callable[[int], Event]) -> Event:
    with tx() as c:
        seq = (c.execute("SELECT MAX(seq) FROM events WHERE run_id=?", (run_id,)).fetchone()[0] or 0) + 1
        ev = make(seq)
        c.execute("INSERT INTO events VALUES(?,?,?)", (run_id, seq, ev.model_dump_json()))
    return ev


def events(run_id: str, after: int = 0) -> list[Event]:
    with LOCK:
        rows = conn().execute("SELECT json FROM events WHERE run_id=? AND seq>? ORDER BY seq", (run_id, after)).fetchall()
    return [Event.model_validate_json(r[0]) for r in rows]


# --- coordinator meta (loop counter, triage rounds, ...) ------------------------
def get_meta(run_id: str) -> dict:
    with LOCK:
        row = conn().execute("SELECT json FROM meta WHERE run_id=?", (run_id,)).fetchone()
    return json.loads(row[0]) if row else {}


def set_meta(run_id: str, **kw) -> dict:
    with LOCK:
        m = get_meta(run_id) | kw
        with tx() as c:
            c.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (run_id, json.dumps(m)))
        return m
