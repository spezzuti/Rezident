"""RELAY — dormant reverse-tunnel hook (DESIGN-ONLY drop-in).

Gives Rezident a public https/wss address without a static IP or a router port
forward: a small reverse-tunnel client (rathole or frp) dials OUT to a cheap VPS
and the VPS forwards inbound public traffic back down that tunnel to this box's
loopback service (127.0.0.1:<settings.port>). A Caddy reverse proxy on the VPS
fronts it with automatic Let's Encrypt TLS, so the bearer token never crosses
plaintext. The full operator guide — VPS, rathole/frp SERVER config, Caddy
auto-TLS + ?token= access-log redaction — is docs/RELAY.md.

The client side of the app needs NOTHING: a relay is just a plain remote
connection (ws.ts auto-upgrades https->wss), and pairing already advertises a
public URL via PairStartBody.base_url. So this module is the whole desktop
footprint, and it is deliberately inert:

  * OFF BY DEFAULT. start_relay() is a clean no-op unless relay:config.enabled is
    explicitly set — nothing activates without operator config.
  * Fully guarded. Neither start_relay() nor shutdown_relay() ever raises; a
    misconfigured relay logs a warning and the app boots/quits exactly as today.

The managed-subprocess shape mirrors integrations.py's SSH tunnels: spawn via
asyncio.create_subprocess_exec (so the desktop's window-suppressing subprocess
.Popen patch covers the child), a bounded health-wait loop that polls the
forwarded loopback port while watching for an early client exit, a small registry
so shutdown can terminate the child. A later agent wires start_relay() into
main.lifespan() startup and shutdown_relay() beside shutdown_tunnels().
"""

import asyncio
import json
import logging
import shutil
import socket
from pathlib import Path

from .config import settings
from .db import db

log = logging.getLogger("agentos.relay")

# relay:config lives in the settings table as JSON, mirroring the integration
# slots. OFF BY DEFAULT — this whole feature is dormant until an operator fills it
# in per docs/RELAY.md. Fields:
#   enabled  — master switch; False means start_relay() no-ops
#   endpoint — "host:port" of the rathole/frp SERVER's control port on the VPS
#   token    — shared secret the tunnel authenticates with (rathole default_token
#              / frp auth.token); NOT the app's bearer token
#   client   — "rathole" (default) | "frp"
#   bin_path — explicit path to the rathole/frpc executable (else resolved on PATH)
_RELAY_KEY = "relay:config"
_DEFAULT_CONFIG = {
    "enabled": False,
    "endpoint": "",
    "token": "",
    "client": "rathole",
    "bin_path": "",
}

# At most one live relay child per process, held in a registry that mirrors
# integrations._tunnels so the shutdown path is identical in shape.
_relay: dict = {}  # {"proc": <asyncio subprocess>, "config_path": Path}


async def _load_config() -> dict:
    """relay:config merged over the disabled default. Any read failure — the db
    not yet connected, a missing settings table, malformed JSON — degrades to the
    default so start_relay() stays a no-op. Never raises."""
    cfg = dict(_DEFAULT_CONFIG)
    try:
        row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_RELAY_KEY,))
    except Exception:  # noqa: BLE001 — a boot-time relay read must never break startup
        return cfg
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, ValueError):
            pass
    return cfg


def _is_frp(cfg: dict) -> bool:
    return (cfg.get("client") or "").strip().lower() == "frp"


def _client_binary(cfg: dict) -> str | None:
    """The rathole/frpc executable: an explicit bin_path wins (also lets an
    operator pin a portable single-file download); else PATH. Returns None when
    nothing is found so start_relay() logs and no-ops instead of crashing."""
    override = (cfg.get("bin_path") or "").strip()
    if override:
        p = Path(override)
        return str(p) if p.exists() else None  # explicit-but-dead path fails loudly, no fallback
    return shutil.which("frpc" if _is_frp(cfg) else "rathole")


def _render_client_config(cfg: dict, port: int) -> str:
    """The rathole/frp CLIENT config forwarding the public endpoint to the local
    loopback service (127.0.0.1:<port>). Both tools drive their reverse tunnels
    from a TOML file, not argv — this is the same file an operator would hand-write
    following docs/RELAY.md's SERVER section, generated so a config flip is enough."""
    endpoint = (cfg.get("endpoint") or "").strip()
    token = (cfg.get("token") or "").strip()
    if _is_frp(cfg):
        host, _, server_port = endpoint.partition(":")
        return (
            f'serverAddr = "{host}"\n'
            f"serverPort = {server_port or 7000}\n"
            f'auth.token = "{token}"\n\n'
            "[[proxies]]\n"
            'name = "rezident"\n'
            'type = "tcp"\n'
            'localIP = "127.0.0.1"\n'
            f"localPort = {port}\n"
            # Caddy on the VPS fronts this same loopback port (see docs/RELAY.md).
            f"remotePort = {port}\n"
        )
    # rathole (default): the server owns the public bind_addr, so the client only
    # names the control endpoint, the shared token, and the local service.
    return (
        "[client]\n"
        f'remote_addr = "{endpoint}"\n'
        f'default_token = "{token}"\n\n'
        "[client.services.rezident]\n"
        f'local_addr = "127.0.0.1:{port}"\n'
    )


def _client_args(cfg: dict, binary: str, config_path: Path) -> list[str]:
    """rathole reads `rathole <cfg>`; frp reads `frpc -c <cfg>`."""
    if _is_frp(cfg):
        return [binary, "-c", str(config_path)]
    return [binary, str(config_path)]


def _port_open(port: int) -> bool:
    """True if 127.0.0.1:<port> accepts a connection right now (the loopback
    service the tunnel forwards to). Mirrors the integrations health check."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


async def start_relay() -> None:
    """Launch the reverse-tunnel client when relay:config.enabled — otherwise a
    clean no-op (the default). Fully guarded: every failure is logged and
    swallowed so a misconfigured relay can never keep the app from booting.

    Modeled on the managed SSH-tunnel pattern in integrations.py: spawn via
    asyncio.create_subprocess_exec (so the desktop's window-suppressing Popen patch
    covers the child), health-wait by polling the forwarded loopback port while
    watching for an early client exit, register the child for shutdown_relay()."""
    try:
        if _relay.get("proc") is not None and _relay["proc"].returncode is None:
            return  # already running — one relay per process

        cfg = await _load_config()
        if not cfg.get("enabled"):
            return  # OFF BY DEFAULT — nothing activates without operator config

        endpoint = (cfg.get("endpoint") or "").strip()
        if not endpoint:
            log.warning("relay enabled but no endpoint configured — not starting")
            return

        binary = _client_binary(cfg)
        if not binary:
            client = (cfg.get("client") or "rathole").strip()
            log.warning(
                "relay enabled but the %s client binary was not found "
                "(set relay:config.bin_path or put it on PATH) — not starting",
                client,
            )
            return

        settings.ensure_dirs()
        port = settings.port
        config_path = settings.scratch_dir / "relay-client.toml"
        try:
            config_path.write_text(_render_client_config(cfg, port), encoding="utf-8")
        except OSError as exc:
            log.warning("relay: could not write client config (%s) — not starting", exc)
            return

        args = _client_args(cfg, binary, config_path)
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            log.warning("relay: could not launch the tunnel client (%s) — not starting", exc)
            return

        # Health-wait: give the client a moment to establish. If it exits early
        # (bad endpoint/token/config) surface its stderr and give up cleanly; once
        # the forwarded loopback service accepts connections, treat the relay as up.
        for _ in range(24):
            await asyncio.sleep(0.15)
            if proc.returncode is not None:
                err = ""
                try:
                    err = (await proc.stderr.read()).decode(errors="replace").strip()
                except Exception:  # noqa: BLE001
                    pass
                log.warning(
                    "relay: tunnel client exited early (code %s) — %s",
                    proc.returncode, err[:200] or "no output",
                )
                return
            if _port_open(port):
                _relay["proc"] = proc
                _relay["config_path"] = config_path
                log.info("relay: reverse tunnel up via %s -> 127.0.0.1:%s", endpoint, port)
                return

        # Still alive but the loopback service hasn't confirmed yet (the app's own
        # uvicorn may bind only after lifespan startup finishes) — keep the child;
        # rathole/frp retry their control connection on their own.
        _relay["proc"] = proc
        _relay["config_path"] = config_path
        log.info(
            "relay: tunnel client running (loopback %s not yet confirmed) via %s",
            port, endpoint,
        )
    except Exception as exc:  # noqa: BLE001 — startup must never raise on the relay
        log.warning("relay: start_relay failed, continuing without a relay (%s)", exc)


async def shutdown_relay() -> None:
    """Terminate the relay child, if one is running. Mirrors shutdown_tunnels —
    guarded so a shutdown hiccup never propagates out of the lifespan teardown."""
    proc = _relay.get("proc")
    if proc is not None:
        try:
            proc.terminate()
        except (ProcessLookupError, OSError):
            pass
    _relay.clear()
