"""NetBird: identity/roles from the reverse proxy, peer status for the Infrastructure page, lifecycle-bound review links.

Env:
  AUTH_MODE=netbird          trust X-NetBird-User / X-NetBird-Groups (injected by the NetBird reverse proxy, which strips
                             client-supplied copies). Only enable when port 8000 is reachable solely via NetBird.
  NETBIRD_TESTER_GROUP       group allowed to approve/run/decide (default "testers"); everyone else is a read-only viewer
  NETBIRD_PUBLIC_URL         the reverse-proxy URL, shown in the UI
  NETBIRD_EXPOSE=1           allow `netbird expose` review links (Settings > Clients > Enable Peer Expose in the dashboard)
  NETBIRD_STATUS_FILE        fallback JSON written by a root timer when the CLI socket is not readable by our user
"""
from __future__ import annotations
import asyncio
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from urllib.parse import urlparse

from fastapi import HTTPException, Request

from control_plane.events import emit

NETBIRD_RANGE = ipaddress.ip_network("100.64.0.0/10")


def tester_group() -> str:
    return os.environ.get("NETBIRD_TESTER_GROUP", "testers")


def me(request: Request) -> dict:
    if os.environ.get("AUTH_MODE") != "netbird":
        return {"auth": "none", "user": None, "groups": [], "role": "tester", "can_act": True}
    user = request.headers.get("x-netbird-user") or None
    groups = [g.strip() for g in request.headers.get("x-netbird-groups", "").split(",") if g.strip()]
    tester = tester_group() in groups
    return {"auth": "netbird", "user": user, "groups": groups, "role": "tester" if tester else "viewer", "can_act": tester}


def require_tester(request: Request) -> dict:
    """FastAPI dependency for every state-changing route."""
    m = me(request)
    if not m["can_act"]:
        raise HTTPException(403, f"Your NetBird role '{m['role']}' is read-only. Approvals, runs and decisions need "
                                 f"the '{tester_group()}' group (sign in with NetBird SSO).")
    return m


# --- peer status --------------------------------------------------------------------------------------------------
_cache: tuple[float, dict] = (0.0, {})


def _ms(v) -> float | None:
    if isinstance(v, (int, float)):
        return round(v / 1e6, 2)                      # Go time.Duration in nanoseconds
    m = re.match(r"([\d.]+)\s*(ns|µs|us|ms|s)?$", str(v or "").strip())
    if not m:
        return None
    return round(float(m.group(1)) * {"ns": 1e-6, "µs": 1e-3, "us": 1e-3, "ms": 1, "s": 1000, None: 1}[m.group(2)], 2)


def _raw_status() -> dict | None:
    if shutil.which("netbird"):
        try:
            p = subprocess.run(["netbird", "status", "--json"], capture_output=True, text=True, timeout=5)
            if p.returncode == 0:
                return json.loads(p.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
    try:
        with open(os.environ.get("NETBIRD_STATUS_FILE", "/run/switchproof/netbird.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def status() -> dict:
    global _cache
    if time.time() - _cache[0] < 10:
        return _cache[1]
    host = urlparse(os.environ.get("SANDBOX_HOST_URL", "")).hostname or ""
    try:
        via = ipaddress.ip_address(host) in NETBIRD_RANGE
    except ValueError:
        via = host.endswith(".netbird.cloud") or host.endswith(".netbird.selfhosted")
    s = _raw_status()
    # installed but not logged in (daemonStatus NeedsLogin) must not show as NetBird-protected
    connected = bool(s) and ((s.get("management") or {}).get("connected") is True or s.get("daemonStatus") == "Connected")
    out = {"available": connected, "public_url": os.environ.get("NETBIRD_PUBLIC_URL"), "sandbox_via_netbird": via, "peers": [],
           "daemon": (s or {}).get("daemonStatus")}
    if connected:
        details = (s.get("peers") or {}).get("details") or []
        out.update(ip=(s.get("netbirdIp") or "").split("/")[0] or None, fqdn=s.get("fqdn"), peers=[
            {"fqdn": p.get("fqdn"), "ip": (p.get("netbirdIp") or "").split("/")[0] or None, "status": p.get("status"),
             "connection_type": p.get("connectionType"), "latency_ms": _ms(p.get("latency"))} for p in details])
    _cache = (time.time(), out)
    return out


# --- lifecycle-bound review links (netbird expose) ----------------------------------------------------------------
_shares: dict[str, dict] = {}


def share(run_id: str, show_pin: bool) -> dict:
    s = _shares.get(run_id)
    if not s or s["proc"].returncode is not None:
        return {"active": False}
    return {"active": True, "url": s["url"], "pin": s["pin"] if show_pin else None, "expires": "when the decision is recorded"}


async def open_share(run_id: str) -> dict:
    if share(run_id, True)["active"]:
        return share(run_id, True)
    if os.environ.get("NETBIRD_EXPOSE") != "1" or not shutil.which("netbird"):
        raise HTTPException(503, "NetBird expose is not available here (install NetBird, set NETBIRD_EXPOSE=1, "
                                 "enable Peer Expose in the NetBird dashboard)")
    pin = f"{secrets.randbelow(10 ** 6):06d}"
    proc = await asyncio.create_subprocess_exec(
        "netbird", "expose", os.environ.get("NETBIRD_EXPOSE_PORT", "8000"), "--with-pin", pin,
        "--with-name-prefix", f"review-{run_id.removeprefix('run-')}",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    url, seen = None, []
    try:
        async with asyncio.timeout(30):
            while url is None:
                line = (await proc.stdout.readline()).decode(errors="replace")
                if not line:
                    break
                seen.append(line.strip())
                m = re.search(r"https://\S+", line)
                url = m.group(0).rstrip(".,)") if m else None
    except TimeoutError:
        pass
    if url is None:
        proc.kill()
        raise HTTPException(502, f"netbird expose did not print a URL: {' | '.join(seen)[-300:]}")

    async def drain():                     # keep reading so the pipe never fills and blocks the CLI
        while await proc.stdout.readline():
            pass
    _shares[run_id] = {"proc": proc, "url": url, "pin": pin, "drain": asyncio.create_task(drain())}
    emit(run_id, "system", "info", f"Temporary reviewer link opened with netbird expose (PIN-protected): {url}. "
         "It is removed automatically when the decision is recorded.", {"url": url})
    return share(run_id, True)


async def close_share(run_id: str, reason: str) -> None:
    s = _shares.pop(run_id, None)
    if s and s["proc"].returncode is None:
        s["proc"].terminate()
        try:
            await asyncio.wait_for(s["proc"].wait(), 10)
        except TimeoutError:
            s["proc"].kill()
        emit(run_id, "system", "info", f"Reviewer link {s['url']} closed ({reason}); the NetBird service no longer exists.")
