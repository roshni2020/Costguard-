#!/usr/bin/env bash
# Wire sp-control to the Vultr Kubernetes Engine cluster that runs the sandboxes.
# Run ON sp-control after setup_control_plane.sh. Needs the cluster kubeconfig (Vultr console -> Kubernetes -> your
# cluster -> Download Configuration) copied to the VM, e.g. /root/vke.yaml.
# Usage: sudo KUBECONFIG=/root/vke.yaml RUNNER_IMAGE=sjc.vultrcr.com/<registry>/switchproof-runner:latest \
#             [AGENT_POOL=agent-pool DATA_POOL=data-pool]   (VKE node pool names: agent tests and replay data on separate VMs)
#             [VCR_HOST=sjc.vultrcr.com VCR_USERNAME=... VCR_PASSWORD=...] bash infra/setup_vke.sh
set -euo pipefail
: "${KUBECONFIG:?set KUBECONFIG to the VKE kubeconfig file}"
: "${RUNNER_IMAGE:?set RUNNER_IMAGE to the runner image in Vultr Container Registry}"
export KUBECONFIG
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/switchproof.env
log() { printf '\n==> %s\n' "$*"; }

if ! command -v kubectl >/dev/null; then
  log "Installing kubectl"
  V="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$V/bin/linux/amd64/kubectl" && chmod 755 /usr/local/bin/kubectl
fi
kubectl get nodes -o wide

log "gVisor on every node"
kubectl apply -f "$ROOT/infra/k8s/gvisor-installer.yaml"
kubectl -n gvisor-system rollout status ds/gvisor-installer --timeout=600s
kubectl -n gvisor-system logs -l app=gvisor-installer --tail=3 --prefix || true

log "Two sandbox pools (agent / data): RuntimeClass, restricted pod security, quota, deny-all network, least-privilege dispatcher"
kubectl apply -f "$ROOT/infra/k8s/sandbox.yaml"

if [ -n "${VCR_PASSWORD:-}" ]; then
  log "Pull secret for the private Vultr Container Registry"
  for NS in switchproof-agent switchproof-data; do kubectl -n "$NS" create secret docker-registry vcr --docker-server="${VCR_HOST:?}" \
    --docker-username="${VCR_USERNAME:?}" --docker-password="$VCR_PASSWORD" --dry-run=client -o yaml | kubectl apply -f -
  done
  PULL_SECRET=vcr
fi

PULL_SECRET="${PULL_SECRET:-}"
PS_JSON=""
[ -n "$PULL_SECRET" ] && PS_JSON="\"imagePullSecrets\": [{\"name\": \"$PULL_SECRET\"}],"

log "Smoke test: a pod under gVisor must report kernel 4.4.0 (gVisor's synthetic kernel)"
kubectl -n switchproof-agent delete pod gvisor-smoke --ignore-not-found >/dev/null
kubectl -n switchproof-agent run gvisor-smoke --restart=Never --image="$RUNNER_IMAGE" --overrides="$(cat <<JSON
{"spec": {"runtimeClassName": "gvisor", "automountServiceAccountToken": false,
  $PS_JSON
  "securityContext": {"runAsNonRoot": true, "runAsUser": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
  "containers": [{"name": "gvisor-smoke", "image": "$RUNNER_IMAGE", "command": ["python", "-c", "import platform; print(platform.release())"],
    "securityContext": {"readOnlyRootFilesystem": true, "allowPrivilegeEscalation": false, "capabilities": {"drop": ["ALL"]}}}]}}
JSON
)" >/dev/null
kubectl -n switchproof-agent wait --for=jsonpath='{.status.phase}'=Succeeded pod/gvisor-smoke --timeout=300s
KERNEL="$(kubectl -n switchproof-agent logs gvisor-smoke)"
kubectl -n switchproof-agent delete pod gvisor-smoke >/dev/null
[ "$KERNEL" = "4.4.0" ] && echo "  PASS kernel inside the sandbox: $KERNEL (gVisor)" || { echo "  FAIL kernel inside the sandbox: $KERNEL"; exit 1; }

log "Credentials for the control plane (namespace-scoped token, cluster CA)"
mkdir -p /etc/switchproof
kubectl -n switchproof-agent get secret dispatcher-token -o jsonpath='{.data.ca\.crt}' | base64 -d > /etc/switchproof/k8s-ca.crt
TOKEN="$(kubectl -n switchproof-agent get secret dispatcher-token -o jsonpath='{.data.token}' | base64 -d)"
API="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
touch "$ENV_FILE"
sed -i '/^SANDBOX_BACKEND=/d;/^SANDBOX_HOST_URL=/d;/^K8S_/d;/^RUNNER_IMAGE=/d;/^RUNNER_PULL_SECRET=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
SANDBOX_BACKEND=k8s
K8S_API=$API
K8S_TOKEN=$TOKEN
K8S_CA_FILE=/etc/switchproof/k8s-ca.crt
K8S_NAMESPACE_AGENT=switchproof-agent
K8S_NAMESPACE_DATA=switchproof-data
${AGENT_POOL:+K8S_NODEPOOL_AGENT=$AGENT_POOL}
${DATA_POOL:+K8S_NODEPOOL_DATA=$DATA_POOL}
K8S_RUNTIME_CLASS=gvisor
K8S_MAX_PARALLEL=8
RUNNER_IMAGE=$RUNNER_IMAGE
${PULL_SECRET:+RUNNER_PULL_SECRET=$PULL_SECRET}
EOF
chown root:switchproof /etc/switchproof/k8s-ca.crt "$ENV_FILE" 2>/dev/null || true
chmod 640 /etc/switchproof/k8s-ca.crt "$ENV_FILE"

log "Restart control plane and check"
systemctl restart switchproof-control
sleep 3
curl -fsS -m 20 http://127.0.0.1:8000/api/system | python3 -c "import sys,json; s=json.load(sys.stdin)['sandbox_host']; print('  mode', s.get('mode'), '| runsc', s.get('runsc'), '| nodes', [n['name'] for n in s.get('nodes', [])], s.get('error', ''))"
echo "Next: bash infra/preflight.sh"
