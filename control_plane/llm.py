"""Vultr Serverless Inference client (OpenAI-compatible). LLM_OFFLINE=1 -> agents use deterministic templates."""
from __future__ import annotations
import json
import logging
import os
import time
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from control_plane.events import emit

log = logging.getLogger("switchproof.llm")
T = TypeVar("T", bound=BaseModel)
reachable: bool | None = None          # set by check_models() at startup
available_models: list[str] = []


def offline() -> bool:
    return os.environ.get("LLM_OFFLINE") == "1"


def base_url() -> str:
    return os.environ.get("LLM_BASE_URL", "https://api.vultrinference.com/v1").rstrip("/")


def model_for(agent: str) -> str:
    default = os.environ.get("LLM_MODEL", "kimi-k2-instruct")
    return os.environ.get(f"LLM_MODEL_{agent.upper()}", default)


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ.get('VULTR_INFERENCE_API_KEY', '')}"}


async def check_models() -> None:
    """Log what Vultr serves; complain loudly if LLM_MODEL is not one of them."""
    global reachable, available_models
    if offline():
        reachable = False
        return
    async with httpx.AsyncClient(timeout=15) as c:
        for path in ("/chat/models", "/models"):
            try:
                r = await c.get(base_url() + path, headers=_headers())
                if r.status_code == 200:
                    body = r.json()
                    items = body.get("data", body) if isinstance(body, dict) else body
                    available_models = [m.get("id", str(m)) if isinstance(m, dict) else str(m) for m in items]
                    reachable = True
                    log.info("Vultr inference models: %s", available_models)
                    for agent in ("coordinator", "generator", "triage", "planner", "reporter"):
                        if model_for(agent) not in available_models:
                            log.error("model %r (agent %s) not in Vultr list %s", model_for(agent), agent, available_models)
                    return
            except (httpx.HTTPError, ValueError) as e:
                log.warning("GET %s failed: %s", path, e)
    reachable = False


def _cut(s: str, n: int = 4096) -> str:
    return s if len(s) <= n else s[:n] + "…[truncated]"


async def chat(run_id: str, agent: str, messages: list[dict], tools: list[dict] | None = None,
               loop_iter: int | None = None, temperature: float = 0.2) -> dict:
    """One chat completion. Emits an llm_call event with the real model id, tokens and latency. Returns the message."""
    model = model_for(agent)
    body: dict = {"model": model, "messages": messages, "temperature": temperature}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(base_url() + "/chat/completions", headers=_headers(), json=body)
    latency = int((time.perf_counter() - t0) * 1000)
    if r.status_code != 200:
        raise RuntimeError(f"Vultr inference HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    msg = data["choices"][0]["message"]
    usage = data.get("usage") or {}
    tin, tout = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
    reply = msg.get("content") or json.dumps(msg.get("tool_calls") or [])
    emit(run_id, agent, "llm_call",
         f"Vultr inference: {data.get('model', model)}, {latency / 1000:.1f} s, {tin + tout:,} tokens",
         {"prompt": _cut(json.dumps(messages, ensure_ascii=False)), "reply": _cut(reply)},
         model=data.get("model", model), tokens_in=tin, tokens_out=tout, latency_ms=latency, loop_iter=loop_iter)
    return msg


def extract_json(text: str):
    """First JSON object/array in the reply (models like to wrap it in ``` fences or prose)."""
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                return dec.raw_decode(text[i:])[0]
            except ValueError:
                continue
    raise ValueError("no JSON found in model reply")


async def complete_json(run_id: str, agent: str, system: str, user: str, model_cls: type[T],
                        max_retries: int = 2, loop_iter: int | None = None) -> T:
    """Ask for JSON only, parse + validate with pydantic; on failure re-prompt with the validation error."""
    messages = [{"role": "system", "content": system + "\nReply with a single JSON object only. No prose."},
                {"role": "user", "content": user}]
    err: Exception | None = None
    for _ in range(max_retries + 1):
        msg = await chat(run_id, agent, messages, loop_iter=loop_iter)
        content = msg.get("content") or ""
        try:
            return model_cls.model_validate(extract_json(content))
        except (ValueError, ValidationError) as e:
            err = e
            emit(run_id, agent, "warning", f"Model reply did not validate, re-prompting: {str(e)[:200]}", loop_iter=loop_iter)
            messages += [{"role": "assistant", "content": content},
                         {"role": "user", "content": f"That did not validate: {str(e)[:1500]}\nReturn corrected JSON only."}]
    raise RuntimeError(f"{agent}: model never produced valid JSON: {err}")
