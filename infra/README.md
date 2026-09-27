# Deploying SwitchProof on Vultr

Two VMs on one private VPC. Nothing listens on a public app port.

| VM | Plan | Runs | Listens on |
| --- | --- | --- | --- |
| `sp-control` | VX1, Ubuntu 24.04 | FastAPI control plane, agents, web UI | `127.0.0.1:8000` (or its NetBird IP) |
| `sp-sandbox` | VX1, Ubuntu 24.04 | Sandbox host API + Docker + gVisor `runsc` | `<VPC IP>:9000` only |

The LLM is **Vultr Serverless Inference** (`https://api.vultrinference.com/v1`), called only from `sp-control`.

## 1. Vultr console

1. **VPC**: Network → VPC Networks → *Add VPC* in your region (e.g. `sp-vpc`, `10.10.0.0/24`).
2. **Instances**: Deploy two **VX1** instances, Ubuntu 24.04, same region, both attached to `sp-vpc`. Name them `sp-control` and `sp-sandbox`. Add your SSH key.
3. Note each instance's **VPC IP** (instance → *Settings → IPv4* / VPC section). Below: `CONTROL_IP` and `SANDBOX_IP`.
4. **Firewall group** `sp-fw` (Network → Firewall), attach to both instances:
   - SSH `22/tcp` from **Roshni's IP only** (`x.x.x.x/32`).
   - NetBird: nothing inbound is required (peers connect outbound and use hole punching or relays). Optionally allow `51820/udp` for direct WireGuard paths, per the NetBird docs.
   - **No** rule for 8000 or 9000. The app is never exposed publicly.
5. Vultr firewall groups filter the public interface. The VPC side of `sp-sandbox` is locked by `ufw`, which the setup script configures: port `9000/tcp` is allowed **only from `CONTROL_IP`** (and from the NetBird interface, which the NetBird policy narrows further).
6. **Serverless Inference**: Products → Serverless Inference → create a subscription and copy the **API key** (not the subscription ID). We use `laguna-s-2.1`, the cheapest model on the list with tool calling; that value is `LLM_MODEL`.
7. **Object Storage** (evidence archive + public demo page): Storage → Object Storage → *Add*, same region. Open it and copy the **hostname** (e.g. `ewr1.vultrobjects.com`), **access key** and **secret key**. The app creates its bucket itself (default name `switchproof-<something-unique>`, set via `VULTR_S3_BUCKET`).
8. **Block Storage** (SQLite + full TabFormer dataset on `sp-control`): Storage → Block Storage → *Add* ~40 GB in the same region → attach to `sp-control`. Then run `sudo bash infra/setup_block_storage.sh` on it (step 3b).

Cost at the time of writing (check the console): 2 × VX1 2c/8GB ≈ $0.12/hour total, Object Storage and Block Storage a few dollars a month (billed hourly), inference ≈ $0.18 per 1M output tokens. Destroy everything after judging.

## 2. Sandbox host (`sp-sandbox`), first

```bash
ssh root@<sp-sandbox public IP>
git clone <REPO_URL> /opt/switchproof && cd /opt/switchproof
sudo REPO_URL=<REPO_URL> CONTROL_IP=<CONTROL_IP> bash infra/setup_sandbox_host.sh
```

It installs Docker, adds the service user to `kvm`, checks `/dev/kvm`, installs gVisor `runsc` from the official apt repo, runs `runsc install`, restarts Docker, runs a smoke test inside gVisor, builds `switchproof-runner:latest`, creates `/etc/switchproof.env` (**prints a generated `SANDBOX_TOKEN`: copy it**), locks port 9000 with ufw and starts `switchproof-sandbox.service` bound to the VPC IP.

If `/dev/kvm` is missing (no nested virtualization on the plan), gVisor falls back to its `systrap` platform. Isolation still holds, and the UI shows `KVM ✗`.

## 3. Control plane (`sp-control`)

```bash
ssh root@<sp-control public IP>
git clone <REPO_URL> /opt/switchproof && cd /opt/switchproof
sudo REPO_URL=<REPO_URL> \
  VULTR_INFERENCE_API_KEY=<key> LLM_MODEL=<model id> \
  SANDBOX_HOST_URL=http://<SANDBOX_IP>:9000 SANDBOX_TOKEN=<token from step 2> \
  GITHUB_TOKEN=<fine-grained token: issues + commit statuses> GITHUB_REPO=<owner>/<repo> \
  NETBIRD_SETUP_KEY=<key> \
  bash infra/setup_control_plane.sh
```

Add the Object Storage values to `/etc/switchproof.env` (then `systemctl restart switchproof-control`):

```bash
VULTR_S3_ENDPOINT=https://<hostname from step 1.7>
VULTR_S3_ACCESS_KEY=<access key>
VULTR_S3_SECRET_KEY=<secret key>
VULTR_S3_BUCKET=switchproof-<unique>
VULTR_PLAN=vx1-g-2c-8g        # optional: shown on the Infrastructure page
```

Every run's evidence bundle is then archived to `runs/<run_id>/evidence.json` (public-read, synthetic data only) and linked from the GitHub issue.

### 3b. Block Storage (`sp-control`)

```bash
sudo bash infra/setup_block_storage.sh     # formats a blank /dev/vdb, mounts it, moves data/ onto it, downloads TabFormer
```

Then join `sp-sandbox` to NetBird too and set the access policy: see [netbird.md](netbird.md).

## 4. Check before the demo

```bash
bash infra/preflight.sh            # on sp-control: PASS/FAIL per line, exit 1 on any FAIL
```

## 5. Public demo URL (recorded run)

```bash
bash infra/publish_snapshot.sh <run_id>   # on sp-control
# with Object Storage configured → https://<hostname>/<bucket>/site/index.html?snapshot=export.json  (hosted on Vultr)
# otherwise → gh-pages: https://<owner>.github.io/<repo>/?snapshot=export.json
```

## Files

- `setup_sandbox_host.sh`, `setup_control_plane.sh`: idempotent, safe to re-run (they `git pull` and restart).
- `systemd/switchproof-sandbox.service`, `systemd/switchproof-control.service`: run as the unprivileged `switchproof` user with `EnvironmentFile=/etc/switchproof.env` (mode 640).
- `setup_block_storage.sh`, `preflight.sh`, `publish_snapshot.sh`, `netbird.md`.

Honest caveat: the sandbox service user is in the `docker` group, which is root-equivalent on `sp-sandbox`. That is why the sandbox API sits on its own VM, needs a token, and is reachable only from `sp-control`. Agent-written code only ever runs inside `runsc` containers with `--network none` and a read-only root.
