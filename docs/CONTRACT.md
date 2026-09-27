# SwitchProof shared contract

Schemas: `shared/schemas.py` (source of truth, includes the coordinator/agent-console amendment: extra `Event` fields, `AgentStatus`).

## Verdict rules (engine)
- `noise`: `old_a` and `old_b` disagree on any code or balance delta.
- `pass`: old_a == new == expected for every step, and old_a/new balance deltas equal.
- `regression`: old_a matches expected (codes, and expected_balance_delta_cents if given) but `new` differs in any code or balance delta.
- `both_wrong`: old_a does not match expected.
- `error`: exception, timeout, malformed message.

## Legacy (correct) switch
0100/0200 check order: unknown card → **14**; blocked → **62**; expired (expiry_yymm < txn YYMM) → **54**; `pin_ok` false → **55**; `force_glitch` → **96**; duplicate (same card + STAN + amount within 60 s) → **94**; balance < amount → **51**; else **00** and debit.
0400 reversal: original STAN not found / not approved → **25**; already reversed → **94**; else credit back → **00**.
Virtual clock: 2026-09-27T12:00:00Z + `at_offset_s`, field 7 = MMDDhhmmss.

Response code labels: 00 Approved · 14 Invalid card number · 25 Original not found · 51 Insufficient funds · 54 Expired card · 55 Incorrect PIN · 62 Restricted card · 94 Duplicate transmission · 96 System malfunction.

## Bug library
| Flag | Wrong behaviour |
| --- | --- |
| `dup_window_units` | Demo bug, held out from RL training. Duplicate window 60 read as ms → duplicate ≥1 s later approved and debited twice. |
| `reversal_no_credit` | Reversal returns 00 but does not credit. |
| `reversal_double_credit` | Second reversal of the same STAN returns 00 and credits again. |
| `nsf_exact_balance` | `balance <= amount` → purchase of exactly the balance declined 51. |
| `expiry_month_off_by_one` | Card expiring this month declined 54. |
| `glitch_fail_open` | Glitch returns 00 instead of 96 and debits. |
| `pin_ignored_swipe` | `pin_ok=false` still approves on swipe. |
| `dup_key_ignores_amount` | Different amount, same card+STAN inside window → rejected 94. |

Demo: card `4111111111111111`, $1,000.00. 0200 $250.00 STAN 000123 at t=0, again at t=5 s → old 94, new 00; new balance −$500 vs old −$250.

## ISO 8583 fields
`t` MTI · `2` card · `3` processing code (`000000` purchase/auth, `200000` reversal) · `4` amount (12 digits cents) · `7` MMDDhhmmss · `11` STAN · `14` expiry · `18` MCC · `22` entry (`051` chip, `021` swipe, `010` online) · `37` retrieval ref (original STAN padded, 0400) · `39` response · `41` `SWPROOF1` · `48` `PIN=OK|BAD;GLITCH=0|1` · `49` `840`. TCP 127.0.0.1, 2-byte big-endian length prefix.

## Sandbox host (VM #2, :9000, header `X-SwitchProof-Token`)
- `GET /health` → `{"kvm", "runsc", "mode": "gvisor"|"local", "active_sandboxes", "hostname", "uname"}`
- `POST /batch` BatchRequest → BatchResult
- `POST /job` JobRequest → JobResult
- `POST /probe` → ProbeResult
- `GET /sandboxes` → `{"active": [{"sandbox_id", "started_at"}]}`

## Control plane (VM #1, :8000)
- `GET /` → `web/index.html`
- `POST /api/runs` `{"title", "requirements", "rules_text", "spec_text", "bounds"?, "replay"?}` → Run
- `GET /api/runs` → list[Run] (cases omitted, newest first)
- `GET /api/runs/{id}` → Run
- `POST /api/runs/{id}/generate` → `{"ok": true}` (planning → awaiting_approval)
- `PATCH /api/runs/{id}/cases/{case_id}` any of `{"status","title","steps","expected_codes","expected_balance_delta_cents"}` → TestCase
- `POST /api/runs/{id}/cases` partial TestCase (source "human") → TestCase
- `POST /api/runs/{id}/approve_all` → `{"approved": int}`
- `PATCH /api/runs/{id}/replay` ReplayConfig → Run
- `POST /api/runs/{id}/execute` → `{"ok": true}` (running → triaging → awaiting_decision); 409 if any case `proposed`
- `GET /api/runs/{id}/events?after=<seq>` → list[Event]
- `GET /api/runs/{id}/results?verdict=<v>&limit=<n>` → list[{"case", "result"}]
- `POST /api/runs/{id}/decision` `{"decision": "block"|"approve", "reviewer", "note"}` → Run
- `POST /api/runs/{id}/rl` → `{"ok": true}`; `GET /api/runs/{id}/rl` → RLReport
- `GET /api/runs/{id}/agents` → list[AgentStatus]
- `GET /api/runs/{id}/export` → `{"run", "results", "events"}`
- `GET /api/system` → `{"control_plane": {"hostname","uname"}, "sandbox_host": health | {"error"}, "llm": {"base_url","model","reachable"}}`
- `POST /api/system/probe` → ProbeResult

Errors: `{"detail": str}`.

## Env vars
`VULTR_INFERENCE_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` (+ optional `LLM_MODEL_COORDINATOR`, `LLM_MODEL_GENERATOR`, `LLM_MODEL_TRIAGE`), `LLM_OFFLINE`, `SANDBOX_HOST_URL`, `SANDBOX_TOKEN`, `SANDBOX_MODE`, `RUNNER_IMAGE`, `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_SHA`, `DISCORD_WEBHOOK_URL`, `TABFORMER_CSV`.
