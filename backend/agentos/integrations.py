"""External-integration layer — config store, live connection probe, and the
bridge to external agent runtimes (OpenAI, OpenRouter, Hermes, OpenClaw, plus
any private slots from private_slots.json).

Stores per-slot config, tests connectivity for real (httpx), and dispatches
OpenAI-style chat completions over one of four transports:
  * "openai"     -> POST {endpoint}/v1/chat/completions (OpenAI, OpenRouter,
                    Hermes, OpenClaw, and most modern runtimes)
  * "hermes-cli" -> run `hermes -z "<prompt>"` over SSH (Hermes with no HTTP API)
  * "acp"        -> `hermes acp` streaming JSON-RPC session over SSH
  * "codex-cli"  -> run the LOCAL OpenAI Codex CLI (`codex exec`) — auth is the
                    user's ChatGPT sign-in (`codex login`), never an API key
Config CRUD, token handling, health checks, and both the PIP-OS and GRID//OS UIs
are already built around these slots.
"""

import asyncio
import base64
import json
import os
import shutil
import socket
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .db import db
from .events import utcnow

# The configurable integration slots. Detected agent CLIs (claude/codex/...) are
# a separate, read-only concern in environment.py — these are outbound bridges.
INTEGRATION_SLOTS = [
    {"key": "openai", "name": "OpenAI", "icon": "◍", "blurb": "GPT models via your OpenAI API key — chat, reason, drive pipelines"},
    {"key": "codex", "name": "Codex", "icon": "◎", "blurb": "OpenAI Codex agent — signs in with your ChatGPT account, no API key"},
    {"key": "anthropic", "name": "Anthropic", "icon": "✳", "blurb": "Claude over the API — for remote/pipeline calls beside your local Claude"},
    {"key": "gemini", "name": "Gemini", "icon": "✦", "blurb": "Gemini models — one free API key from aistudio.google.com, done"},
    {"key": "openrouter", "name": "OpenRouter", "icon": "⇅", "blurb": "One key, 300+ models (GPT/Claude/Llama/…) — model is provider/name"},
    {"key": "groq", "name": "Groq", "icon": "⚡", "blurb": "LPU-fast open models (Llama, Kimi, …) — lowest-latency turns on the grid"},
    {"key": "deepseek", "name": "DeepSeek", "icon": "🐋", "blurb": "Frontier-cheap reasoning — deepseek-chat and R1-class thinking"},
    {"key": "mistral", "name": "Mistral", "icon": "≋", "blurb": "European frontier lab — Mistral Large & friends via La Plateforme"},
    {"key": "perplexity", "name": "Perplexity", "icon": "🔎", "blurb": "Web-searching Sonar models — answers with live citations"},
    {"key": "xai", "name": "xAI Grok", "icon": "⊗", "blurb": "Grok models via the xAI API key"},
    {"key": "moonshot", "name": "Moonshot", "icon": "🌙", "blurb": "Kimi models (K2) — strong agentic coding from Moonshot AI"},
    {"key": "zai", "name": "Z.ai", "icon": "ℤ", "blurb": "GLM models (GLM-4.6) — Zhipu's coding-strong line"},
    {"key": "qwen", "name": "Qwen", "icon": "❋", "blurb": "Qwen models — paste a Coding Plan key (sk-sp-…) or DashScope key; the endpoint routes itself"},
    {"key": "ollama", "name": "Ollama", "icon": "🦙", "blurb": "Local models on your own metal — no key, no cloud, fully private"},
    {"key": "hermes", "name": "Hermes", "icon": "⚚", "blurb": "Hermes agent runtime — local, LAN, or the Nous portal with a key"},
    {"key": "openclaw", "name": "OpenClaw", "icon": "🦞", "blurb": "Browser-operating agent — hand off web missions"},
]


def _load_private_slots() -> list[dict]:
    """Personal, non-public integration slots. A gitignored private_slots.json —
    in backend/ (dev checkout) or the data dir (installed app) — is appended to
    the slot list at startup, so public releases carry no trace of private
    agents while personal machines keep theirs with a single dropped-in file.
    Format: [{"key": "...", "name": "...", "icon": "...", "blurb": "..."}]"""
    from .config import settings
    from .paths import BACKEND_DIR

    out: list[dict] = []
    seen = {s["key"] for s in INTEGRATION_SLOTS}
    for path in (BACKEND_DIR / "private_slots.json", settings.data_dir / "private_slots.json"):
        try:
            if not path.exists():
                continue
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for r in rows if isinstance(rows, list) else []:
            key = str(r.get("key") or "").strip()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({
                "key": key,
                "name": str(r.get("name") or key.title()),
                "icon": str(r.get("icon") or "◆"),
                "blurb": str(r.get("blurb") or "Private bridged runtime."),
            })
    return out


INTEGRATION_SLOTS += _load_private_slots()
_KEYS = {s["key"] for s in INTEGRATION_SLOTS}

# ---- connection classes -------------------------------------------------------
# Each slot has ONE natural way (sometimes two) to connect. The kind drives which
# fields the UIs render and what save_config will accept — an API provider never
# grows an SSH field, and Codex can't be pointed at a bare HTTP endpoint.
#   "api"    -> hosted HTTP provider: fixed endpoint, needs only an API key
#   "oauth"  -> a local vendor CLI holds a subscription sign-in; no key stored
#   "local"  -> a server on your own metal (Ollama): endpoint, no key
#   "bridge" -> self-hosted agent runtime (Hermes/OpenClaw/private slots): the
#               only kind where SSH (tunnel or CLI/ACP) makes sense
_SLOT_KIND = {
    "openai": "api", "anthropic": "api", "openrouter": "api", "groq": "api",
    "deepseek": "api", "mistral": "api", "perplexity": "api", "xai": "api",
    "moonshot": "api", "zai": "api",
    "codex": "oauth",
    # gemini/qwen OAuth both died vendor-side in 2026 (Code Assist individuals
    # → Antigravity; qwen.ai free tier retired) — an API key is the real path now
    "gemini": "api", "qwen": "api",
    "ollama": "local",
    "hermes": "bridge", "openclaw": "bridge",
}

# Legal transports per slot; the FIRST is the default. Slots not listed get
# ["openai"], except unlisted bridge slots (private_slots.json) which keep the
# full bridge set.
_SLOT_TRANSPORTS = {
    "codex": ["codex-cli"],
    "hermes": ["openai", "hermes-cli", "acp"],
    "openclaw": ["openai"],
}
_BRIDGE_TRANSPORTS = ["openai", "hermes-cli", "acp"]


def slot_kind(key: str) -> str:
    return _SLOT_KIND.get(key, "bridge")  # private slots are bridged runtimes


def slot_transports(key: str) -> list[str]:
    if key in _SLOT_TRANSPORTS:
        return _SLOT_TRANSPORTS[key]
    return _BRIDGE_TRANSPORTS if slot_kind(key) == "bridge" else ["openai"]

_DEFAULT = {
    "enabled": False, "endpoint": "", "token": "", "model": "", "notes": "",
    "ssh": "",  # "user@host[:port]" — an SSH tunnel (openai transport) or the box to run the CLI on
    # how Rezident talks to this runtime:
    #   "openai"     -> POST {endpoint}/v1/chat/completions  (Hermes/OpenClaw HTTP servers)
    #   "hermes-cli" -> run `hermes -z "<prompt>"` over SSH   (a Hermes box with no HTTP API)
    #   "acp"        -> `hermes acp` JSON-RPC over SSH        (streaming, native sessions)
    #   "codex-cli"  -> run the LOCAL `codex exec` CLI        (OAuth ChatGPT sign-in, no key)
    "transport": "openai",
    "last_status": "", "last_checked": "", "last_detail": "",
}

# Both Hermes (Nous Research) and OpenClaw expose an OpenAI-compatible
# /v1/chat/completions endpoint, so a single generic bridge drives both (and most
# other modern runtimes) — as do OpenAI and OpenRouter themselves. These are the
# sensible default models when the user leaves the model blank; OpenAI/OpenRouter
# REQUIRE a model, and OpenClaw REQUIRES one that names the target agent.
_DEFAULT_MODEL = {
    "openclaw": "openclaw:main", "openai": "gpt-4o", "openrouter": "openai/gpt-4o",
    "anthropic": "claude-sonnet-5", "gemini": "gemini-2.5-flash",
    "groq": "llama-3.3-70b-versatile", "deepseek": "deepseek-chat",
    "mistral": "mistral-large-latest", "perplexity": "sonar-pro",
    "xai": "grok-4", "moonshot": "kimi-latest", "zai": "glm-4.6",
    "ollama": "llama3.2", "qwen": "qwen-plus",
}

# Hosted providers whose endpoint is fixed — prefilled so the user only supplies a
# key. Stored config still wins (override for Azure OpenAI, a proxy, etc.).
# NOTE non-standard bases: Gemini/Z.ai carry their own path prefix and Perplexity
# is a full /chat/completions URL — _api_urls() handles all three shapes.
_DEFAULT_ENDPOINT = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "groq": "https://api.groq.com/openai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "mistral": "https://api.mistral.ai/v1",
    "perplexity": "https://api.perplexity.ai/chat/completions",
    "xai": "https://api.x.ai/v1",
    "moonshot": "https://api.moonshot.ai/v1",
    "zai": "https://api.z.ai/api/paas/v4",
    "ollama": "http://127.0.0.1:11434",
    "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",  # openai-transport fallback (DashScope key)
}


# Per-slot key-field hint for the UIs — only where "API key" alone isn't enough.
TOKEN_HINTS = {
    "gemini": "API key — free from aistudio.google.com",
    "qwen": "API key — sk-sp-… Coding Plan key or a DashScope key (endpoint auto-routes)",
}


class IntegrationError(RuntimeError):
    pass




def _skey(key: str) -> str:
    return f"integration:{key}"


def is_slot(key: str) -> bool:
    return key in _KEYS


def _auth_headers(cfg: dict, key: str = "") -> dict:
    """Bearer for the OpenAI-compatible world; Anthropic additionally wants its
    native x-api-key + anthropic-version pair (its /v1/models endpoint rejects a
    bare Bearer), so both are sent and each endpoint reads the one it understands."""
    tok = (cfg.get("token") or "").strip()
    if not tok:
        return {}
    headers = {"Authorization": f"Bearer {tok}"}
    if key == "anthropic":
        headers.update({"x-api-key": tok, "anthropic-version": "2023-06-01"})
    return headers


async def get_config(key: str) -> dict:
    """Full stored config INCLUDING the token (internal use; the API strips it)."""
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_skey(key),))
    cfg = dict(_DEFAULT)
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, json.JSONDecodeError):
            pass
    # clamp to the slot's legal transports — forces Codex onto its sign-in even
    # if an old config said otherwise, and defaults Gemini/Qwen to theirs
    allowed = slot_transports(key)
    if (cfg.get("transport") or "").strip() not in allowed:
        cfg["transport"] = allowed[0]
    if not cfg.get("endpoint"):
        if key == "qwen" and (cfg.get("token") or "").strip().startswith("sk-sp-"):
            # Coding Plan subscription keys (sk-sp-…) live on their own dedicated
            # endpoint — routing by key prefix means "paste the key, done"
            cfg["endpoint"] = "https://coding-intl.dashscope.aliyuncs.com/v1"
        elif key in _DEFAULT_ENDPOINT:
            cfg["endpoint"] = _DEFAULT_ENDPOINT[key]  # hosted providers: fixed URL, prefilled
    return cfg


async def _write(key: str, cfg: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_skey(key), json.dumps(cfg)),
    )


async def save_config(key: str, *, enabled: bool | None = None, endpoint: str, model: str, notes: str | None = None, token: str | None, ssh: str = "", transport: str | None = None) -> dict:
    """Persist config. A blank/None token PRESERVES the stored one, so toggling
    enable — from PIP-OS or GRID//OS — never wipes a saved credential. transport
    is likewise preserved when None so a plain enable-toggle keeps the runtime kind,
    notes=None preserves stored notes, and enabled=None preserves the stored on/off
    state so a partial PUT (e.g. transport-only) can't silently disable the slot.
    Transport is clamped to the slot's legal set and SSH only sticks on bridge
    slots — API providers never grow a tunnel."""
    cfg = await get_config(key)
    if enabled is not None:  # None preserves the stored value; partial PUTs mustn't flip it
        cfg["enabled"] = bool(enabled)
    # api slots have a FIXED endpoint — store it canonical-empty so the default
    # (and qwen's key-prefix routing) is always applied fresh on read
    cfg["endpoint"] = "" if slot_kind(key) == "api" else (endpoint or "").strip()
    cfg["model"] = (model or "").strip()
    if notes is not None:
        cfg["notes"] = notes
    cfg["ssh"] = (ssh or "").strip() if slot_kind(key) == "bridge" else ""
    if transport is not None:
        allowed = slot_transports(key)
        t = (transport or "").strip()
        cfg["transport"] = t if t in allowed else allowed[0]
    if token:  # only overwrite when a new secret is actually supplied
        cfg["token"] = token
    # config changed — any stored probe verdict is about the OLD config, so a
    # stale "reachable" can't keep a misconfigured card looking connected
    cfg["last_status"] = ""
    cfg["last_checked"] = ""
    cfg["last_detail"] = ""
    await _write(key, cfg)
    return cfg


def _base_url(cfg: dict) -> str:
    """The configured endpoint, verbatim minus trailing slashes. Path shaping
    happens in _api_urls(), because providers disagree about their bases."""
    return (cfg.get("endpoint") or "").strip().rstrip("/")


def _api_urls(base: str) -> tuple[str, str]:
    """(chat_url, models_url) for any OpenAI-compatible base shape:
      * a pasted full URL  …/chat/completions      -> used as-is   (Perplexity)
      * a bare host        http://127.0.0.1:8642   -> + /v1/<leaf> (the convention)
      * a base with a path …/openai/v1, …/v1beta/openai, …/api/paas/v4
                                                    -> + /<leaf> verbatim (Groq/Gemini/Z.ai)
    """
    e = base.rstrip("/")
    if e.endswith("/chat/completions"):
        return e, e[: -len("/chat/completions")] + "/models"
    if not urlparse(e).path.strip("/"):
        e = e + "/v1"
    return e + "/chat/completions", e + "/models"


def _embeddings_url(base: str) -> str:
    """The /embeddings leaf for any OpenAI-compatible base shape (sibling of
    _api_urls, same rules):
      * a pasted full URL  …/embeddings          -> used as-is
      * a bare host        http://127.0.0.1:11434 -> + /v1/embeddings (the convention,
                                                     e.g. Ollama's OpenAI shim)
      * a base with a path …/openai/v1, …/v1beta/openai
                                                  -> + /embeddings verbatim
    """
    e = base.rstrip("/")
    if e.endswith("/embeddings"):
        return e
    if not urlparse(e).path.strip("/"):
        e = e + "/v1"
    return e + "/embeddings"


# ---- optional SSH tunnels ----------------------------------------------------
# When `ssh` = "user@host[:port]" is set, `endpoint` is interpreted as the address
# seen FROM the remote (e.g. http://127.0.0.1:8642 = the remote's local Hermes).
# We lazily open `ssh -N -L <free>:host:port user@host` with the system ssh (uses
# your existing keys/agent), cache it, and route requests through the local port.

_tunnels: dict[str, dict] = {}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _validate_ssh_dest(dest: str) -> None:
    """Reject a destination ssh would (mis)read as an option or that smuggles
    whitespace/control chars. Every SSH transport funnels through _parse_ssh, so
    this one gate covers the tunnel, CLI, and ACP paths. Raises IntegrationError."""
    if not dest:
        raise IntegrationError("invalid ssh destination: empty")
    if dest.startswith("-"):
        # e.g. '-oProxyCommand=...' — ssh would treat it as an option, not a host
        raise IntegrationError(
            "invalid ssh destination: must not start with '-' (ssh would read it as an option)")
    if any(c.isspace() or ord(c) < 0x20 for c in dest):
        raise IntegrationError("invalid ssh destination: contains whitespace or control characters")


def _parse_ssh(ssh: str) -> tuple[str, int]:
    """'user@host' or 'user@host:2222' -> ('user@host', port). Bracketed IPv6
    ('[::1]', '[::1]:22') is allowed; the port, when present, must be 1-65535.
    Raises IntegrationError on a malformed/hostile destination so callers surface
    a clean 'invalid ssh destination' instead of crashing (or, worse, handing ssh
    an attacker-controlled option)."""
    ssh = (ssh or "").strip()
    if not ssh:
        raise IntegrationError("invalid ssh destination: empty")
    port = 22
    tail = ssh.rsplit("@", 1)[-1]
    if tail.startswith("["):
        # bracketed IPv6: '[::1]' or '[::1]:2222' — the colons inside the brackets
        # are part of the address, so only split a :port that FOLLOWS the ']'.
        end = tail.rfind("]")
        if end == -1:
            raise IntegrationError("invalid ssh destination: unbalanced '[' in IPv6 host")
        after = tail[end + 1:]
        if after:
            if not (after.startswith(":") and after[1:].isdigit()):
                raise IntegrationError(f"invalid ssh destination: bad port in '{ssh}'")
            port = int(after[1:])
            ssh = ssh[: ssh.rfind(tail)] + tail[: end + 1]
    elif ":" in tail:
        host_part, p = tail.rsplit(":", 1)
        if p.isdigit():
            ssh, port = ssh[: ssh.rfind(tail)] + host_part, int(p)
    if not 1 <= port <= 65535:
        raise IntegrationError(f"invalid ssh destination: port {port} out of range (1-65535)")
    _validate_ssh_dest(ssh)
    return ssh, port


def _endpoint_host_port(base: str) -> tuple[str, int]:
    u = urlparse(base if "://" in base else "http://" + base)
    return (u.hostname or "127.0.0.1"), (u.port or (443 if u.scheme == "https" else 80))


async def _effective_base(cfg: dict) -> str:
    """Base URL to actually hit — a local forwarded port if `ssh` is set, else the
    endpoint directly. Raises IntegrationError with the ssh stderr if the tunnel
    can't be established."""
    base = _base_url(cfg)
    ssh = (cfg.get("ssh") or "").strip()
    if not base or not ssh:
        return base

    dest, sshport = _parse_ssh(ssh)
    rhost, rport = _endpoint_host_port(base)
    # preserve any path prefix (…/openai/v1, …/v1beta/openai) across the tunnel
    _path = urlparse(base if "://" in base else "http://" + base).path.rstrip("/")
    sig = f"{dest}:{sshport}|{rhost}:{rport}"
    ent = _tunnels.get(sig)
    if ent and ent["proc"].returncode is None:
        return f"http://127.0.0.1:{ent['local_port']}{_path}"

    lport = _free_port()
    args = [
        "ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=30", "-o", "BatchMode=yes",
        # `--` ends option parsing so `dest` can't be read as an ssh option; with -N
        # there's no remote command, so `ssh ... -- dest` is a valid tunnel form.
        "-L", f"127.0.0.1:{lport}:{rhost}:{rport}", "-p", str(sshport), "--", dest,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError:
        raise IntegrationError("ssh not found — install an OpenSSH client to use SSH tunneling")
    # wait for the forwarded port to accept connections (or ssh to exit with an error)
    for _ in range(24):
        await asyncio.sleep(0.15)
        if proc.returncode is not None:
            err = (await proc.stderr.read()).decode(errors="replace").strip()
            raise IntegrationError(f"ssh tunnel failed: {err[:200] or 'ssh exited'}")
        try:
            with socket.create_connection(("127.0.0.1", lport), timeout=0.3):
                _tunnels[sig] = {"proc": proc, "local_port": lport}
                return f"http://127.0.0.1:{lport}{_path}"
        except OSError:
            continue
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    raise IntegrationError("ssh tunnel did not come up in time (check host/keys/remote port)")


async def shutdown_tunnels() -> None:
    for ent in list(_tunnels.values()):
        try:
            ent["proc"].terminate()
        except (ProcessLookupError, OSError):
            pass
    _tunnels.clear()


async def probe(key: str) -> dict:
    """Connectivity + auth check. Prefers the OpenAI-compatible /v1/models list
    (validates the token too), falling back to the base URL for a plain
    reachability check. 'reachable' = any HTTP response; a connection error/timeout
    = unreachable. Result is persisted (last_status/last_checked/last_detail)."""
    cfg = await get_config(key)
    result = {"ok": False, "status": None, "latency_ms": None, "detail": "", "checked_at": utcnow()}
    _transport = (cfg.get("transport") or "openai").strip()
    if _transport == "hermes-cli":
        return await _probe_cli(key, cfg, result)
    if _transport == "acp":
        return await _probe_acp(key, cfg, result)
    if _transport == "codex-cli":
        return await _probe_codex(key, cfg, result)
    if slot_kind(key) == "api" and not (cfg.get("token") or "").strip():
        # a hosted provider without a key can only ever 401 — say the useful thing
        result["detail"] = "no API key saved — paste your key and SAVE first"
        return await _finish_probe(key, cfg, result)
    try:
        base = await _effective_base(cfg)  # opens the SSH tunnel if configured
    except IntegrationError as exc:
        base = None
        result["detail"] = str(exc)[:180]

    if base is None:
        pass  # tunnel error already in detail
    elif not base:
        result["detail"] = "no endpoint configured"
    else:
        last_err = None
        _, models_url = _api_urls(base)
        for url in (models_url, base):  # OpenAI models list first, then bare root
            t0 = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=False) as client:
                    resp = await client.get(url, headers=_auth_headers(cfg, key))
            except httpx.HTTPError as exc:  # connection/timeout — try the next path
                last_err = exc
                continue
            ms = int((time.monotonic() - t0) * 1000)
            result["ok"] = True
            result["status"] = resp.status_code
            result["latency_ms"] = ms
            if url == models_url and resp.status_code < 300:
                n = _count_models(resp)
                result["detail"] = f"API OK · {n} models · {ms}ms" if n is not None else f"API OK · {ms}ms"
            elif resp.status_code in (401, 403):
                # endpoint answered but the credential is bad — that is NOT a
                # working integration, so the card must go red, not green
                result["ok"] = False
                result["detail"] = f"endpoint reachable but auth REJECTED (HTTP {resp.status_code}) — check the API key"
            elif url == models_url and resp.status_code in (404, 405):
                # some providers (Perplexity) have no models list — auth passed the gate
                result["detail"] = f"endpoint up · {ms}ms · no models list on this API — key is verified on first send"
            else:
                result["detail"] = f"endpoint up · HTTP {resp.status_code} · {ms}ms"
            break
        else:
            result["detail"] = f"unreachable: {type(last_err).__name__}: {str(last_err)[:100]}".strip() if last_err else "unreachable"

    return await _finish_probe(key, cfg, result)


def _count_models(resp) -> int | None:
    try:
        data = resp.json().get("data")
        return len(data) if isinstance(data, list) else None
    except Exception:
        return None


async def _finish_probe(key: str, cfg: dict, result: dict) -> dict:
    """Persist a probe result to the slot's last_status/checked/detail and return it."""
    cfg["last_status"] = "reachable" if result["ok"] else "unreachable"
    cfg["last_checked"] = result["checked_at"]
    cfg["last_detail"] = result["detail"]
    await _write(key, cfg)
    return result


# ---- CLI transport (Hermes `hermes -z` over SSH) -----------------------------
# For a Hermes agent with no OpenAI HTTP surface we shell out to its one-shot
# CLI over SSH. stdout is the reply; remote stderr (startup noise that can list
# the box's secret NAMES) is captured separately and NEVER surfaced.

def _ssh_base_args(dest: str, sshport: int) -> list[str]:
    return [
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        # `--` ends option parsing so `dest` can't be read as an ssh option; the
        # caller appends the remote command after this, so `ssh ... -- dest cmd` runs
        # `cmd` on `dest` exactly as before.
        "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=8", "-p", str(sshport), "--", dest,
    ]


def _flatten_for_cli(messages: list[dict]) -> str:
    """Collapse a chat history into one prompt for a one-shot CLI runtime: a lone
    user turn passes straight through; multi-turn becomes a short transcript.
    System messages (operator memory, docs/agent-memory.md) become a context
    preamble — dropping them would blind CLI/ACP runtimes to shared memory."""
    system = [m for m in messages if m.get("role") == "system" and (m.get("content") or "").strip()]
    preamble = ""
    if system:
        ctx = "\n".join(m["content"].strip() for m in system)
        preamble = f"[Context from your operator's Rezident]\n{ctx}\n---\n\n"
    real = [m for m in messages if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()]
    if len(real) <= 1:
        return preamble + (real[0].get("content", "").strip() if real else "")
    lines = [("User" if m["role"] == "user" else "Assistant") + ": " + m["content"].strip() for m in real]
    lines.append("\nContinue the conversation — reply to the latest User message only.")
    return preamble + "\n".join(lines)


async def _dispatch_cli(key: str, cfg: dict, messages: list[dict]) -> dict:
    """Run `hermes -z "<prompt>"` on the remote box over SSH and return its stdout.
    The prompt is base64-encoded locally and decoded on the remote into a single
    quoted argument, so arbitrary text (quotes, newlines, $()/backticks) can't break
    out of the shell — no injection."""
    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        raise IntegrationError(f"'{key}' uses the CLI transport but has no ssh destination set (user@host)")
    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    dest, sshport = _parse_ssh(ssh)
    b64 = base64.b64encode(prompt.encode()).decode()  # only [A-Za-z0-9+/=] — shell-safe
    remote = f"hermes -z \"$(printf %s '{b64}' | base64 -d)\""
    try:
        proc = await asyncio.create_subprocess_exec(
            *_ssh_base_args(dest, sshport), remote,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _err = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise IntegrationError("the CLI runtime timed out (the agent turn took too long)")
    except FileNotFoundError:
        raise IntegrationError("ssh not found — install an OpenSSH client to use the CLI transport")
    reply = out.decode(errors="replace").strip()
    if proc.returncode != 0:
        # never echo remote stderr — it can contain secret NAMES from the box; point
        # the operator at a terminal command they can run to see the real error
        raise IntegrationError(
            f"the CLI runtime exited with code {proc.returncode} — run "
            f"`ssh {dest} \"hermes -z 'ping'\"` in a terminal to see its error "
            "(stderr is not captured here because it can contain secret names)")
    if not reply:
        raise IntegrationError("the CLI runtime returned an empty reply")
    return {"ok": True, "key": key, "model": "hermes -z", "reply": reply}


async def _probe_cli(key: str, cfg: dict, result: dict) -> dict:
    """Reachability for a CLI runtime: SSH in and confirm `hermes` is on PATH."""
    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        result["detail"] = "no ssh destination set (user@host)"
        return await _finish_probe(key, cfg, result)
    try:
        dest, sshport = _parse_ssh(ssh)
    except IntegrationError as exc:
        result["detail"] = str(exc)[:180]
        return await _finish_probe(key, cfg, result)
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *_ssh_base_args(dest, sshport), "command -v hermes",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=20)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        result["detail"] = "ssh timed out (check host/keys)"
        return await _finish_probe(key, cfg, result)
    except FileNotFoundError:
        result["detail"] = "ssh not found — install an OpenSSH client"
        return await _finish_probe(key, cfg, result)
    ms = int((time.monotonic() - t0) * 1000)
    path = out.decode(errors="replace").strip()
    if proc.returncode == 0 and path:
        result.update(ok=True, status=200, latency_ms=ms, detail=f"hermes CLI at {path} · {ms}ms")
    elif proc.returncode == 0:
        result["detail"] = "ssh ok, but 'hermes' isn't on PATH over SSH"
    else:
        se = err.decode(errors="replace").strip().splitlines()
        result["detail"] = f"ssh failed: {se[-1][:120] if se else 'exit ' + str(proc.returncode)}"
    return await _finish_probe(key, cfg, result)


# ---- Codex transport (OpenAI Codex CLI, LOCAL, ChatGPT OAuth sign-in) --------
# The "OAuth connection" for OpenAI: `codex login` signs in with a ChatGPT account
# once, and Rezident shells out to the local `codex exec` one-shot — no API key is
# ever stored here. The final agent message is read via --output-last-message so
# the reply is clean of progress noise.

def _cli_binary(cfg: dict, name: str) -> str | None:
    """The agent CLI to run: an explicit filesystem path in `endpoint` wins (also
    lets tests point at a stub); a URL there belongs to the HTTP transport and is
    ignored. Else PATH, else the usual npm-global location."""
    override = (cfg.get("endpoint") or "").strip()
    if override and "://" not in override:
        p = Path(override)
        if p.exists():
            return str(p)
        return None  # an explicit-but-dead path must fail loudly, not silently fall back
    found = shutil.which(name)
    if found:
        return found
    npm = Path(os.environ.get("APPDATA", "")) / "npm" / f"{name}.cmd"
    try:
        if str(npm) and npm.exists():
            return str(npm)
    except OSError:
        pass
    # Rezident-provisioned copy (CONNECT fetches the standalone exe on demand —
    # the bundled-tailscale idiom: no npm, no manual installs, it just works).
    # Lives in agentos.provision: it needs redirect-following for GitHub's asset
    # CDN, which THIS module's outbound clients are forbidden from doing.
    from .provision import bundled_bin_dir

    bundled = bundled_bin_dir() / f"{name}.exe"
    try:
        if bundled.exists():
            return str(bundled)
    except OSError:
        pass
    return None


def _codex_binary(cfg: dict) -> str | None:
    return _cli_binary(cfg, "codex")


async def _dispatch_codex(key: str, cfg: dict, messages: list[dict], *,
                          cwd: str | None = None, workspace_write: bool = False) -> dict:
    from .config import settings

    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    binary = _codex_binary(cfg)
    if not binary:
        raise IntegrationError(
            "codex CLI not found — hit CONNECT on the Codex card and Rezident"
            " fetches it automatically, then signs you in"
        )
    settings.ensure_dirs()
    out_file = settings.scratch_dir / f"codex-last-{os.getpid()}-{int(time.monotonic() * 1000)}.txt"
    args = [binary, "exec", "--skip-git-repo-check", "--output-last-message", str(out_file)]
    # Task/chat runs hand codex the real task workspace: it works the files there
    # under its own OS sandbox (writes fenced to the cwd; verified on Windows).
    # Without workspace_write it keeps the historic read-only one-shot behavior.
    if workspace_write:
        args += ["--sandbox", "workspace-write"]
    model = (cfg.get("model") or "").strip()
    if model:
        args += ["-m", model]
    # Prompt goes over STDIN ("-" = read from stdin), never argv: npm installs
    # codex as a .cmd shim on Windows, and cmd.exe truncates argv at the first
    # newline — a flattened multi-turn history would arrive as its first line.
    args.append("-")
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=cwd or str(settings.scratch_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        # Real coding missions in a workspace run far longer than a one-shot reply.
        out, err = await asyncio.wait_for(proc.communicate(input=prompt.encode()),
                                          timeout=1800 if workspace_write else 300)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise IntegrationError("codex timed out (the agent turn took too long)")
    except (FileNotFoundError, OSError) as exc:
        raise IntegrationError(f"could not run codex: {exc}")
    finally:
        reply = ""
        try:
            reply = out_file.read_text(encoding="utf-8", errors="replace").strip()
            out_file.unlink(missing_ok=True)
        except OSError:
            pass
    if proc.returncode != 0:
        tail = (err.decode(errors="replace").strip().splitlines() or [""])[-1]
        raise IntegrationError(f"codex exited with code {proc.returncode}" + (f": {tail[:160]}" if tail else ""))
    if not reply:  # older CLIs without --output-last-message support: fall back to stdout
        reply = out.decode(errors="replace").strip()
    if not reply:
        raise IntegrationError("codex returned an empty reply")
    return {"ok": True, "key": key, "model": model or "codex default", "reply": reply}


async def _probe_codex(key: str, cfg: dict, result: dict) -> dict:
    """Codex reachability = the CLI exists AND is signed in (`codex login status`)."""
    binary = _codex_binary(cfg)
    if not binary:
        result["detail"] = ("codex CLI not found — hit CONNECT and Rezident fetches it"
                            " automatically, then signs you in")
        return await _finish_probe(key, cfg, result)
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "login", "status",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=20)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        result["detail"] = "codex login status timed out"
        return await _finish_probe(key, cfg, result)
    except (FileNotFoundError, OSError) as exc:
        result["detail"] = f"could not run codex: {str(exc)[:120]}"
        return await _finish_probe(key, cfg, result)
    ms = int((time.monotonic() - t0) * 1000)
    line = (out.decode(errors="replace").strip() or err.decode(errors="replace").strip()).splitlines()
    first = line[0][:120] if line else ""
    if proc.returncode == 0:
        result.update(ok=True, status=200, latency_ms=ms, detail=f"codex CLI · {first or 'signed in'} · {ms}ms")
    else:
        result["detail"] = f"codex CLI found but NOT signed in — use CONNECT ({first or 'exit ' + str(proc.returncode)})"
    return await _finish_probe(key, cfg, result)


# ---- OAuth sign-in sessions -----------------------------------------------------
# The sign-in slot (Codex) connects by running the vendor CLI's OAuth flow
# ONCE. CONNECT runs it HIDDEN in the background: the CLI opens the sign-in page
# in the browser on this machine, the user logs in, the CLI stores the
# credential, and the card flips green — no console, no copy-paste. The captured
# auth URL is surfaced too, as a fallback link if no tab appeared.

import re as _re

_ANSI_RE = _re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_URL_RE = _re.compile(r"https://[^\s'\"<>\)\]]+")

_LOGIN_SPEC = {
    "codex-cli": {
        "name": "codex", "args": ["login"], "stdin": b"",
        "install": "npm i -g @openai/codex",
        # Never CLAIM the browser opened — the card's detail is updated to say so
        # only after a pop mechanism actually reports success.
        "running": "sign-in running — the page should open in your browser; if it doesn't, use the button on this card",
    },
}


def _login_trail(msg: str) -> None:
    """Field breadcrumbs for the CONNECT flow (mirrors the updater's trail) —
    %TEMP%/rezident_login.log answers 'what actually happened on that box'."""
    try:
        import tempfile
        from .events import utcnow

        with open(Path(tempfile.gettempdir()) / "rezident_login.log", "a", encoding="utf-8") as f:
            f.write(f"[{utcnow()}] {msg}\n")
    except Exception:  # noqa: BLE001 — diagnostics never break the flow
        pass

# key -> {proc, url, buf, done, ok, detail, transport, started}
_login_sessions: dict[str, dict] = {}


def login_status(key: str) -> dict:
    ses = _login_sessions.get(key)
    if not ses:
        return {"running": False, "done": False, "ok": False, "url": "", "detail": ""}
    return {"running": not ses["done"], "done": ses["done"], "ok": ses["ok"], "url": ses["url"], "detail": ses["detail"]}


def _pop_browser(ses: dict, force: bool = False) -> None:
    """Open the captured sign-in URL in the operator's default browser OURSELVES,
    trying three mechanisms and LOGGING each — the vendor CLI's own browser-open
    is unreliable from a windowless child, and a single python mechanism proved
    unreliable in the field too. The card's button re-enters here with force=True
    (window.open is dead inside the WebView2 shell, so the button must route
    through the host)."""
    url = ses.get("url") or ""
    if not url:
        _login_trail("pop requested but no URL captured yet")
        return
    if ses.get("opened") and not force:
        return
    ses["opened"] = True

    def _open() -> None:
        # 1. ShellExecute — the most direct Windows path
        if os.name == "nt":
            try:
                os.startfile(url)  # noqa: S606 — https URL captured from the vendor CLI
                _login_trail(f"browser open via os.startfile OK ({url[:60]}…)")
                ses["detail"] = "sign-in page opened in your browser — approve it there"
                return
            except Exception as exc:  # noqa: BLE001
                _login_trail(f"os.startfile failed: {exc}")
        # 2. python's webbrowser
        try:
            import webbrowser

            if webbrowser.open(url):
                _login_trail("browser open via webbrowser OK")
                ses["detail"] = "sign-in page opened in your browser — approve it there"
                return
            _login_trail("webbrowser.open returned False")
        except Exception as exc:  # noqa: BLE001
            _login_trail(f"webbrowser.open failed: {exc}")
        # 3. cmd start — last resort
        if os.name == "nt":
            try:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                subprocess.Popen(["cmd", "/c", "start", "", url], creationflags=flags)
                _login_trail("browser open via cmd start attempted")
                ses["detail"] = "sign-in page opened in your browser — approve it there"
                return
            except Exception as exc:  # noqa: BLE001
                _login_trail(f"cmd start failed: {exc}")
        _login_trail("ALL browser-open mechanisms failed — the card's button/URL is the fallback")

    try:
        asyncio.get_running_loop().run_in_executor(None, _open)
    except RuntimeError:
        _open()


def reopen_login_url(key: str) -> dict:
    """The card's 'open the sign-in page' button routes HERE: window.open is a
    no-op inside the WebView2 shell, so the host opens the system browser.
    Returns the URL so a real-browser client can also open it client-side."""
    ses = _login_sessions.get(key)
    url = (ses or {}).get("url") or ""
    _login_trail(f"manual open requested for '{key}' (url {'captured' if url else 'MISSING'})")
    if ses and url:
        _pop_browser(ses, force=True)
    return {"ok": bool(url), "url": url}


async def _login_watch(key: str, ses: dict, spec: dict) -> None:
    """Drain the CLI's output (scanning for the auth URL) and settle the session."""
    proc = ses["proc"]

    async def drain(stream) -> None:
        while True:
            chunk = await stream.read(512)
            if not chunk:
                return
            ses["buf"] += _ANSI_RE.sub("", chunk.decode(errors="replace"))
            if not ses["url"]:
                m = _URL_RE.search(ses["buf"])
                if m:
                    ses["url"] = m.group(0).rstrip(".,")
                    _login_trail(f"auth URL captured ({ses['url'][:60]}…)")
                    _pop_browser(ses)

    try:
        await asyncio.wait_for(asyncio.gather(drain(proc.stdout), drain(proc.stderr), proc.wait()), timeout=360)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        ses.update(done=True, ok=False, detail="sign-in timed out after 6 minutes — hit CONNECT to try again")
        return
    if proc.returncode == 0:
        # signed in = connected & enabled: persist the slot as enabled right here
        # so the user never needs a separate Save. Read the current cfg and pass
        # every field through (token=None preserves the credential) so nothing else
        # is clobbered — only a real slot, never a stray key.
        if is_slot(key):
            try:
                cur = await get_config(key)
                await save_config(
                    key, enabled=True,
                    endpoint=cur.get("endpoint") or "", model=cur.get("model") or "",
                    notes=cur.get("notes"), token=None,
                    ssh=cur.get("ssh") or "", transport=cur.get("transport"),
                )
            except Exception:  # a persistence hiccup mustn't break the sign-in verdict
                pass
            if key == "codex":
                # Recognizing codex STAFFS it: the stock GPT crew auto-recruits on
                # first connect (one-shot; a later retire stays retired).
                try:
                    from . import crew_seed

                    await crew_seed.ensure_codex_crew()
                except Exception:  # noqa: BLE001 — seeding never breaks a sign-in
                    pass
        ses.update(done=True, ok=True, detail="signed in — connected")
        return
    lines = [l for l in ses["buf"].strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    tail = (lines[-1][:160] if lines else "") or f"exit {proc.returncode}"
    ses.update(done=True, ok=False, detail=f"sign-in did not complete — {tail}")


async def launch_login(key: str) -> dict:
    """Start (or report the already-running) hidden browser sign-in for a slot."""
    import subprocess

    from .config import settings

    cfg = await get_config(key)
    transport = (cfg.get("transport") or "").strip()
    spec = _LOGIN_SPEC.get(transport)
    if not spec:
        raise IntegrationError(f"'{key}' connects with an API key, not a sign-in")
    ses = _login_sessions.get(key)
    if ses and not ses["done"]:
        return login_status(key)  # one sign-in at a time; report progress instead
    binary = _cli_binary(cfg, spec["name"])
    if not binary and spec["name"] != "codex":
        raise IntegrationError(f"{spec['name']} CLI not found — install it first: {spec['install']}")
    settings.ensure_dirs()
    ses = {"proc": None, "url": "", "buf": "", "done": False, "ok": False,
           "detail": spec["running"], "transport": transport, "started": time.monotonic()}
    _login_sessions[key] = ses
    if not binary:
        # CONNECT on a bare machine: fetch the standalone codex CLI ourselves,
        # then continue straight into the sign-in — the card's status polling
        # shows the download progress. No npm, no manual step, no dead end.
        async def _provision_then_login() -> None:
            from .provision import ProvisionError, provision_codex

            try:
                fetched = await provision_codex(ses)
            except ProvisionError as exc:
                ses.update(done=True, ok=False, detail=str(exc))
                return
            except Exception as exc:  # noqa: BLE001 — surprises still surface with a path forward
                ses.update(done=True, ok=False,
                           detail=f"couldn't fetch the codex CLI ({str(exc)[:100]}) — retry, or install it from github.com/openai/codex")
                return
            await _start_login_proc(key, ses, spec, fetched)

        asyncio.ensure_future(_provision_then_login())
        return login_status(key)
    await _start_login_proc(key, ses, spec, binary, raise_errors=True)
    await asyncio.sleep(1.2)  # give fast failures (already signed in, dead binary) a beat to surface
    return login_status(key)


async def _start_login_proc(key: str, ses: dict, spec: dict, binary: str, raise_errors: bool = False) -> None:
    """Spawn the vendor sign-in CLI into an existing session and start the watch.
    In the async (post-provision) path errors settle the session instead of raising."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, *spec["args"],
            cwd=str(settings.scratch_dir),
            env={**os.environ, "NO_COLOR": "1"},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            creationflags=flags,
        )
    except (FileNotFoundError, OSError) as exc:
        _login_trail(f"sign-in spawn FAILED ({binary}): {exc}")
        if raise_errors:
            raise IntegrationError(f"could not start the sign-in: {exc}")
        ses.update(done=True, ok=False, detail=f"could not start the sign-in: {exc}")
        return
    _login_trail(f"sign-in spawned: {binary} {' '.join(spec['args'])} (pid {proc.pid})")
    ses["proc"] = proc
    ses["detail"] = spec["running"]
    try:
        if spec["stdin"]:
            proc.stdin.write(spec["stdin"])
            await proc.stdin.drain()
        proc.stdin.close()
    except (OSError, ConnectionResetError):
        pass
    asyncio.ensure_future(_login_watch(key, ses, spec))


# ---- ACP transport (Hermes `hermes acp` over SSH — streaming, native sessions) ----
# One-shot path (deploy/pipeline): open a session, run one turn, accumulate the
# streamed agent_message_chunk deltas, return the full reply. Interactive streaming
# chat lives in runner._run_acp_chat, which keeps the session alive across turns.

async def _dispatch_acp(key: str, cfg: dict, messages: list[dict]) -> dict:
    from .acp import AcpClient, AcpError, empty_reply_reason, mine_result_text

    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        raise IntegrationError(f"'{key}' uses the ACP transport but has no ssh destination set (user@host)")
    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    dest, sshport = _parse_ssh(ssh)
    client = AcpClient(dest, sshport)
    buf: list[str] = []
    saw_nontext = False  # thought/tool updates arrived even if no message text did

    async def on_update(u: dict) -> None:
        nonlocal saw_nontext
        kind = u.get("sessionUpdate")
        c = u.get("content")
        # hermes sends content as one block; tolerate a list of blocks too
        blocks = c if isinstance(c, list) else [c] if isinstance(c, dict) else []
        if kind in ("agent_message_chunk", "agent_message"):  # + final message kind, if ever sent
            for b in blocks:
                if b.get("type") == "text":
                    buf.append(b.get("text", ""))
        elif kind in ("agent_thought_chunk", "tool_call", "tool_call_update"):
            saw_nontext = True

    result: dict = {}
    try:
        await client.start()
        sid = await client.new_session()
        result = await client.prompt(sid, prompt, on_update, timeout=300)
    except AcpError as exc:
        raise IntegrationError(f"ACP: {exc}")
    finally:
        await client.close()
    reply = "".join(buf).strip()
    if not reply:  # some agents return the message in the result rather than streaming it
        reply = mine_result_text(result)
    if not reply:  # a truly empty turn -> a diagnostic reason, never a bare "(empty reply)"
        reply = empty_reply_reason(result, saw_nontext)
    return {"ok": True, "key": key, "model": "hermes acp", "reply": reply}


async def _probe_acp(key: str, cfg: dict, result: dict) -> dict:
    from .acp import AcpClient, AcpError

    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        result["detail"] = "no ssh destination set (user@host)"
        return await _finish_probe(key, cfg, result)
    try:
        dest, sshport = _parse_ssh(ssh)
    except IntegrationError as exc:
        result["detail"] = str(exc)[:180]
        return await _finish_probe(key, cfg, result)
    client = AcpClient(dest, sshport)
    t0 = time.monotonic()
    try:
        await client.start()  # initialize handshake
        ms = int((time.monotonic() - t0) * 1000)
        info = client.agent_info
        result.update(ok=True, status=200, latency_ms=ms,
                      detail=f"ACP {info.get('name', 'agent')} {info.get('version', '?')} · {ms}ms")
    except AcpError as exc:
        result["detail"] = f"ACP handshake failed: {str(exc)[:130]}"
    except Exception as exc:  # noqa: BLE001
        result["detail"] = f"unreachable: {type(exc).__name__}: {str(exc)[:100]}"
    finally:
        await client.close()
    return await _finish_probe(key, cfg, result)


async def dispatch_messages(key: str, messages: list[dict], model: str | None = None, *,
                            cwd: str | None = None, workspace_write: bool = False) -> dict:
    """Send a full OpenAI-style message history to the configured runtime over its
    /v1/chat/completions endpoint (verified for both Hermes and OpenClaw) and return
    the reply. This is the multi-turn primitive behind both one-shot dispatch and
    interactive Comms chat. `messages` is a list of {role, content} dicts. `model`
    overrides the slot's saved model for this call — how one connection serves many
    models (remote-brained crew, per-stage pipeline models). `cwd`/`workspace_write`
    apply only to LOCAL agent CLIs (codex): they run the agent in a real task
    workspace with its own write sandbox — network transports ignore both."""
    if not is_slot(key):
        raise IntegrationError(f"unknown integration '{key}'")
    cfg = await get_config(key)
    if not cfg["enabled"]:
        raise IntegrationError(f"'{key}' is disabled — enable it first")
    if model and model.strip():
        cfg = {**cfg, "model": model.strip()}  # covers every transport downstream
    transport = (cfg.get("transport") or "openai").strip()
    if transport == "hermes-cli":
        return await _dispatch_cli(key, cfg, messages)
    if transport == "acp":
        return await _dispatch_acp(key, cfg, messages)
    if transport == "codex-cli":
        return await _dispatch_codex(key, cfg, messages, cwd=cwd, workspace_write=workspace_write)
    if slot_kind(key) == "api" and not (cfg.get("token") or "").strip():
        raise IntegrationError(f"'{key}' has no API key saved — paste your key and SAVE first")
    base = await _effective_base(cfg)  # opens the SSH tunnel if configured
    if not base:
        raise IntegrationError(f"'{key}' has no endpoint configured")

    model = (cfg.get("model") or "").strip() or _DEFAULT_MODEL.get(key, "")
    body: dict = {"messages": messages, "stream": False}
    if model:
        body["model"] = model

    chat_url, _ = _api_urls(base)
    try:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=False) as client:
            resp = await client.post(chat_url, json=body, headers=_auth_headers(cfg, key))
    except httpx.HTTPError as exc:
        raise IntegrationError(f"could not reach '{key}': {type(exc).__name__}: {str(exc)[:140]}")

    if resp.status_code >= 400:
        raise IntegrationError(f"'{key}' returned HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        data = resp.json()
        reply = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise IntegrationError(f"'{key}' replied in an unexpected (non-OpenAI) format: {resp.text[:200]}")
    return {"ok": True, "key": key, "model": model, "reply": reply}


async def dispatch(key: str, prompt: str) -> dict:
    """One-shot: hand a single prompt to the runtime and return its reply.
    Thin wrapper over dispatch_messages for task deploys and the config tester."""
    return await dispatch_messages(key, [{"role": "user", "content": prompt}])


async def dispatch_embeddings(key: str, inputs: list[str], model: str | None = None) -> list[list[float]]:
    """Embed a batch of texts via the slot's OpenAI-compatible /v1/embeddings
    endpoint and return one vector per input (order preserved). Mirrors
    dispatch_messages' config->base->POST path: get_config -> _effective_base ->
    httpx POST {base}/v1/embeddings with _auth_headers. Works for the local Ollama
    slot (prefilled 127.0.0.1:11434, OpenAI shim) and any OpenAI-compatible slot.
    `model` overrides the slot's saved model for this call. Raises IntegrationError
    on a disabled slot, a missing key/endpoint, a network failure, or a response
    that isn't OpenAI-shaped (data[].embedding) — the knowledge indexer catches it
    and degrades to status=error rather than letting it escape a background task."""
    if not is_slot(key):
        raise IntegrationError(f"unknown integration '{key}'")
    cfg = await get_config(key)
    if not cfg["enabled"]:
        raise IntegrationError(f"'{key}' is disabled — enable it first")
    if model and model.strip():
        cfg = {**cfg, "model": model.strip()}
    if slot_kind(key) == "api" and not (cfg.get("token") or "").strip():
        raise IntegrationError(f"'{key}' has no API key saved — paste your key and SAVE first")
    base = await _effective_base(cfg)  # opens the SSH tunnel if configured
    if not base:
        raise IntegrationError(f"'{key}' has no endpoint configured")

    model = (cfg.get("model") or "").strip() or _DEFAULT_MODEL.get(key, "")
    body: dict = {"input": inputs}
    if model:
        body["model"] = model

    url = _embeddings_url(base)
    try:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=False) as client:
            resp = await client.post(url, json=body, headers=_auth_headers(cfg, key))
    except httpx.HTTPError as exc:
        raise IntegrationError(f"could not reach '{key}': {type(exc).__name__}: {str(exc)[:140]}")

    if resp.status_code >= 400:
        raise IntegrationError(f"'{key}' returned HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        data = resp.json()
        rows = data["data"]
        vectors = [list(r["embedding"]) for r in rows]
    except (ValueError, KeyError, IndexError, TypeError):
        raise IntegrationError(f"'{key}' replied in an unexpected (non-OpenAI) embeddings format: {resp.text[:200]}")
    return vectors
