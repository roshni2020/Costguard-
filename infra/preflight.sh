#!/usr/bin/env bash
# Pre-demo check against a running control plane. Prints PASS/FAIL per line; exits 1 on any FAIL.
# Usage: bash infra/preflight.sh [http://127.0.0.1:8000]
set -uo pipefail
BASE="${1:-${BASE_URL:-http://127.0.0.1:8000}}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

curl -fsS -m 20 "$BASE/api/system" -o "$TMP/system.json" || { echo "FAIL  GET $BASE/api/system"; exit 1; }
curl -fsS -m 120 -X POST "$BASE/api/system/probe" -o "$TMP/probe.json" || echo '{}' > "$TMP/probe.json"

python3 - "$TMP/system.json" "$TMP/probe.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); p = json.load(open(sys.argv[2]))
sb, llm = s.get("sandbox_host") or {}, s.get("llm") or {}
fails = 0
def line(ok, msg):
    global fails
    fails += not ok
    print(("PASS  " if ok else "FAIL  ") + msg)
line(llm.get("reachable") is True, f"LLM reachable: {llm.get('model')} at {llm.get('base_url')}")
line("error" not in sb, f"sandbox host reachable: {sb.get('hostname', sb.get('error'))}")
line(sb.get("kvm") is True, "sandbox host has /dev/kvm")
line(sb.get("runsc") is True, "sandbox host has gVisor runsc")
line(sb.get("mode") == "gvisor", f"sandbox mode is gvisor (got {sb.get('mode')})")
line(sb.get("active_sandboxes") == 0, f"no sandboxes left running (active: {sb.get('active_sandboxes')})")
proof = p.get("proof") or {}
line(proof.get("runtime") == "runsc", f"probe ran under runsc: {proof.get('uname', 'no probe result')}")
for c in p.get("checks", []):
    line(c.get("outcome") == "BLOCKED", f"probe {c.get('name')}: {c.get('outcome')} ({c.get('attempted')})")
line(bool(p.get("checks")), "probe returned checks")
line(p.get("destroyed") is True, "probe sandbox destroyed")
sys.exit(1 if fails else 0)
PY
