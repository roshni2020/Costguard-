#!/usr/bin/env bash
# sp-control NetBird wiring: port 8000 reachable ONLY on the NetBird interface (wt0) + a root timer that publishes
# `netbird status --json` for the app (the app runs unprivileged and may not read the NetBird daemon socket).
# Usage: sudo bash infra/setup_netbird_control.sh
set -euo pipefail
ip link show wt0 >/dev/null 2>&1 || { echo "wt0 missing: run 'sudo netbird up --setup-key <key>' first"; exit 1; }

echo "==> ufw: SSH + 8000 on wt0 only (Vultr firewall group has no app ports either)"
apt-get install -y ufw >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow in on wt0 to any port 8000 proto tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

echo "==> peer-status timer (every 15 s -> /run/switchproof/netbird.json)"
cat > /etc/systemd/system/switchproof-netbird-status.service <<'EOF'
[Unit]
Description=Publish NetBird peer status for SwitchProof
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mkdir -p /run/switchproof && netbird status --json > /run/switchproof/netbird.json.tmp && chmod 644 /run/switchproof/netbird.json.tmp && mv /run/switchproof/netbird.json.tmp /run/switchproof/netbird.json'
EOF
cat > /etc/systemd/system/switchproof-netbird-status.timer <<'EOF'
[Unit]
Description=Refresh NetBird peer status for SwitchProof
[Timer]
OnBootSec=10
OnUnitActiveSec=15
AccuracySec=1
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now switchproof-netbird-status.timer
systemctl start switchproof-netbird-status.service

echo "==> restart control plane"
systemctl restart switchproof-control
sleep 2
curl -fsS -m 10 http://127.0.0.1:8000/api/system | python3 -c "import sys,json; n=json.load(sys.stdin)['netbird']; print('  netbird:', n.get('ip'), '| peers:', [(p['fqdn'], p['connection_type']) for p in n['peers']], '| sandbox via netbird:', n['sandbox_via_netbird'])"
