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


def ns() -> str:
    return os.environ.get("K8S_NAMESPACE", "switchproof-sandbox")


def _client(timeout: float = 30) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=os.environ["K8S_API"].rstrip("/"), timeout=timeout, transport=_transport,
                             headers={"Authorization": f"Bearer {os.environ['K8S_TOKEN']}"},
                             verify=os.environ.get("K8S_CA_FILE") or True)


async def _ok(r: httpx.Response) -> dict:
    if r.status_code >= 300:
        raise RuntimeError(f"Kubernetes {r.request.method} {r.request.url.path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"text": r.text}


def job_manifest(name: str, argv: list[str], timeout_s: int) -> dict:
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
                    {"name": "CONTROL_PLANE_ADDR", "value": os.environ.get("CONTROL_PLANE_ADDR", "10.0.0.1:8000")}],
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
    if os.environ.get("RUNNER_PULL_SECRET"):                # private Vultr Container Registry
        pod["imagePullSecrets"] = [{"name": os.environ["RUNNER_PULL_SECRET"]}]
    labels = {"app.kubernetes.io/part-of": "switchproof-sandbox", "switchproof/sandbox": name}
    return {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "labels": labels},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": timeout_s, "ttlSecondsAfterFinished": 300,
                     "template": {"metadata": {"labels": labels}, "spec": pod}}}


async def run(argv: list[str], stdin: str, timeout_s: int) -> tuple[dict, str, bool]:
    """Runs `python <argv> /input/input.json` in a fresh gVisor pod. Returns (last stdout JSON line, sandbox id, destroyed)."""
    name = f"sp-{uuid.uuid4().hex[:10]}"
    base = f"/api/v1/namespaces/{ns()}"
    jobs = f"/apis/batch/v1/namespaces/{ns()}/jobs"
    async with SEM, _client(timeout_s + 60) as c:
        await _ok(await c.post(f"{base}/configmaps", json={"apiVersion": "v1", "kind": "ConfigMap", "metadata": {
            "name": name, "labels": {"app.kubernetes.io/part-of": "switchproof-sandbox"}}, "data": {"input.json": stdin}}))
        try:
            await _ok(await c.post(jobs, json=job_manifest(name, [*argv, "/input/input.json"], timeout_s)))
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
            return json.loads(lines[-1]), name, await _destroy(c, name)
        except BaseException:
            await _destroy(c, name)
            raise


async def _destroy(c: httpx.AsyncClient, name: str) -> bool:
    base = f"/api/v1/namespaces/{ns()}"
    await c.request("DELETE", f"/apis/batch/v1/namespaces/{ns()}/jobs/{name}", json={"propagationPolicy": "Foreground"})
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
            active = (await _ok(await c.get(f"/apis/batch/v1/namespaces/{ns()}/jobs", params={"labelSelector": LABEL}))).get("items", [])
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
    return {"mode": "kubernetes", "cluster_api": os.environ.get("K8S_API"), "namespace": ns(), "image": os.environ.get("RUNNER_IMAGE"),
            "runtime_class": rc_name or None, "runsc": bool(rc is not None and rc.status_code == 200),
            "kvm": None, "active_sandboxes": sum(1 for j in active if not (j.get("status", {}).get("succeeded") or j.get("status", {}).get("failed"))),
            "nodes": node_list, "hostname": f"VKE · {len(node_list)} node(s)", "uname": ", ".join(filter(None, (n["runtime"] for n in node_list[:1])))}
