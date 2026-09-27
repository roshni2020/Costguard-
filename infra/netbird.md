# NetBird: zero open ports, gated access, P2P mesh, lifecycle-bound links

SwitchProof uses all four approaches from the Zero-Port Access bonus:

| # | Approach | How we use it | Proof for judges |
|---|---|---|---|
| 1 | **No open ports** | The public demo URL is a **NetBird Reverse Proxy** service targeting `sp-control:8000`. The Vultr firewall group has no rule for 8000 or 9000, and ufw only admits 8000 on the NetBird interface `wt0`. | Screenshot of Reverse Proxy → Services. `curl -m 5 http://<public IP>:8000` times out. |
| 2 | **Gated access matched to roles** | The same service has **SSO restricted to group `testers`** (the payments tester, who may approve, run and block) plus a **PIN** for judges (read-only viewers). The proxy injects `X-NetBird-User` / `X-NetBird-Groups`. The app turns them into roles (`AUTH_MODE=netbird`) and records the SSO identity on the Block decision. | Authentication tab screenshot. The UI chip shows "Tester · NetBird SSO" vs "Viewer · read-only". The decision reads "blocked by you@… (authenticated by NetBird SSO)". |
| 3 | **Peer-to-peer** | The control plane calls the sandbox API over the **NetBird WireGuard mesh** (`SANDBOX_HOST_URL=http://<sp-sandbox NetBird IP>:9000`). An access policy allows only `switchproof-control → switchproof-sandbox` on TCP 9000. | The Infrastructure page's peer table shows `sp-sandbox · P2P · 1.2 ms`, plus `netbird status -d` and the Access Control screenshot. |
| 4 | **Lifecycle-bound URLs** | On the Decision screen, a tester creates a **temporary reviewer link** (for example for a compliance officer): `netbird expose 8000 --with-pin <random>`. It exists only while that run awaits its decision. Clicking Block or Approve kills it, and NetBird removes the service. | The run's event log shows "Reviewer link opened …" and later "… closed (decision recorded)". Opening the old URL fails. |

## 1. Account setup (dashboard, app.netbird.io)

1. **Groups:** `switchproof-control`, `switchproof-sandbox`, `testers` (put your own user in it), `admins`.
2. **Setup key:** reusable, auto-assigning the right group, with one key per VM (or change the group on the peer afterwards).
3. **Settings → Clients → Enable Peer Expose.** Approach 4 needs this. Restrict it to group `switchproof-control`.
4. **Access Control → Policies.** Delete the default *All → All*, then add:

| Policy | Source | Destination | Port |
|---|---|---|---|
| control-to-sandbox | switchproof-control | switchproof-sandbox | TCP 9000 |
| admin-ssh (optional) | admins | switchproof-control, switchproof-sandbox | TCP 22 |

There is no sandbox → control policy. The sandbox containers themselves have `--network none`.

## 2. Join both VMs

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
sudo netbird up --setup-key <SETUP_KEY>
netbird status -d                 # NetBird IP (100.x.y.z), peers, connection type P2P/Relayed
```

**sp-sandbox:** serve the API on the mesh only:

```bash
NB_IP=$(ip -4 -o addr show wt0 | awk '{print $4}' | cut -d/ -f1)
sudo sed -i "s/^BIND_IP=.*/BIND_IP=$NB_IP/" /etc/switchproof.env && sudo systemctl restart switchproof-sandbox
```

**sp-control:** call the sandbox over the mesh, enable roles and review links, and let the root helper publish peer status:

```bash
sudo tee -a /etc/switchproof.env <<EOF
SANDBOX_HOST_URL=http://<sp-sandbox NetBird IP>:9000
AUTH_MODE=netbird
NETBIRD_TESTER_GROUP=testers
NETBIRD_EXPOSE=1
NETBIRD_PUBLIC_URL=https://<your service>.proxy.netbird.io
BIND_IP=0.0.0.0
EOF
sudo bash infra/setup_netbird_control.sh     # ufw: 8000 only on wt0; peer-status timer; restarts the app
```

(If `SANDBOX_HOST_URL`/`BIND_IP` already exist in the file, edit those lines instead of appending.)

If creating a reviewer link returns an error mentioning the daemon socket, the unprivileged `switchproof` user can't reach NetBird. Check `ls -l /var/run/netbird.sock` and `sudo -u switchproof netbird status`. Approaches 1–3 don't depend on this.

## 3. Reverse Proxy service (approaches 1 and 2)

Reverse Proxy → Services → **Add Service**:
- **Details:** HTTP. Subdomain `switchproof`, default domain. Target **Peer** `sp-control`, port **8000**.
- **Authentication:** enable **SSO** restricted to group **testers**, and **PIN Code** (a 6-digit PIN you give to judges). Both methods can be active at once.
- **Access Control:** optionally an IP/country allowlist.
- Save and wait for `active`. Put the URL in `NETBIRD_PUBLIC_URL` and in the README.

Anyone arriving with the PIN is a **viewer**: they can watch the whole run and all evidence, but every state-changing API call returns 403. Signing in with SSO as a member of `testers` makes you a **tester**.

**Trust boundary (be honest if asked):** the app trusts `X-NetBird-*` headers because the proxy strips client-supplied copies and 8000 is closed everywhere except `wt0`. A NetBird *peer* with a policy to `sp-control:8000` could send its own headers, so don't give judges peer access to 8000; the reverse-proxy URL is their way in.

## 4. What judges do

1. Open the public URL. They'll see NetBird's PIN page; enter the PIN from the README or the submission.
2. Watch the live run (read-only).
3. Want to click Approve and Block yourselves? We invite you to the `testers` group via SSO, or Roshni drives while you watch.

## Screenshots to put in the README (judges need to see NetBird use)

- Reverse Proxy → Services: the `switchproof` service, target `sp-control:8000`, status active.
- The service's Authentication tab: SSO (group testers) + PIN.
- Access Control → Policies: `control-to-sandbox` TCP 9000.
- Peers: `sp-control` and `sp-sandbox` connected. `netbird status -d` showing `Connection type: P2P`.
- The SwitchProof Infrastructure page, NetBird card.
- A terminal showing `curl -m 5 http://<sp-control public IP>:8000` → timeout.
