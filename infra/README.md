# Deploying SwitchProof on Vultr

This is the step-by-step guide to putting SwitchProof on Vultr: what to create in the Vultr console, then which script to run for each piece. No Docker runs on any VM. The test sandboxes run as Kubernetes Jobs on **Vultr Kubernetes Engine**.

```
 Judges ──HTTPS──▶ NetBird reverse proxy (SSO for testers, PIN for judges)   ← no open ports on Vultr
                          │ WireGuard
                          ▼
   sp-control  (Vultr Compute VX1, Ubuntu 24.04)
     FastAPI control plane + agents + web UI      ──▶ Vultr Serverless Inference (laguna-s-2.1)
     SQLite + TabFormer on Vultr Block Storage    ──▶ Vultr Object Storage (evidence bundles, public demo page)
     namespace-scoped token                        ──▶ GitHub (issue + release gate)
                          │ Kubernetes API (TLS)
                          ▼
   Vultr Kubernetes Engine (node pool: 2 × VX1)
     agent-pool VM → namespace switchproof-agent: agent-written tests, 1 Job per batch
     data-pool  VM → namespace switchproof-data : replay data only, never agent code
     both: gVisor RuntimeClass · no network · read-only root · no credentials · deleted after the batch
     image pulled from Vultr Container Registry
```

| Vultr product | What it does here | Rough cost |
|---|---|---|
| Compute (VX1 `vx1-g-2c-8g-120s`) | `sp-control`: control plane, agents, UI | $0.076/h |
| Kubernetes Engine | Sandbox cluster: `agent-pool` + `data-pool`, 1 VX1 node each (the control plane is included) | 2 nodes × $0.06/h |
| Serverless Inference | The LLM behind every agent (`laguna-s-2.1`, the cheapest model with tool calling) | ~$0.18 / 1M output tokens |
| Container Registry | Stores the sandbox runner image | small |
| Object Storage | Evidence bundle per run; hosts the public demo page | a few $/month, hourly |
| Block Storage (40 GB) | Database + the 2.3 GB IBM TabFormer dataset on `sp-control` | ~$1/month, hourly |
| VPC | Private network for the VM and the cluster nodes | free |

Weekend total: roughly $15–25. **Destroy everything after judging.**

---

## Part A: create things in the Vultr console

Put everything in the **same region** (for example Atlanta).

**A1. VPC.** Network → VPC Networks → *Add VPC Network*. Name it `sp-vpc`.

**A2. Control-plane VM.** Compute → Deploy → **Dedicated CPU → VX1 → `vx1-g-2c-8g-120s`** (it has a built-in 120 GB disk; the plain `vx1-g-2c-8g` needs a separate bootable volume). Under Boot Configuration choose **Local Storage**, then image **Ubuntu 24.04 LTS x64**. Attach **`sp-vpc`** (Additional Features → VPC Network), add your SSH key, hostname `sp-control`. Automatic backups and DDoS protection can stay off. If it shows *Stopped* after creation, click ••• → Start. Note its **public IP**.

**A3. Firewall.** Network → Firewall → *Add Firewall Group* `sp-fw`:
- SSH `22/tcp` from **your IP only** (`x.x.x.x/32`).
- **Nothing else.** No 80, 443, 8000. NetBird needs no inbound rule.
- Attach it to `sp-control` (Linked Instances tab).

**A4. Kubernetes cluster.** Kubernetes → *Add Cluster*: name `sp-sandboxes`, latest version, same region, VPC `sp-vpc`. Create **two node pools**, each **1 × VX1 `vx1-g-2c-8g`** (auto-scaler max 3 if offered):
- `agent-pool`: runs the tests the AI agents wrote
- `data-pool`: runs the transaction replay data, and never any agent-written code

Separate pools mean separate Vultr VMs. Even if agent code escaped its gVisor sandbox, it would be on a different machine from the data. When the cluster is *Running*, click **Download Configuration** to get the kubeconfig file (`vke-….yaml`).

**A5. Container Registry.** Container Registry → *Add*, name `switchproof`, same region. Note the **registry URL** (like `sjc.vultrcr.com/switchproof`), **username** and **password/API key**.

**A6. Object Storage.** Storage → Object Storage → *Add*, same region (or the nearest offered). Copy the **hostname**, **access key** and **secret key**. The app creates its own bucket.

**A7. Block Storage.** Storage → Block Storage → *Add*, **40 GB**, same region → *Attach* to `sp-control`.

**A8. Serverless Inference.** Products → Serverless → Inference → *Add Serverless Inference* → give it a label, acknowledge the charges. Open it and copy the **API Key**. This is *not* the subscription ID at the top of the page.

**A9. GitHub.** Code lives at your repo (`https://github.com/roshni2020/Costguard-`). Settings → Secrets and variables → Actions → add:
- `VCR_REGISTRY` = registry URL from A5
- `VCR_USERNAME`, `VCR_PASSWORD` = its credentials

Then Actions → **runner-image** → *Run workflow*. It builds the sandbox image in GitHub's CI and pushes it to your Vultr registry (`<registry>/switchproof-runner:latest`).

Optional, for the GitHub issue + release gate: a fine-grained token with *Issues* and *Commit statuses* on the repo.

**A10. NetBird.** Create a free account at app.netbird.io. Follow [netbird.md](netbird.md) §1 (groups, setup key, *Enable Peer Expose*).

---

## Part B: set up the software (SSH into `sp-control`)

```bash
ssh root@<sp-control public IP>
git clone https://github.com/roshni2020/Costguard-.git /opt/switchproof && cd /opt/switchproof
```

**B1. Control plane** (Python, service user, systemd):

```bash
sudo REPO_URL=https://github.com/roshni2020/Costguard-.git \
  VULTR_INFERENCE_API_KEY=<A8 key> LLM_MODEL=laguna-s-2.1 \
  VULTR_S3_ENDPOINT=https://<A6 hostname> VULTR_S3_ACCESS_KEY=<A6> VULTR_S3_SECRET_KEY=<A6> VULTR_S3_BUCKET=switchproof-roshni \
  GITHUB_TOKEN=<optional> GITHUB_REPO=roshni2020/Costguard- \
  NETBIRD_SETUP_KEY=<A10 setup key> \
  bash infra/setup_control_plane.sh
```

**B2. Block Storage.** Formats the blank volume, mounts it, moves the database onto it, downloads TabFormer:

```bash
sudo bash infra/setup_block_storage.sh
```

**B3. Kubernetes sandboxes.** Copy the kubeconfig from A4 to the VM first (`scp vke-*.yaml root@<ip>:/root/vke.yaml`), then:

```bash
sudo KUBECONFIG=/root/vke.yaml \
  RUNNER_IMAGE=<A5 registry URL>/switchproof-runner:latest \
  AGENT_POOL=agent-pool DATA_POOL=data-pool \
  VCR_HOST=<registry host, e.g. sjc.vultrcr.com> VCR_USERNAME=<A5> VCR_PASSWORD=<A5> \
  bash infra/setup_vke.sh
```

This script:
1. installs gVisor on every node (`infra/k8s/gvisor-installer.yaml`);
2. creates **two** locked sandbox namespaces, `switchproof-agent` and `switchproof-data` (`infra/k8s/sandbox.yaml`: RuntimeClass `gvisor`, *restricted* pod security, quota, deny-all NetworkPolicy, a dispatcher account that can only manage Jobs there), pinned to their own node pools;
3. proves a pod really runs under gVisor (kernel `4.4.0` inside);
4. hands the control plane a namespace-scoped token.

**B4. NetBird.** Zero open ports, SSO/PIN roles, reviewer links:

```bash
sudo bash infra/setup_netbird_control.sh
```

Then create the Reverse Proxy service in the NetBird dashboard: [netbird.md](netbird.md) §3.

## Part C: check before the demo

```bash
bash infra/preflight.sh
```

It prints PASS/FAIL for each item: inference reachable, Vultr instance metadata, Block Storage, Object Storage, Kubernetes API, gVisor RuntimeClass, nodes ready, and the isolation probe run as a real gVisor Job (7 attacks, all must say BLOCKED).

## Part D: public demo URL

- **Live:** the NetBird reverse-proxy URL (PIN for judges).
- **Recorded copy on Vultr:** after a finished run, `bash infra/publish_snapshot.sh <run_id>` prints `https://<hostname>/<bucket>/site/index.html?snapshot=export.json`.

## Files

| File | Purpose |
|---|---|
| `setup_control_plane.sh` | sp-control: packages, venv, `/etc/switchproof.env`, systemd, NetBird install |
| `setup_block_storage.sh` | Mount Block Storage, move data onto it, download TabFormer |
| `setup_vke.sh` + `k8s/*.yaml` | Sandbox cluster: gVisor, namespace hardening, dispatcher token |
| `setup_netbird_control.sh`, `netbird.md` | NetBird: ufw on `wt0`, peer-status timer, reverse proxy + roles |
| `preflight.sh` | Pre-demo PASS/FAIL checklist |
| `publish_snapshot.sh` | Public read-only demo page on Object Storage |
| `systemd/switchproof-control.service` | The control plane service (unprivileged user) |
| `../.github/workflows/runner-image.yml` | Builds the runner image in CI and pushes it to Vultr Container Registry |

Honest notes: VKE doesn't ship gVisor, so the installer DaemonSet adds it to each node's containerd; if a node upgrade removes it, re-run `setup_vke.sh`. Deny-all networking depends on the cluster CNI enforcing NetworkPolicy, and the isolation probe proves it on the real cluster. For local development, `sandbox_host/` still runs tests as plain processes (`SANDBOX_MODE=local`), which is clearly marked *local-unsafe*.
