"""Sandboxes on Vultr Kubernetes Engine: one Kubernetes Job per batch, gVisor RuntimeClass, deleted afterwards.

The control plane talks to the Kubernetes API with a ServiceAccount token that can only touch the sandbox namespace
(infra/k8s/sandbox.yaml). Env:
  SANDBOX_BACKEND=k8s
  K8S_API=https://<cluster-id>.vultr-k8s.com:6443   K8S_TOKEN=<dispatcher token>   K8S_CA_FILE=/etc/switchproof/k8s-ca.crt
  K8S_NAMESPACE=switchproof-sandbox   K8S_RUNTIME_CLASS=gvisor   RUNNER_IMAGE=<registry>/switchproof-runner:latest
"""
from __future__ import annotations
import asyncio
import json
import os
import time
import uuid

import httpx

_transport: httpx.AsyncBaseTransport | None = None      # tests inject a fake Kubernetes API here
SEM = asyncio.Semaphore(int(os.environ.get("K8S_MAX_PARALLEL", "8")))
LABEL = "app.kubernetes.io/part-of=switchproof-sandbox"


def enabled() -> bool:
    return os.environ.get("SANDBOX_BACKEND") == "k8s"


POOLS = ("agent", "data")   # agent: LLM/human/triage tests (may carry agent code) | data: dataset replay, never agent code


def ns(pool: str = "agent") -> str:
    return os.environ.get(f"K8S_NAMESPACE_{pool.upper()}", f"switchproof-{pool}")


def node_pool(pool: str) -> str | None:
    """VKE node pool (= separate Vultr VMs) for this sandbox pool, e.g. K8S_NODEPOOL_DATA=data-pool."""
    return os.environ.get(f"K8S_NODEPOOL_{pool.upper()}") or None


def _client(timeout: float = 30) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=os.environ["K8S_API"].rstrip("/"), timeout=timeout, transport=_transport,
                             headers={"Authorization": f"Bearer {os.environ['K8S_TOKEN']}"},
                             verify=os.environ.get("K8S_CA_FILE") or True)


async def _ok(r: httpx.Response) -> dict:
    if r.status_code >= 300:
        raise RuntimeError(f"Kubernetes {r.request.method} {r.request.url.path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"text": r.text}


def job_manifest(name: str, argv: list[str], timeout_s: int, pool: str = "agent") -> dict:
    rc = os.environ.get("K8S_RUNTIME_CLASS", "gvisor")
    pod = {
        "restartPolicy": "Never",
        "automountServiceAccountToken": False,          # the sandbox gets no Kubernetes credentials
        "enableServiceLinks": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
        "containers": [{
            "name": "runner", "image": os.environ.get("RUNNER_IMAGE", "switchproof-runner:latest"),
            "command": ["python", *argv],
            "env": [{"name": "SANDBOX_ID", "value": name}, {"name": "SANDBOX_RUNTIME", "value": "runsc" if rc == "gvisor" else "none"},
                    {"name": "CONTROL_PLANE_ADDR", "value": os.environ.get("CONTROL_PLANE_ADDR", "10.0.0.1:8000")},
                    {"name": "SANDBOX_POOL", "value": pool}],
            "securityContext": {"readOnlyRootFilesystem": True, "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]}},
            "resources": {"limits": {"cpu": "1", "memory": "512Mi"}, "requests": {"cpu": "250m", "memory": "256Mi"}},
            "volumeMounts": [{"name": "input", "mountPath": "/input", "readOnly": True}, {"name": "tmp", "mountPath": "/tmp"}],
        }],
        "volumes": [{"name": "input", "configMap": {"name": name}},
                    {"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"}}],
    }
    if rc:
        pod["runtimeClassName"] = rc
    if node_pool(pool):
        pod["nodeSelector"] = {"vke.vultr.com/node-pool": node_pool(pool)}
    if os.environ.get("RUNNER_PULL_SECRET"):                # private Vultr Container Registry
        pod["imagePullSecrets"] = [{"name": os.environ["RUNNER_PULL_SECRET"]}]
    labels = {"app.kubernetes.io/part-of": "switchproof-sandbox", "switchproof/sandbox": name, "switchproof/pool": pool}
    return {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "labels": labels},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": timeout_s, "ttlSecondsAfterFinished": 300,
                     "template": {"metadata": {"labels": labels}, "spec": pod}}}


async def run(argv: list[str], stdin: str, timeout_s: int, pool: str = "agent") -> tuple[dict, str, bool]:
    """Runs `python <argv> /input/input.json` in a fresh gVisor pod of `pool`. Returns (last stdout JSON line, sandbox id, destroyed)."""
    assert pool in POOLS
    name = f"sp-{pool}-{uuid.uuid4().hex[:8]}"
    base = f"/api/v1/namespaces/{ns(pool)}"
    jobs = f"/apis/batch/v1/namespaces/{ns(pool)}/jobs"
    async with SEM, _client(timeout_s + 60) as c:
        await _ok(await c.post(f"{base}/configmaps", json={"apiVersion": "v1", "kind": "ConfigMap", "metadata": {
            "name": name, "labels": {"app.kubernetes.io/part-of": "switchproof-sandbox"}}, "data": {"input.json": stdin}}))
        try:
            await _ok(await c.post(jobs, json=job_manifest(name, [*argv, "/input/input.json"], timeout_s, pool)))
            deadline = time.monotonic() + timeout_s + 30
            while True:
                st = (await _ok(await c.get(f"{jobs}/{name}"))).get("status", {})
                if st.get("succeeded") or st.get("failed"):
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"sandbox {name} timed out after {timeout_s}s")
                await asyncio.sleep(1)
            pods = (await _ok(await c.get(f"{base}/pods", params={"labelSelector": f"job-name={name}"}))).get("items", [])
            if not pods:
                raise RuntimeError(f"sandbox {name}: pod not found")
            log = (await _ok(await c.get(f"{base}/pods/{pods[0]['metadata']['name']}/log"))).get("text", "")
            lines = [l for l in log.splitlines() if l.strip().startswith("{")]
            if st.get("failed") or not lines:
                raise RuntimeError(f"sandbox {name} failed: {log[-800:]}")
            return json.loads(lines[-1]), name, await _destroy(c, name, pool)
        except BaseException:
            await _destroy(c, name, pool)
            raise


async def _destroy(c: httpx.AsyncClient, name: str, pool: str) -> bool:
    base = f"/api/v1/namespaces/{ns(pool)}"
    await c.request("DELETE", f"/apis/batch/v1/namespaces/{ns(pool)}/jobs/{name}", json={"propagationPolicy": "Foreground"})
    await c.delete(f"{base}/configmaps/{name}")
    for _ in range(30):                                     # destroyed = no pod left for this sandbox
        r = await c.get(f"{base}/pods", params={"labelSelector": f"switchproof/sandbox={name}"})
        if r.status_code == 200 and not r.json().get("items"):
            return True
        await asyncio.sleep(1)
    return False


async def health() -> dict:
    try:
        async with _client(10) as c:
            active = [j for pool in POOLS for j in (await _ok(await c.get(f"/apis/batch/v1/namespaces/{ns(pool)}/jobs",
                                                                        params={"labelSelector": LABEL}))).get("items", [])]
            rc_name = os.environ.get("K8S_RUNTIME_CLASS", "gvisor")
            rc = await c.get(f"/apis/node.k8s.io/v1/runtimeclasses/{rc_name}") if rc_name else None
            nodes = await c.get("/api/v1/nodes")
    except Exception as e:
        return {"error": f"Kubernetes API: {e}", "mode": "kubernetes"}
    node_list = [{"name": n["metadata"]["name"], "pool": n["metadata"].get("labels", {}).get("vke.vultr.com/node-pool"),
                  "ready": any(c["type"] == "Ready" and c["status"] == "True" for c in n.get("status", {}).get("conditions", [])),
                  "kubelet": n.get("status", {}).get("nodeInfo", {}).get("kubeletVersion"),
                  "runtime": n.get("status", {}).get("nodeInfo", {}).get("containerRuntimeVersion"),
                  "cpu": n.get("status", {}).get("capacity", {}).get("cpu"), "memory": n.get("status", {}).get("capacity", {}).get("memory")}
                 for n in (nodes.json().get("items", []) if nodes.status_code == 200 else [])]
    return {"mode": "kubernetes", "cluster_api": os.environ.get("K8S_API"), "namespace": ns("agent"),
            "pools": {pool: {"namespace": ns(pool), "node_pool": node_pool(pool)} for pool in POOLS},
            "image": os.environ.get("RUNNER_IMAGE"),
            "runtime_class": rc_name or None, "runsc": bool(rc is not None and rc.status_code == 200),
            "kvm": None, "active_sandboxes": sum(1 for j in active if not (j.get("status", {}).get("succeeded") or j.get("status", {}).get("failed"))),
            "nodes": node_list, "hostname": f"VKE · {len(node_list)} node(s)", "uname": ", ".join(filter(None, (n["runtime"] for n in node_list[:1])))}
