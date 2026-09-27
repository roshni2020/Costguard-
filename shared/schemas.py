from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field

MTI = Literal["0100", "0200", "0400"]          # auth, purchase, reversal
Verdict = Literal["pass", "regression", "both_wrong", "noise", "error"]
RunStatus = Literal["draft", "planning", "awaiting_approval", "running", "triaging",
                    "awaiting_decision", "blocked", "approved_for_release"]

class Account(BaseModel):
    pan: str                                    # 16 digits, Luhn-valid
    balance_cents: int
    expiry_yymm: str = "2912"
    status: Literal["active", "blocked"] = "active"

class Step(BaseModel):
    mti: MTI
    pan: str
    amount_cents: int
    stan: str                                   # 6 digits, field 11
    mcc: str = "5411"                           # field 18
    entry_mode: Literal["chip", "swipe", "online"] = "chip"   # field 22
    pin_ok: bool = True                         # simulated PIN verification result
    at_offset_s: float = 0.0                    # virtual seconds after case start (drives field 7)
    original_stan: Optional[str] = None         # 0400 only: STAN of the transaction being reversed
    force_glitch: bool = False                  # simulate issuer technical glitch -> expect 96

class TestCase(BaseModel):
    __test__ = False                            # not a pytest class
    id: str
    run_id: str
    title: str
    rule: str   # approve_purchase | decline_insufficient | reject_duplicate | reverse_approved |
                # decline_bad_pin | decline_expired | decline_bad_card | technical_glitch | replay | custom
    source: Literal["llm", "dataset", "triage", "rl", "human"]
    accounts: list[Account]
    steps: list[Step]
    expected_codes: list[str]                   # one ISO 8583 field-39 code per step
    expected_balance_delta_cents: dict[str, int] = Field(default_factory=dict)  # pan -> delta
    check_script: Optional[str] = None          # optional Python run ONLY inside a gVisor sandbox
    rationale: str = ""
    status: Literal["proposed", "approved", "rejected"] = "proposed"
    parent_case_id: Optional[str] = None        # set on triage follow-ups

class StepResult(BaseModel):
    index: int
    request_fields: dict[str, str]              # decoded ISO fields, keys like "t", "2", "4", "11"
    request_hex: str
    expected_code: str
    old_a_code: str
    old_b_code: str
    new_code: str
    new_response_hex: str

class CaseResult(BaseModel):
    case_id: str
    verdict: Verdict
    steps: list[StepResult]
    balance_delta_cents: dict[str, dict[str, int]]   # {"old_a": {pan: delta}, "old_b": {...}, "new": {...}}
    check_output: Optional[str] = None
    error: Optional[str] = None
    duration_ms: int

class SandboxProof(BaseModel):
    sandbox_id: str
    runtime: Literal["runsc", "local-unsafe"]
    hostname: str
    uname: str
    network: str                                # "none" in gvisor mode
    readonly_rootfs: bool

class BatchRequest(BaseModel):
    batch_id: str
    run_id: str
    cases: list[TestCase]
    new_switch_bugs: list[str] = ["dup_window_units"]
    old_switch_bugs: list[str] = []
    timeout_s: int = 120

class BatchResult(BaseModel):
    batch_id: str
    run_id: str
    proof: SandboxProof
    results: list[CaseResult]
    started_at: str                             # ISO 8601 UTC
    finished_at: str
    destroyed: bool

class ProbeCheck(BaseModel):
    name: str
    attempted: str                              # the command or action tried
    outcome: Literal["BLOCKED", "ALLOWED"]
    detail: str

class ProbeResult(BaseModel):
    proof: SandboxProof
    checks: list[ProbeCheck]
    destroyed: bool

class JobRequest(BaseModel):
    job_id: str
    module: Literal["rl.experiment"]            # whitelist
    args: dict = Field(default_factory=dict)
    timeout_s: int = 300

class JobResult(BaseModel):
    job_id: str
    proof: SandboxProof
    output: dict
    destroyed: bool

class Event(BaseModel):
    seq: int
    ts: str
    agent: Literal["coordinator", "planner", "generator", "human", "executor", "triage", "reporter", "rl", "system"]
    kind: Literal["info", "progress", "warning", "finding", "decision", "error", "message", "tool_call", "tool_result", "llm_call"]
    message: str
    data: dict = Field(default_factory=dict)
    to_agent: Optional[str] = None        # who this message is addressed to ("coordinator", "generator", "human", ...)
    loop_iter: Optional[int] = None       # coordinator loop iteration number
    model: Optional[str] = None           # e.g. the Vultr model id, for llm_call events
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    latency_ms: Optional[int] = None
    tool: Optional[str] = None            # tool name for tool_call / tool_result

class AgentStatus(BaseModel):
    name: str
    role: str
    model: Optional[str] = None            # None for non-LLM agents (executor, rl)
    state: Literal["idle", "thinking", "acting", "waiting_human", "done", "error"]
    last_message: str = ""
    llm_calls: int = 0
    tokens: int = 0

class Bounds(BaseModel):
    max_amount_cents: int = 100_000
    allowed_mti: list[MTI] = ["0100", "0200", "0400"]
    auto_followups: bool = True                 # triage may run follow-ups inside these bounds without new approval

class ReplayConfig(BaseModel):
    enabled: bool = False                       # human must switch this on = approval of the replay pack
    sample_size: int = 2000
    dataset: str = "tabformer"

class TriageReport(BaseModel):
    summary_md: str
    severity: Literal["critical", "high", "medium", "low"]
    affected_rule: str
    root_cause_hypothesis: str
    followup_case_ids: list[str]
    money_at_risk_cents: int

class Decision(BaseModel):
    decision: Literal["block", "approve"]
    reviewer: str
    note: str = ""
    ts: str

class Counts(BaseModel):
    total: int = 0
    passed: int = 0
    regression: int = 0
    both_wrong: int = 0
    noise: int = 0
    error: int = 0

class RLReport(BaseModel):
    status: Literal["idle", "running", "done", "error"]
    episodes: int = 0
    trained_on_bugs: list[str] = Field(default_factory=list)
    holdout_bug: str = "dup_window_units"
    curves: dict[str, list[float]] = Field(default_factory=dict)   # {"learned": [...], "random": [...]} mean cumulative regressions found per execution
    first_find: dict[str, float] = Field(default_factory=dict)     # {"learned": 7.2, "random": 31.5} mean executions to first regression
    seeds: int = 0

class Run(BaseModel):
    id: str
    title: str
    status: RunStatus
    created_at: str
    requirements: list[str]
    rules_text: str = ""
    spec_text: str = ""
    bounds: Bounds = Field(default_factory=Bounds)
    replay: ReplayConfig = Field(default_factory=ReplayConfig)
    plan: list[dict] = Field(default_factory=list)      # planner output: [{"rule": ..., "description": ..., "states": [...]}]
    cases: list[TestCase] = Field(default_factory=list) # LLM/human/triage cases (replay cases are NOT listed here)
    counts: Counts = Field(default_factory=Counts)
    sandboxes_used: int = 0
    proofs: list[SandboxProof] = Field(default_factory=list)
    triage: Optional[TriageReport] = None
    github: dict = Field(default_factory=dict)          # {"issue_url": ..., "status_state": "pending|failure|success"}
    decision: Optional[Decision] = None
    rl: RLReport = Field(default_factory=lambda: RLReport(status="idle"))
