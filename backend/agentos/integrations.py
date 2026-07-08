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
    {"key": "gemini", "name": "Gemini", "icon": "✦", "blurb": "Google AI Studio — Gemini models, generous free tier, one API key"},
    {"key": "openrouter", "name": "OpenRouter", "icon": "⇅", "blurb": "One key, 300+ models (GPT/Claude/Llama/…) — model is provider/name"},
    {"key": "groq", "name": "Groq", "icon": "⚡", "blurb": "LPU-fast open models (Llama, Kimi, …) — lowest-latency turns on the grid"},
    {"key": "deepseek", "name": "DeepSeek", "icon": "🐋", "blurb": "Frontier-cheap reasoning — deepseek-chat and R1-class thinking"},
    {"key": "mistral", "name": "Mistral", "icon": "≋", "blurb": "European frontier lab — Mistral Large & friends via La Plateforme"},
    {"key": "perplexity", "name": "Perplexity", "icon": "🔎", "blurb": "Web-searching Sonar models — answers with live citations"},
    {"key": "xai", "name": "xAI Grok", "icon": "⊗", "blurb": "Grok models via the xAI API key"},
    {"key": "moonshot", "name": "Moonshot", "icon": "🌙", "blurb": "Kimi models (K2) — strong agentic coding from Moonshot AI"},
    {"key": "zai", "name": "Z.ai", "icon": "ℤ", "blurb": "GLM models (GLM-4.6) — Zhipu's coding-strong line"},
    {"key": "qwen", "name": "Qwen", "icon": "❋", "blurb": "Qwen models — Coding Plan sign-in via the qwen CLI, or a DashScope key"},
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

# Slots whose natural transport isn't the HTTP bridge (stored config still wins).
_DEFAULT_TRANSPORT = {"codex": "codex-cli", "qwen": "qwen-cli"}

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


class IntegrationError(RuntimeError):
    pass




def _skey(key: str) -> str:
    return f"integration:{key}"


def is_slot(key: str) -> bool:
    return key in _KEYS


def _auth_headers(cfg: dict) -> dict:
    return {"Authorization": f"Bearer {cfg['token']}"} if cfg.get("token") else {}


async def get_config(key: str) -> dict:
    """Full stored config INCLUDING the token (internal use; the API strips it)."""
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_skey(key),))
    cfg = dict(_DEFAULT)
    if key in _DEFAULT_TRANSPORT:
        cfg["transport"] = _DEFAULT_TRANSPORT[key]
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, json.JSONDecodeError):
            pass
    if not cfg.get("endpoint") and key in _DEFAULT_ENDPOINT:
        cfg["endpoint"] = _DEFAULT_ENDPOINT[key]  # hosted providers: fixed URL, prefilled
    return cfg


async def _write(key: str, cfg: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_skey(key), json.dumps(cfg)),
    )


async def save_config(key: str, *, enabled: bool, endpoint: str, model: str, notes: str, token: str | None, ssh: str = "", transport: str | None = None) -> dict:
    """Persist config. A blank/None token PRESERVES the stored one, so toggling
    enable — from PIP-OS or GRID//OS — never wipes a saved credential. transport
    is likewise preserved when None so a plain enable-toggle keeps the runtime kind."""
    cfg = await get_config(key)
    cfg["enabled"] = bool(enabled)
    cfg["endpoint"] = (endpoint or "").strip()
    cfg["model"] = (model or "").strip()
    cfg["notes"] = notes or ""
    cfg["ssh"] = (ssh or "").strip()
    if transport is not None:
        cfg["transport"] = (transport or "").strip() or "openai"
    if token:  # only overwrite when a new secret is actually supplied
        cfg["token"] = token
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


def _parse_ssh(ssh: str) -> tuple[str, int]:
    """'user@host' or 'user@host:2222' -> ('user@host', port)."""
    ssh = ssh.strip()
    port = 22
    tail = ssh.rsplit("@", 1)[-1]
    if ":" in tail:
        host_part, p = tail.rsplit(":", 1)
        if p.isdigit():
            prefix = ssh[: ssh.rfind(tail)]
            ssh, port = prefix + host_part, int(p)
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
        "-L", f"127.0.0.1:{lport}:{rhost}:{rport}", "-p", str(sshport), dest,
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
    if _transport in _STDIN_CLIS:
        return await _probe_stdin_cli(key, cfg, result, _transport)
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
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                    resp = await client.get(url, headers=_auth_headers(cfg))
            except httpx.HTTPError as exc:  # connection/timeout — try the next path
                last_err = exc
                continue
            ms = int((time.monotonic() - t0) * 1000)
            result["ok"] = True
            result["status"] = resp.status_code
            result["latency_ms"] = ms
            if url == models_url and resp.status_code < 300:
                n = _count_models(resp)
                result["detail"] = f"reachable · OpenAI API OK · {n} models · {ms}ms" if n is not None else f"reachable · OpenAI API OK · {ms}ms"
            elif resp.status_code in (401, 403):
                result["detail"] = f"reachable · auth REJECTED (HTTP {resp.status_code}) — check token"
            else:
                result["detail"] = f"reachable · HTTP {resp.status_code} · {ms}ms"
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
        "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=8", "-p", str(sshport), dest,
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
        # never echo remote stderr — it can contain secret NAMES from the box
        raise IntegrationError(f"the CLI runtime exited with code {proc.returncode}")
    if not reply:
        raise IntegrationError("the CLI runtime returned an empty reply")
    return {"ok": True, "key": key, "model": "hermes -z", "reply": reply}


async def _probe_cli(key: str, cfg: dict, result: dict) -> dict:
    """Reachability for a CLI runtime: SSH in and confirm `hermes` is on PATH."""
    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        result["detail"] = "no ssh destination set (user@host)"
        return await _finish_probe(key, cfg, result)
    dest, sshport = _parse_ssh(ssh)
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
        result.update(ok=True, status=200, latency_ms=ms, detail=f"reachable · hermes CLI at {path} · {ms}ms")
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
    return None


def _codex_binary(cfg: dict) -> str | None:
    return _cli_binary(cfg, "codex")


async def _dispatch_codex(key: str, cfg: dict, messages: list[dict]) -> dict:
    from .config import settings

    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    binary = _codex_binary(cfg)
    if not binary:
        raise IntegrationError("codex CLI not found — install it (npm i -g @openai/codex), run `codex login`")
    settings.ensure_dirs()
    out_file = settings.scratch_dir / f"codex-last-{os.getpid()}-{int(time.monotonic() * 1000)}.txt"
    args = [binary, "exec", "--skip-git-repo-check", "--output-last-message", str(out_file)]
    model = (cfg.get("model") or "").strip()
    if model:
        args += ["-m", model]
    # Prompt goes over STDIN ("-" = read from stdin), never argv: npm installs
    # codex as a .cmd shim on Windows, and cmd.exe truncates argv at the first
    # newline — a flattened multi-turn history would arrive as its first line.
    args.append("-")
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=str(settings.scratch_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(input=prompt.encode()), timeout=300)
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
        result["detail"] = "codex CLI not found — npm i -g @openai/codex, then `codex login`"
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
        result.update(ok=True, status=200, latency_ms=ms, detail=f"reachable · codex CLI · {first or 'signed in'} · {ms}ms")
    else:
        result["detail"] = f"codex found, but not signed in — run `codex login` ({first or 'exit ' + str(proc.returncode)})"
    return await _finish_probe(key, cfg, result)


# ---- Gemini / Qwen CLI transports (LOCAL, free-tier OAuth sign-in) ------------
# Same shape as Codex: the vendor CLI holds the OAuth token after a one-time
# interactive login, and Rezident pipes the prompt over stdin (piped stdin = the
# CLIs' non-interactive mode, and immune to the npm .cmd shim truncating argv at
# the first newline). qwen-code is a gemini-cli fork, so one implementation
# drives both. stdout is the reply; stderr carries credential/progress noise.

# NOTE (2026): both vendors retired their FREE OAuth tiers — Gemini CLI sign-in
# now needs a Gemini Code Assist license (individuals are pointed at Antigravity)
# and Qwen needs their paid Coding Plan. The transports work for entitled
# accounts; everyone else should use the HTTP API link with a key instead.
_STDIN_CLIS = {
    "gemini-cli": {"name": "gemini", "install": "npm i -g @google/gemini-cli", "login": "sign in via `gemini` (needs a Code Assist license; otherwise use an AI Studio key on the HTTP API link)"},
    "qwen-cli": {"name": "qwen", "install": "npm i -g @qwen-code/qwen-code", "login": "sign in via `qwen` → /auth (needs a Qwen Coding Plan; otherwise use a DashScope key on the HTTP API link)"},
}

# Headless spawns need workspace trust or the CLIs refuse to run (learned from
# gemini 0.49: "not running in a trusted directory"). Both vars set so the qwen
# fork is covered regardless of which name its version reads.
_STDIN_CLI_ENV = {"GEMINI_CLI_TRUST_WORKSPACE": "true", "QWEN_CLI_TRUST_WORKSPACE": "true"}


async def _dispatch_stdin_cli(key: str, cfg: dict, messages: list[dict], transport: str) -> dict:
    from .config import settings

    spec = _STDIN_CLIS[transport]
    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    binary = _cli_binary(cfg, spec["name"])
    if not binary:
        raise IntegrationError(f"{spec['name']} CLI not found — install it ({spec['install']}), then {spec['login']}")
    settings.ensure_dirs()
    args = [binary]
    model = (cfg.get("model") or "").strip()
    if model:
        args += ["-m", model]
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=str(settings.scratch_dir),
            env={**os.environ, **_STDIN_CLI_ENV},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(input=prompt.encode()), timeout=300)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise IntegrationError(f"{spec['name']} timed out (the agent turn took too long)")
    except (FileNotFoundError, OSError) as exc:
        raise IntegrationError(f"could not run {spec['name']}: {exc}")
    if proc.returncode != 0:
        # surface the last MEANINGFUL stderr line — node CLIs end with stack
        # frames ("    at …") that bury the actual error message
        lines = [l for l in err.decode(errors="replace").strip().splitlines()
                 if l.strip() and not l.lstrip().startswith("at ")]
        tail = lines[-1] if lines else ""
        raise IntegrationError(
            f"{spec['name']} exited with code {proc.returncode}"
            + (f": {tail[:200]}" if tail else "")
            + f" — if you haven't signed in yet, {spec['login']}"
        )
    reply = out.decode(errors="replace").strip()
    if not reply:
        raise IntegrationError(f"{spec['name']} returned an empty reply")
    return {"ok": True, "key": key, "model": model or f"{spec['name']} default", "reply": reply}


async def _probe_stdin_cli(key: str, cfg: dict, result: dict, transport: str) -> dict:
    """CLI presence + version. OAuth state can't be checked offline (no status
    subcommand on these CLIs) — a failed send tells the user to sign in."""
    spec = _STDIN_CLIS[transport]
    binary = _cli_binary(cfg, spec["name"])
    if not binary:
        result["detail"] = f"{spec['name']} CLI not found — {spec['install']}"
        return await _finish_probe(key, cfg, result)
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "--version",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=20)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        result["detail"] = f"{spec['name']} --version timed out"
        return await _finish_probe(key, cfg, result)
    except (FileNotFoundError, OSError) as exc:
        result["detail"] = f"could not run {spec['name']}: {str(exc)[:120]}"
        return await _finish_probe(key, cfg, result)
    ms = int((time.monotonic() - t0) * 1000)
    ver = (out.decode(errors="replace").strip() or err.decode(errors="replace").strip()).splitlines()
    first = ver[0][:80] if ver else ""
    if proc.returncode == 0:
        result.update(ok=True, status=200, latency_ms=ms, detail=f"reachable · {spec['name']} CLI {first or 'found'} · sign-in verified on first send · {ms}ms")
    else:
        result["detail"] = f"{spec['name']} found but errored: {first or 'exit ' + str(proc.returncode)}"
    return await _finish_probe(key, cfg, result)


# ---- ACP transport (Hermes `hermes acp` over SSH — streaming, native sessions) ----
# One-shot path (deploy/pipeline): open a session, run one turn, accumulate the
# streamed agent_message_chunk deltas, return the full reply. Interactive streaming
# chat lives in runner._run_acp_chat, which keeps the session alive across turns.

async def _dispatch_acp(key: str, cfg: dict, messages: list[dict]) -> dict:
    from .acp import AcpClient, AcpError

    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        raise IntegrationError(f"'{key}' uses the ACP transport but has no ssh destination set (user@host)")
    prompt = _flatten_for_cli(messages)
    if not prompt:
        raise IntegrationError("nothing to send (empty prompt)")
    dest, sshport = _parse_ssh(ssh)
    client = AcpClient(dest, sshport)
    buf: list[str] = []

    async def on_update(u: dict) -> None:
        if u.get("sessionUpdate") == "agent_message_chunk":
            c = u.get("content") or {}
            if c.get("type") == "text":
                buf.append(c.get("text", ""))

    try:
        await client.start()
        sid = await client.new_session()
        await client.prompt(sid, prompt, on_update, timeout=300)
    except AcpError as exc:
        raise IntegrationError(f"ACP: {exc}")
    finally:
        await client.close()
    reply = "".join(buf).strip() or "(empty reply)"
    return {"ok": True, "key": key, "model": "hermes acp", "reply": reply}


async def _probe_acp(key: str, cfg: dict, result: dict) -> dict:
    from .acp import AcpClient, AcpError

    ssh = (cfg.get("ssh") or "").strip()
    if not ssh:
        result["detail"] = "no ssh destination set (user@host)"
        return await _finish_probe(key, cfg, result)
    dest, sshport = _parse_ssh(ssh)
    client = AcpClient(dest, sshport)
    t0 = time.monotonic()
    try:
        await client.start()  # initialize handshake
        ms = int((time.monotonic() - t0) * 1000)
        info = client.agent_info
        result.update(ok=True, status=200, latency_ms=ms,
                      detail=f"reachable · ACP {info.get('name', 'agent')} {info.get('version', '?')} · {ms}ms")
    except AcpError as exc:
        result["detail"] = f"ACP handshake failed: {str(exc)[:130]}"
    except Exception as exc:  # noqa: BLE001
        result["detail"] = f"unreachable: {type(exc).__name__}: {str(exc)[:100]}"
    finally:
        await client.close()
    return await _finish_probe(key, cfg, result)


async def dispatch_messages(key: str, messages: list[dict]) -> dict:
    """Send a full OpenAI-style message history to the configured runtime over its
    /v1/chat/completions endpoint (verified for both Hermes and OpenClaw) and return
    the reply. This is the multi-turn primitive behind both one-shot dispatch and
    interactive Comms chat. `messages` is a list of {role, content} dicts; set the
    integration's `model` for runtimes that require one (e.g. OpenClaw 'openclaw:main')."""
    if not is_slot(key):
        raise IntegrationError(f"unknown integration '{key}'")
    cfg = await get_config(key)
    if not cfg["enabled"]:
        raise IntegrationError(f"'{key}' is disabled — enable it first")
    transport = (cfg.get("transport") or "openai").strip()
    if transport == "hermes-cli":
        return await _dispatch_cli(key, cfg, messages)
    if transport == "acp":
        return await _dispatch_acp(key, cfg, messages)
    if transport == "codex-cli":
        return await _dispatch_codex(key, cfg, messages)
    if transport in _STDIN_CLIS:
        return await _dispatch_stdin_cli(key, cfg, messages, transport)
    base = await _effective_base(cfg)  # opens the SSH tunnel if configured
    if not base:
        raise IntegrationError(f"'{key}' has no endpoint configured")

    model = (cfg.get("model") or "").strip() or _DEFAULT_MODEL.get(key, "")
    body: dict = {"messages": messages, "stream": False}
    if model:
        body["model"] = model

    chat_url, _ = _api_urls(base)
    try:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
            resp = await client.post(chat_url, json=body, headers=_auth_headers(cfg))
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
