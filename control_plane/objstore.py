"""Vultr Object Storage (S3-compatible) with stdlib AWS SigV4 - no boto3.

    python -m control_plane.objstore publish <run_id>   # public read-only demo page hosted on Vultr

Env: VULTR_S3_ENDPOINT (e.g. https://ewr1.vultrobjects.com), VULTR_S3_ACCESS_KEY, VULTR_S3_SECRET_KEY,
     VULTR_S3_BUCKET, VULTR_S3_REGION (signing region, default us-east-1).
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


def configured() -> bool:
    return all(os.environ.get(k) for k in ("VULTR_S3_ENDPOINT", "VULTR_S3_ACCESS_KEY", "VULTR_S3_SECRET_KEY", "VULTR_S3_BUCKET"))


def info() -> dict:
    return {"configured": configured(), "endpoint": os.environ.get("VULTR_S3_ENDPOINT"), "bucket": os.environ.get("VULTR_S3_BUCKET")}


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign(method: str, host: str, path: str, headers: dict[str, str], payload_hash: str, amz_date: str,
         region: str, access: str, secret: str) -> str:
    """Authorization header value (AWS Signature Version 4, service s3). `headers` must include host and x-amz-*."""
    hs = {k.lower(): " ".join(v.strip().split()) for k, v in headers.items()}
    signed = ";".join(sorted(hs))
    canonical = "\n".join([method, path, "", "".join(f"{k}:{hs[k]}\n" for k in sorted(hs)), signed, payload_hash])
    scope = f"{amz_date[:8]}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = _hmac(_hmac(_hmac(_hmac(("AWS4" + secret).encode(), amz_date[:8]), region), "s3"), "aws4_request")
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={sig}"


def _request(method: str, key: str, data: bytes = b"", content_type: str | None = None, public: bool = True) -> httpx.Response:
    endpoint = os.environ["VULTR_S3_ENDPOINT"].rstrip("/")
    bucket = os.environ["VULTR_S3_BUCKET"]
    path = f"/{bucket}" + (f"/{quote(key, safe='/-_.~')}" if key else "")
    host = urlparse(endpoint).netloc
    amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    payload_hash = hashlib.sha256(data).hexdigest()
    headers = {"host": host, "x-amz-date": amz_date, "x-amz-content-sha256": payload_hash}
    if public:
        headers["x-amz-acl"] = "public-read"
    if content_type:
        headers["content-type"] = content_type
    headers["authorization"] = sign(method, host, path, headers, payload_hash, amz_date,
                                    os.environ.get("VULTR_S3_REGION", "us-east-1"),
                                    os.environ["VULTR_S3_ACCESS_KEY"], os.environ["VULTR_S3_SECRET_KEY"])
    return httpx.request(method, endpoint + path, headers=headers, content=data, timeout=60)


def public_url(key: str) -> str:
    return f"{os.environ['VULTR_S3_ENDPOINT'].rstrip('/')}/{os.environ['VULTR_S3_BUCKET']}/{quote(key, safe='/-_.~')}"


def ensure_bucket() -> None:
    r = _request("PUT", "", public=False)
    if r.status_code not in (200, 409) and "BucketAlreadyOwnedByYou" not in r.text:
        raise RuntimeError(f"create bucket -> {r.status_code}: {r.text[:300]}")


def put(key: str, data: bytes, content_type: str = "application/json", public: bool = True) -> str:
    r = _request("PUT", key, data, content_type, public)
    if r.status_code >= 300:
        raise RuntimeError(f"PUT {key} -> {r.status_code}: {r.text[:300]}")
    return public_url(key)


def publish_site(export: dict, prefix: str = "site") -> str:
    """Static web/ + export.json -> public bucket. Returns the snapshot URL (the public demo URL)."""
    ensure_bucket()
    web = Path(__file__).resolve().parent.parent / "web"
    for f in web.rglob("*"):
        if f.is_file() and "mock" not in f.relative_to(web).parts:
            put(f"{prefix}/{f.relative_to(web).as_posix()}", f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream"))
    put(f"{prefix}/export.json", json.dumps(export, default=str).encode())
    return public_url(f"{prefix}/index.html") + "?snapshot=export.json"


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "publish":
        raise SystemExit("usage: python -m control_plane.objstore publish <run_id>")
    if not configured():
        raise SystemExit("set VULTR_S3_ENDPOINT, VULTR_S3_ACCESS_KEY, VULTR_S3_SECRET_KEY, VULTR_S3_BUCKET")
    from control_plane.agents.reporter import export_bundle
    print(publish_site(json.loads(json.dumps(export_bundle(sys.argv[2]), default=lambda o: o.model_dump()))))
