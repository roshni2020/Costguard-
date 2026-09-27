#!/usr/bin/env bash
# Publish a read-only recording of a run as the public demo URL.
#  - Vultr Object Storage (default when VULTR_S3_* is set in /etc/switchproof.env): run on sp-control
#  - otherwise GitHub Pages (gh-pages branch)
# Usage: bash infra/publish_snapshot.sh <run_id> [http://127.0.0.1:8000]
set -euo pipefail
RUN_ID="${1:?usage: publish_snapshot.sh <run_id> [base_url]}"
if [ -r /etc/switchproof.env ]; then set -a; . /etc/switchproof.env; set +a; fi
if [ -n "${VULTR_S3_BUCKET:-}" ] && [ -n "${VULTR_S3_ACCESS_KEY:-}" ]; then
  cd "$(dirname "$0")/.."
  echo "==> publishing $RUN_ID to Vultr Object Storage bucket $VULTR_S3_BUCKET"
  URL="$(${PYTHON:-.venv/bin/python} -m control_plane.objstore publish "$RUN_ID")"
  echo "==> public demo URL: $URL"
  exit 0
fi
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
