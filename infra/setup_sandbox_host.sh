#!/usr/bin/env bash
# SwitchProof sandbox host (VM #2, sp-sandbox) on Ubuntu 24.04. Idempotent: safe to re-run.
# Usage: sudo REPO_URL=https://github.com/<you>/switchproof.git CONTROL_IP=<sp-control VPC IP> bash infra/setup_sandbox_host.sh
set -euo pipefail

REPO_URL="${REPO_URL:?set REPO_URL to the git URL of this repo}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/switchproof}"
ENV_FILE=/etc/switchproof.env
CONTROL_IP="${CONTROL_IP:-}"          # sp-control VPC IP; only it may reach :9000
PRIVATE_IP="${PRIVATE_IP:-$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 \
  | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | grep -v '^172\.17\.' | head -1 || true)}"

log() { printf '\n==> %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -n "$PRIVATE_IP" ] || { echo "could not detect the VPC IP; set PRIVATE_IP=10.x.x.x"; exit 1; }

log "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git python3-venv python3-pip docker.io ufw openssl
systemctl enable --now docker

log "Service user"
id switchproof >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin switchproof
getent group kvm >/dev/null || groupadd --system kvm
usermod -aG docker,kvm switchproof

log "KVM"
if [ -e /dev/kvm ]; then
  chgrp kvm /dev/kvm && chmod 660 /dev/kvm
  echo "/dev/kvm present"
  RUNSC_PLATFORM=kvm
else
  echo "WARNING: /dev/kvm missing (no nested virtualization). gVisor will use the systrap platform instead."
  RUNSC_PLATFORM=systrap
fi

log "gVisor runsc (official apt repo, https://gvisor.dev/docs/user_guide/install/)"
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -y && apt-get install -y runsc
fi
runsc install -- --platform="$RUNSC_PLATFORM"
systemctl restart docker

log "Smoke test: python inside gVisor"
docker run --rm --runtime=runsc python:3.11-slim python -c "import platform;print(platform.uname())"

log "Repo"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" fetch --quiet && git -C "$APP_DIR" checkout --quiet "$BRANCH" && git -C "$APP_DIR" pull --ff-only --quiet
else git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; fi
chown -R switchproof:switchproof "$APP_DIR"

log "Runner image"
(cd "$APP_DIR" && docker build -f sandbox_host/Dockerfile.runner -t switchproof-runner:latest .)

log "Python venv"
sudo -u switchproof python3 -m venv "$APP_DIR/.venv"
sudo -u switchproof "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
sudo -u switchproof "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

log "$ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="${SANDBOX_TOKEN:-$(openssl rand -hex 24)}"
  cat > "$ENV_FILE" <<EOF
SANDBOX_MODE=gvisor
SANDBOX_TOKEN=$TOKEN
RUNNER_IMAGE=switchproof-runner:latest
BIND_IP=$PRIVATE_IP
# the isolation probe tries to reach this address from inside a sandbox (must be BLOCKED)
CONTROL_PLANE_ADDR=${CONTROL_IP:-10.0.0.1}:8000
EOF
  echo "Generated SANDBOX_TOKEN. Copy it to sp-control's $ENV_FILE:"
  echo "  SANDBOX_TOKEN=$TOKEN"
else
  echo "$ENV_FILE exists; left unchanged"
fi
chown root:switchproof "$ENV_FILE" && chmod 640 "$ENV_FILE"

log "Host firewall (VPC side): only sp-control may reach :9000"
ufw allow OpenSSH >/dev/null
if [ -n "$CONTROL_IP" ]; then
  ufw allow from "$CONTROL_IP" to any port 9000 proto tcp >/dev/null
  ufw allow in on wt0 to any port 9000 proto tcp >/dev/null   # NetBird path; the NetBird access policy narrows sources
  ufw --force enable >/dev/null && ufw status | sed 's/^/  /'
else
  echo "WARNING: CONTROL_IP not set; ufw left unchanged. Re-run with CONTROL_IP=<sp-control VPC IP>."
fi

log "systemd"
install -m 644 "$APP_DIR/infra/systemd/switchproof-sandbox.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable switchproof-sandbox
systemctl restart switchproof-sandbox
sleep 2
systemctl --no-pager --lines=5 status switchproof-sandbox || true

log "Done. Sandbox API: http://$PRIVATE_IP:9000 (header X-SwitchProof-Token). Next: install NetBird (infra/netbird.md)."
