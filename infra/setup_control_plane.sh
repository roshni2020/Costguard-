#!/usr/bin/env bash
# SwitchProof control plane (VM #1, sp-control) on Ubuntu 24.04. Idempotent: safe to re-run.
# Usage:
#   sudo REPO_URL=https://github.com/<you>/switchproof.git \
#        VULTR_INFERENCE_API_KEY=... LLM_MODEL=... \
\
#        GITHUB_TOKEN=... GITHUB_REPO=<owner>/<repo> NETBIRD_SETUP_KEY=... \
#        bash infra/setup_control_plane.sh
# Then: infra/setup_block_storage.sh, infra/setup_vke.sh (sandboxes on Vultr Kubernetes), infra/setup_netbird_control.sh
set -euo pipefail

REPO_URL="${REPO_URL:?set REPO_URL to the git URL of this repo}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/switchproof}"
ENV_FILE=/etc/switchproof.env

log() { printf '\n==> %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }

log "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git python3-venv python3-pip

log "Service user"
id switchproof >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin switchproof

log "Repo"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" fetch --quiet && git -C "$APP_DIR" checkout --quiet "$BRANCH" && git -C "$APP_DIR" pull --ff-only --quiet
else git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; fi
chown -R switchproof:switchproof "$APP_DIR"

log "Python venv"
sudo -u switchproof python3 -m venv "$APP_DIR/.venv"
sudo -u switchproof "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
sudo -u switchproof "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

log "$ENV_FILE"
if [ ! -f "$ENV_FILE" ] || [ "${FORCE_ENV:-0}" = 1 ]; then
  cat > "$ENV_FILE" <<EOF
VULTR_INFERENCE_API_KEY=${VULTR_INFERENCE_API_KEY:-}
LLM_BASE_URL=${LLM_BASE_URL:-https://api.vultrinference.com/v1}
LLM_MODEL=${LLM_MODEL:-}
VULTR_S3_ENDPOINT=${VULTR_S3_ENDPOINT:-}
VULTR_S3_ACCESS_KEY=${VULTR_S3_ACCESS_KEY:-}
VULTR_S3_SECRET_KEY=${VULTR_S3_SECRET_KEY:-}
VULTR_S3_BUCKET=${VULTR_S3_BUCKET:-}
VULTR_PLAN=${VULTR_PLAN:-vx1-g-2c-8g-120s}
GITHUB_TOKEN=${GITHUB_TOKEN:-}
GITHUB_REPO=${GITHUB_REPO:-}
GITHUB_SHA=${GITHUB_SHA:-}
BIND_IP=${BIND_IP:-127.0.0.1}
EOF
  echo "wrote $ENV_FILE"
else
  echo "$ENV_FILE exists; left unchanged (FORCE_ENV=1 to rewrite)"
fi
chown root:switchproof "$ENV_FILE" && chmod 640 "$ENV_FILE"
for v in VULTR_INFERENCE_API_KEY LLM_MODEL VULTR_S3_BUCKET; do
  grep -q "^$v=." "$ENV_FILE" || echo "WARNING: $v is empty in $ENV_FILE"
done

log "systemd"
install -m 644 "$APP_DIR/infra/systemd/switchproof-control.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable switchproof-control
systemctl restart switchproof-control
sleep 2
systemctl --no-pager --lines=5 status switchproof-control || true

log "NetBird"
command -v netbird >/dev/null || curl -fsSL https://pkgs.netbird.io/install.sh | sh
if [ -n "${NETBIRD_SETUP_KEY:-}" ]; then netbird up --setup-key "$NETBIRD_SETUP_KEY"; else echo "NETBIRD_SETUP_KEY not set; run: sudo netbird up --setup-key <key>"; fi
netbird status || true

log "Done. App listens on $(grep ^BIND_IP= "$ENV_FILE" | cut -d= -f2):8000 (no public port). Check: bash infra/preflight.sh"
