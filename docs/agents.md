# Agents, coordinator loop, RL explorer (AI #2)

Code: `control_plane/` (FastAPI, agents, SQLite) and `rl/`. Prompts live next to the code that uses them. Quote them from there; they are the source of truth.

| Agent | File | LLM | Does |
|---|---|---|---|
| coordinator | `control_plane/agents/coordinator.py` (`SYSTEM`) | yes (tool calling) | runs the loop, picks the next agent |
| planner | `agents/planner.py` (`SYSTEM`) | yes | requirements → `plan` (rule vocabulary from the contract) |
| generator | `agents/generator.py` (`SYSTEM`, with shapes, code table, check order and 2 worked examples) | yes | plan → proposed `TestCase`s |
| executor | `agents/executor.py` | no | 250-case batches, 4 sandboxes in parallel, 1 retry |
| triage | `agents/triage.py` | yes | follow-up sweeps, boundary, `TriageReport` |
| reporter | `agents/reporter.py` | no (templated) | GitHub issue, commit status `switchproof/migration-gate`, Discord |
| rl | `rl/` | no | CPU-trained test explorer, runs inside a sandbox via `/job` |

Every Vultr inference call emits an `llm_call` event. It carries the real model id returned by the API, `tokens_in`/`tokens_out`, `latency_ms`, and the prompt and reply (each truncated to 4 KB). Each agent picks its model from `LLM_MODEL_<AGENT>` (coordinator, generator, triage, ...) and falls back to `LLM_MODEL`. At startup the app calls `GET {LLM_BASE_URL}/chat/models` (falling back to `/models`) and logs an error if a configured model is missing from that list.

## Coordinator loop

Each iteration does four things: **observe** (compact JSON run state), **decide** (one tool call through Vultr inference), **act** (run that agent) and **record** (`tool_call`, `message`, `tool_result` events, all tagged with `loop_iter`).

Tools: `plan_rules`, `generate_tests`, `request_human_approval`, `execute_tests`, `generate_followups`, `triage_findings`, `file_report`, `request_human_decision`, `finish`.

Guardrails are enforced in code, not in the prompt:
- `options(run, meta)` computes the tools valid in the current state. A tool outside that set goes back to the model as a tool error. After 2 invalid choices, the loop takes the deterministic next step and emits a `warning`.
- There are at most 12 iterations per segment. A segment is the stretch of the loop between two human gates. When the cap is hit, control goes to the human.
- `request_human_approval` and `request_human_decision` pause the loop, and the coordinator's state becomes `waiting_human`. `POST /execute` (the human's "run approved tests") and `POST /decision` resume it.
- `execute_tests` is refused while any case is `proposed`. `/execute` also returns 409.
- Triage follow-ups are auto-approved only inside `run.bounds` (max amount, allowed MTIs, `auto_followups`), and an event says so. Their expected codes come from the legacy rule table in code, never from the LLM. Replay expected codes come from the dataset.
- Triage sub-loop: `generate_followups` → `execute_tests`, repeated up to 3 rounds, stopping as soon as `find_boundary` finds the boundary.

With `LLM_OFFLINE=1` the coordinator follows the deterministic policy (first element of `options`), and every agent uses templates. The events look the same, except that no `llm_call` events are produced, because none would be real.

## State machine

`draft → planning → awaiting_approval → running → triaging → awaiting_decision → blocked | approved_for_release`

Every transition is checked in `app.transition()`; an invalid one returns 409. If a background task crashes, it emits an `error` event, and `POST /api/runs/{id}/retry` resumes from the current state.

## RL explorer

- **Arms (53):** 13 mutation operators × buckets. `duplicate_retry` is crossed with 5 retry gaps and 3 amounts. `same_stan_diff_amount` is crossed with 5 gaps. Every other operator is crossed with 3 amounts.
- **Episode:** 60 executions against a mutant `new` switch carrying 1–2 bugs drawn from `TRAINING_BUGS`. The holdout `dup_window_units` is never used in training.
- **Reward:** 1.0 for a regression with a signature not seen this episode, 0.05 for a new (operator, response codes) state, otherwise 0. Every execution calls `switchcore.engine.run_case`, cached because the switches are deterministic.
- **Agent:** a linear value function over shared features (bug family, operator, gap bucket, amount bucket, misses so far in the family), trained with SGD and ε-greedy exploration (ε decays 0.3 → 0.05) over arms not yet tried in the episode. It is pure Python and runs on CPU.
- **Baseline:** random ordering of the same arms without repeats. This is stronger than uniform sampling with replacement.

### Honest result (`python -m rl.experiment`, defaults 400 episodes / 30 seeds / budget 60, about 5 s on a laptop)

| Mean executions to first regression | Learned | Random |
|---|---|---|
| Held-out `dup_window_units` | 21.8 | **5.8** |
| Mix of training bugs | **4.7** | 12.6 |

The learned policy is much faster on bug families it has seen, and **worse than random on the held-out bug**. The reason: no training bug makes a plain same-amount duplicate retry fail (`dup_key_ignores_amount` only shows up with a *different* amount). So the policy learns to rank reversal and different-amount arms first. We report this as is and did not tune on the holdout. The principled fix is a contract change: add a duplicate-timing training bug, such as a 30-second window. That decision is for Roshni.

## Run offline

```bash
LLM_OFFLINE=1 python -m control_plane.demo_flow            # full flow in fake sandbox mode, ~2 s
python -m pytest tests/agents -q
echo '{}' | python -m rl.experiment
```

When `SANDBOX_HOST_URL` is unset, the control plane runs cases in-process ("fake mode", `runtime=local-unsafe`) and logs a loud warning. That mode is for development only. Agent-written `check_script`s run only inside the gVisor sandbox image (`SWITCHPROOF_IN_SANDBOX=1`), and that is exactly why agent-written test code must be sandboxed.
