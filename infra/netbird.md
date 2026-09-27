# NetBird: private access, zero public app ports

NetBird puts both VMs (and the people who need the UI) on a WireGuard overlay. Its access policies decide who can reach which port. Nothing on either VM listens on a public app port.

## 1. Install and join (both VMs)

`setup_control_plane.sh` does this on `sp-control`. On `sp-sandbox`, run it by hand:

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
sudo netbird up --setup-key <SETUP_KEY>
netbird status            # shows the peer's NetBird IP (100.x.y.z) and the wt0 interface
```

Create the setup key in the NetBird dashboard (**Setup Keys**, reusable, with auto-assigned groups):
- `sp-control` → group **switchproof-control**
- `sp-sandbox` → group **switchproof-sandbox**

## 2. Access policies (dashboard → Access Control → Policies)

Disable or delete the default *All → All* policy first. Then add:

| Policy | Source | Destination | Protocol / port | Why |
| --- | --- | --- | --- | --- |
| control-to-sandbox | switchproof-control | switchproof-sandbox | TCP 9000 | Only the control plane may call the sandbox API |
| judges-to-ui | judges | switchproof-control | TCP 8000 | People who review the demo see the UI, nothing else |
| admin-ssh (optional) | admins | both | TCP 22 | SSH over the overlay instead of the public IP |

Nothing may reach `sp-control` from `sp-sandbox`: there is no sandbox → control policy. The sandbox containers themselves have no network at all (`--network none`).

To make the sandbox API use the overlay, set `BIND_IP=<sp-sandbox NetBird IP>` in `sp-sandbox:/etc/switchproof.env`, set `SANDBOX_HOST_URL=http://<sp-sandbox NetBird IP>:9000` on `sp-control`, then restart both services. With the default VPC binding, the VPC path is locked by ufw to `CONTROL_IP`, and NetBird carries the human traffic.

## 3. Expose the UI to judges without an inbound port

The control plane binds `127.0.0.1:8000` by default. To serve it on the overlay:

```bash
NB_IP=$(ip -4 -o addr show wt0 | awk '{print $4}' | cut -d/ -f1)
sudo sed -i "s/^BIND_IP=.*/BIND_IP=$NB_IP/" /etc/switchproof.env
sudo systemctl restart switchproof-control
```

Then pick one:

- **Judges join as peers (works on every NetBird plan).** Invite each judge as a user (or give them a one-off setup key) and put them in group **judges**. They install the NetBird app, log in, and open `http://<sp-control NetBird IP>:8000`. The *judges-to-ui* policy lets them reach port 8000 only.
- **NetBird reverse proxy / service exposure (if your NetBird account has it).** Publish `sp-control:8000` through NetBird with login required. The judge gets an HTTPS link, and still no port is opened on the VM. Follow the current NetBird docs for that feature; the VM-side setup is the same `BIND_IP` change above.

## What a judge does

1. Accept the NetBird invite, install the NetBird client, sign in.
2. Open the URL we send (`http://100.x.y.z:8000` or the NetBird HTTPS link).
3. No NetBird? Use the recorded run: `https://<owner>.github.io/<repo>/?snapshot=export.json` (read-only).

## Show me

- `netbird status -d` on `sp-control`: the peer list shows `sp-sandbox` connected.
- Dashboard → Peers: both VMs with their groups. Access Control shows the three policies above.
- From a laptop not on NetBird: `curl -m 5 http://<sp-control public IP>:8000` times out (no public app port).
