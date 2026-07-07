"""External-integration layer — config store, live connection probe, and the
single wire-up point for bridging to external agent runtimes (Hermes, OpenClaw,
your "redacted", ...).

Today this stores per-slot config, tests connectivity for real (httpx), and
exposes ONE extension point — dispatch() — that intentionally raises NotWired so
nothing silently no-ops. To connect a real runtime, fill in its branch in
dispatch(); everything else (config CRUD, token handling, health checks, the
PIP-OS and GRID//OS UIs) is already built around it.
"""

import asyncio
import base64
import json
import socket
import time
from urllib.parse import urlparse

import httpx

from .db import db
from .events import utcnow

# The configurable integration slots. Detected agent CLIs (claude/codex/...) are
# a separate, read-only concern in environment.py — these are outbound bridges.
INTEGRATION_SLOTS = [
    {"key": "hermes", "name": "Hermes", "icon": "⚚", "blurb": "Jack Roberts' agent runtime — bridge tasks & personas"},
    {"key": "openclaw", "name": "OpenClaw", "icon": "🦞", "blurb": "Browser-operating agent — hand off web missions"},
    {"key": "redacted", "name": "redacted", "icon": "Ⓜ", "blurb": "Reserved slot for your redacted integration"},
]
_KEYS = {s["key"] for s in INTEGRATION_SLOTS}

_DEFAULT = {
    "enabled": False, "endpoint": "", "token": "", "model": "", "notes": "",
    "ssh": "",  # "user@host[:port]" — an SSH tunnel (openai transport) or the box to run the CLI on
    # how AgentOS talks to this runtime:
    #   "openai"     -> POST {endpoint}/v1/chat/completions  (Hermes/OpenClaw HTTP servers)
    #   "hermes-cli" -> run `hermes -z "<prompt>"` over SSH   (redacted — Hermes with no HTTP API)
    "transport": "openai",
    "last_status": "", "last_checked": "", "last_detail": "",
}

# Both Hermes (Nous Research) and OpenClaw expose an OpenAI-compatible
# /v1/chat/completions endpoint, so a single generic bridge drives both (and most
# other modern runtimes). These are the sensible default models when the user
# leaves the model blank; OpenClaw REQUIRES a model that names the target agent.
_DEFAULT_MODEL = {"openclaw": "openclaw:main"}


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
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, json.JSONDecodeError):
            pass
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
    """The OpenAI-compatible base URL (local http://127.0.0.1:8642 or a remote
    URL). Trailing /v1[/chat/completions] is trimmed so we can append cleanly."""
    e = (cfg.get("endpoint") or "").strip().rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if e.endswith(suffix):
            e = e[: -len(suffix)]
            break
    return e.rstrip("/")


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
    sig = f"{dest}:{sshport}|{rhost}:{rport}"
    ent = _tunnels.get(sig)
    if ent and ent["proc"].returncode is None:
        return f"http://127.0.0.1:{ent['local_port']}"

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
                return f"http://127.0.0.1:{lport}"
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
        for path in ("/v1/models", ""):  # OpenAI models list first, then bare root
            t0 = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                    resp = await client.get(base + path, headers=_auth_headers(cfg))
            except httpx.HTTPError as exc:  # connection/timeout — try the next path
                last_err = exc
                continue
            ms = int((time.monotonic() - t0) * 1000)
            result["ok"] = True
            result["status"] = resp.status_code
            result["latency_ms"] = ms
            if path == "/v1/models" and resp.status_code < 300:
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
# redacted is a Hermes agent with no OpenAI HTTP surface, so we shell out to its
# one-shot CLI over SSH. stdout is the reply; remote stderr (startup noise that
# lists the box's secret NAMES) is captured separately and NEVER surfaced.

def _ssh_base_args(dest: str, sshport: int) -> list[str]:
    return [
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=8", "-p", str(sshport), dest,
    ]


def _flatten_for_cli(messages: list[dict]) -> str:
    """Collapse a chat history into one prompt for a one-shot CLI runtime: a lone
    user turn passes straight through; multi-turn becomes a short transcript."""
    real = [m for m in messages if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()]
    if len(real) <= 1:
        return (real[0].get("content", "").strip() if real else "")
    lines = [("User" if m["role"] == "user" else "Assistant") + ": " + m["content"].strip() for m in real]
    lines.append("\nContinue the conversation — reply to the latest User message only.")
    return "\n".join(lines)


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
    base = await _effective_base(cfg)  # opens the SSH tunnel if configured
    if not base:
        raise IntegrationError(f"'{key}' has no endpoint configured")

    model = (cfg.get("model") or "").strip() or _DEFAULT_MODEL.get(key, "")
    body: dict = {"messages": messages, "stream": False}
    if model:
        body["model"] = model

    try:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
            resp = await client.post(base + "/v1/chat/completions", json=body, headers=_auth_headers(cfg))
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
