# Core: switches, engine, replay, sandbox host (AI #1)

- `switchcore/iso.py`: ISO 8583 over pyiso8583 `default_ascii`, the virtual clock (field 7), and 2-byte length framing.
- `switchcore/switch.py`: the legacy check order. Each bug in `switchcore/bugs.py` is one `if` branch.
- `switchcore/engine.py`: `run_case()` runs old_a, old_b and new, in-process or over TCP on 127.0.0.1, and applies the verdict rules from `docs/CONTRACT.md`. `check_script` runs only when `SWITCHPROOF_IN_SANDBOX=1`.
- `switchcore/dataset.py`: IBM TabFormer replay (public **synthetic** data). It samples from the first 500k rows, stratified to keep every error and refund row. It maps errors to codes in legacy check order and skips errors that have no field in our spec (Bad CVV, Bad Zipcode). Refunds become purchase + reversal, and 2% of cases get an injected retry 1–30 s later. If the CSV is missing, it falls back loudly to 5,000 generated rows.
- `switchcore/runner.py`: runs inside the sandbox. It reads a `BatchRequest` on stdin and prints one `BatchResult`. `--probe` runs the isolation probe.
- `sandbox_host/app.py`: FastAPI with token auth. Every `/batch`, `/job` and `/probe` call gets a fresh `docker run --runtime=runsc --network=none --read-only --cap-drop=ALL ...` container, and its removal is verified with `docker ps -a`.

## Run

```bash
python -m pytest tests/core -q
python -m switchcore.runner tests/core/fixtures/demo_batch.json      # demo case -> regression
SANDBOX_MODE=local SANDBOX_TOKEN=dev python -m uvicorn sandbox_host.app:app --port 9000
curl -X POST localhost:9000/batch -H "X-SwitchProof-Token: dev" -H "Content-Type: application/json" -d @tests/core/fixtures/demo_batch.json
```

gVisor mode (VM #2): install runsc (see `infra/setup_sandbox_host.sh`), then `docker build -f sandbox_host/Dockerfile.runner -t switchproof-runner:latest .` and start the host with `SANDBOX_MODE=gvisor`.

Real TabFormer data: download Kaggle `ealtman2019/credit-card-transactions` (this needs `~/.kaggle/kaggle.json`), then set `TABFORMER_CSV=data/card_transaction.v1.csv`.
