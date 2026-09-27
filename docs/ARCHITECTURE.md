# SwitchProof architecture

API routes, codes and JSON shapes: [CONTRACT.md](CONTRACT.md) and `shared/schemas.py`.

## Components

```mermaid
flowchart TB
  subgraph Browser["Browser (over NetBird)"]
    W["web/: index.html + app.js<br/>5-step rail, Agents, Safety, RL tabs<br/>polls /api every 1 s"]
  end

  subgraph CP["sp-control: Vultr VX1"]
    API["control_plane.app (FastAPI)<br/>/api/runs, /api/system, static web/"]
    CO["coordinator: tool-calling loop"]
    PL["planner"]
    GE["generator"]
    EX["executor (no LLM)"]
    TR["triage"]
    RE["reporter"]
    RL["rl launcher"]
    API --> CO
    CO --> PL & GE & EX & TR & RE & RL
  end

  subgraph SB["sp-sandbox: Vultr VX1"]
    SH["sandbox_host.app :9000<br/>X-SwitchProof-Token"]
    D["Docker + gVisor runsc"]
    subgraph BOX["throwaway sandbox (network none, read-only root)"]
      RUN["runner: switchcore<br/>old_a · old_b · new switches<br/>ISO 8583 over TCP 127.0.0.1"]
    end
    SH --> D --> BOX
  end

  VI["Vultr Serverless Inference<br/>api.vultrinference.com/v1"]
  GH["GitHub: issue + commit status"]

  W <--> API
  PL & GE & TR & CO -- "chat completions" --> VI
  EX -- "POST /batch" --> SH
  RL -- "POST /job (rl.experiment)" --> SH
  API -- "POST /probe, GET /health" --> SH
  RE --> GH
```

Trust boundaries:

- **LLM output is data, never code on the control plane.** Generated cases are validated against `TestCase`. The optional `check_script` only ever executes inside a gVisor sandbox.
- **Human gate.** `POST /execute` returns `409` while any case is `proposed`. Replay runs only if the human switched it on (`ReplayConfig.enabled`). Triage follow-ups run without a new approval only when `bounds.auto_followups` is on, and only inside `max_amount_cents` and `allowed_mti`.
- **Sandbox host** accepts only the control plane (token + ufw on the VPC + NetBird policy). Each batch gets a fresh `runsc` container that is destroyed afterwards. A `SandboxProof` (hostname, `uname`, runtime, network, read-only root) comes back with every result.
- **Noise filter.** Two identical legacy switches: if `old_a` and `old_b` disagree, the verdict is `noise`, not `regression`.

## Sequence: generate → approve → execute → triage → decision

```mermaid
sequenceDiagram
  autonumber
  actor H as Tester
  participant UI as Web UI
  participant API as Control plane
  participant CO as Coordinator
  participant LLM as Vultr Serverless Inference
  participant SB as Sandbox host (gVisor)
  participant GH as GitHub

  H->>UI: Rules, bounds, replay toggle
  UI->>API: POST /api/runs, PATCH /replay, POST /generate
  API->>CO: start loop (status planning)
  loop coordinator tool calls
    CO->>LLM: which tool next?
    LLM-->>CO: plan_rules / generate_cases
    CO->>LLM: planner and generator prompts
    LLM-->>CO: states, TestCases
  end
  CO-->>API: request_approval (status awaiting_approval)
  UI->>API: PATCH cases (approve / reject / edit), POST /approve_all
  H->>UI: Run approved tests
  UI->>API: POST /execute (409 if any proposed)
  API->>SB: POST /batch × N (approved cases + replay)
  SB-->>API: BatchResult (verdicts, proof, destroyed)
  API-->>UI: events: progress, finding "new approved duplicate $250.00"
  CO->>LLM: triage: propose follow-ups within bounds
  API->>SB: POST /batch (retry gaps 0 … 61 s)
  SB-->>API: boundary: new approves retries ≥ 1 s apart
  CO->>API: reporter: templated report
  API->>GH: create issue, commit status pending
  API-->>UI: status awaiting_decision
  H->>UI: Block migration
  UI->>API: POST /decision {block}
  API->>GH: commit status failure
  API-->>UI: status blocked
```

## Run states

`draft → planning → awaiting_approval → running → triaging → awaiting_decision → blocked | approved_for_release`

The UI polls `GET /api/runs/{id}` and `GET /api/runs/{id}/events?after=<seq>` every second and stops at a terminal state. Evidence uses `GET /results?verdict=…&limit=200` for the list, plus one unfiltered `GET /results?limit=5000` to find triage follow-ups for the boundary chart.
