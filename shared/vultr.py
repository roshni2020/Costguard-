"""'Show me the instance': Vultr instance metadata + where our data lives. Used by both VMs.

The metadata service (169.254.169.254) is reachable from the VM itself but NOT from inside a sandbox
(--network=none) - the isolation probe checks exactly that.
"""
from __future__ import annotations
import json
import os
import shutil
import urllib.request
from functools import lru_cache

METADATA_URL = "http://169.254.169.254/v1.json"


@lru_cache(maxsize=1)
def metadata() -> dict:
    try:
        with urllib.request.urlopen(METADATA_URL, timeout=0.5) as r:
            m = json.load(r)
    except (OSError, ValueError):
        return {"available": False}
    ips = {i.get("network-type"): (i.get("ipv4") or {}).get("address") for i in m.get("interfaces", [])}
    return {"available": True, "instance_id": m.get("instance-v2-id") or m.get("instanceid"),
            "region": (m.get("region") or {}).get("regioncode"), "plan": os.environ.get("VULTR_PLAN"),
            "hostname": m.get("hostname"), "public_ip": ips.get("public"), "private_ip": ips.get("private")}


def storage(path: str) -> dict:
    """Disk behind `path`. Vultr Block Storage attaches as a second virtio disk (/dev/vdb...), the boot disk is /dev/vda."""
    real = os.path.realpath(path or ".")
    os.makedirs(real, exist_ok=True)
    du = shutil.disk_usage(real)
    device = mount = None
    try:
        with open("/proc/mounts") as fh:
            mounts = [l.split()[:2] for l in fh]
        device, mount = max((m for m in mounts if real == m[1] or real.startswith(m[1].rstrip("/") + "/")),
                            key=lambda m: len(m[1]), default=(None, None))
    except OSError:
        pass
    return {"data_dir": real, "device": device, "mount_point": mount, "total_gb": round(du.total / 1e9, 1),
            "free_gb": round(du.free / 1e9, 1),
            "is_block_storage": bool(device and device.startswith("/dev/vd") and not device.startswith("/dev/vda"))}
