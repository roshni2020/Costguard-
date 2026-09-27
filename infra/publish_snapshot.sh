#!/usr/bin/env bash
# Publish a read-only recording of a run to GitHub Pages (gh-pages branch).
# Usage: bash infra/publish_snapshot.sh <run_id> [http://127.0.0.1:8000]
# Result: https://<owner>.github.io/<repo>/?snapshot=export.json
set -euo pipefail
RUN_ID="${1:?usage: publish_snapshot.sh <run_id> [base_url]}"
BASE="${2:-${BASE_URL:-http://127.0.0.1:8000}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${REMOTE:-$(git -C "$ROOT" remote get-url origin)}"
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT

echo "==> exporting $RUN_ID from $BASE"
cp -r "$ROOT/web/." "$OUT/"
curl -fsS -m 60 "$BASE/api/runs/$RUN_ID/export" -o "$OUT/export.json"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('   run', d['run']['id'], d['run']['status'], '|', len(d['results']), 'results |', len(d['events']), 'events')" "$OUT/export.json"
touch "$OUT/.nojekyll"

echo "==> pushing to gh-pages on $REMOTE"
git -C "$OUT" init -q -b gh-pages
git -C "$OUT" add -A
git -C "$OUT" -c user.name="${GIT_AUTHOR_NAME:-switchproof}" -c user.email="${GIT_AUTHOR_EMAIL:-switchproof@users.noreply.github.com}" commit -qm "Snapshot of $RUN_ID"
git -C "$OUT" push -qf "$REMOTE" gh-pages:gh-pages

SLUG="$(printf '%s' "$REMOTE" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
echo "==> done: https://${SLUG%%/*}.github.io/${SLUG#*/}/?snapshot=export.json"
echo "    (enable Pages for the gh-pages branch once in repo Settings > Pages)"
