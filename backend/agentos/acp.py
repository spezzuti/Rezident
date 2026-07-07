"""ACP (Agent Client Protocol) client over SSH stdio.

Hermes exposes `hermes acp` — a JSON-RPC 2.0 agent over stdio, newline-delimited
(the same protocol Zed/JetBrains speak). We run it on the remote box via
`ssh -T <dest> hermes acp` and talk ACP over the pipe:

    initialize -> session/new -> session/prompt   (streams session/update)

This gives what the one-shot `hermes -z` CLI can't: a native multi-turn session
(server-side context/memory), token-level streaming, and tool-call visibility.

Verified against hermes-agent 0.17.0. Remote stderr (startup logs that include the
box's secret NAMES) is DISCARDED — never surfaced or persisted.
"""

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger(__name__)

UpdateCb = Callable[[dict[str, Any]], Awaitable[None]]


class AcpError(RuntimeError):
    pass


class AcpClient:
    """One `hermes acp` subprocess (over SSH) and its JSON-RPC session. Not
    thread-safe; drive it from a single asyncio task."""

    def __init__(self, ssh_dest: str, ssh_port: int = 22, cmd: str = "hermes acp") -> None:
        self.ssh_dest = ssh_dest
        self.ssh_port = ssh_port
        self.cmd = cmd
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader: Optional[asyncio.Task] = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 0
        self._on_update: Optional[UpdateCb] = None
        self.agent_info: dict[str, Any] = {}
        self.capabilities: dict[str, Any] = {}

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> dict[str, Any]:
        """Launch the remote agent and run the initialize handshake."""
        args = [
            "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=8",
            "-p", str(self.ssh_port), self.ssh_dest, self.cmd,
        ]
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,  # remote logs + secret names — drop them
            )
        except FileNotFoundError:
            raise AcpError("ssh not found — install an OpenSSH client for the ACP transport")
        self._reader = asyncio.create_task(self._read_loop())
        res = await self._call("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
        }, timeout=30)
        self.agent_info = res.get("agentInfo", {})
        self.capabilities = res.get("agentCapabilities", {})
        return res

    async def new_session(self, cwd: str = "/tmp") -> str:
        res = await self._call("session/new", {"cwd": cwd, "mcpServers": []}, timeout=60)
        sid = res.get("sessionId")
        if not sid:
            raise AcpError("session/new returned no sessionId")
        return sid

    async def prompt(self, session_id: str, text: str, on_update: UpdateCb, timeout: float = 300) -> dict[str, Any]:
        """Send one turn; on_update is awaited for every session/update while it runs.
        Returns the result ({stopReason, usage})."""
        self._on_update = on_update
        try:
            return await self._call("session/prompt", {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}],
            }, timeout=timeout)
        finally:
            self._on_update = None

    async def cancel(self, session_id: str) -> None:
        try:
            await self._notify("session/cancel", {"sessionId": session_id})
        except Exception:  # noqa: BLE001 — best-effort
            log.debug("session/cancel failed", exc_info=True)

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        proc = self._proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(AcpError("ACP connection closed"))
        self._pending.clear()

    # -- JSON-RPC plumbing ---------------------------------------------------

    async def _send(self, obj: dict[str, Any]) -> None:
        if not self._proc or self._proc.stdin is None or self._proc.stdin.is_closing():
            raise AcpError("ACP process is not running")
        self._proc.stdin.write((json.dumps(obj) + "\n").encode())
        await self._proc.stdin.drain()

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _call(self, method: str, params: dict[str, Any], timeout: float = 60) -> dict[str, Any]:
        self._next_id += 1
        mid = self._next_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        try:
            msg = await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(mid, None)
        if "error" in msg:
            raise AcpError(f"{method} failed: {json.dumps(msg['error'])[:200]}")
        return msg.get("result", {})

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue  # non-JSON stray line — ignore
                mid = msg.get("id")
                if mid is not None and ("result" in msg or "error" in msg):
                    fut = self._pending.get(mid)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif msg.get("method"):
                    await self._handle_incoming(msg)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.debug("ACP read loop ended", exc_info=True)
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(AcpError("ACP stream ended"))

    async def _handle_incoming(self, msg: dict[str, Any]) -> None:
        method = msg["method"]
        mid = msg.get("id")
        if method == "session/update":
            if self._on_update:
                try:
                    await self._on_update(msg.get("params", {}).get("update", {}))
                except Exception:  # noqa: BLE001 — a bad update must not kill the reader
                    log.debug("on_update handler failed", exc_info=True)
            return
        # agent -> client REQUESTS (carry an id, must be answered or the agent blocks)
        if mid is not None:
            if method == "session/request_permission":
                # redacted is the user's own agent with its own tools/permissions; it's
                # driven here on purpose, so auto-allow. Tool calls are surfaced to the
                # UI as tool_use events so the operator still SEES what it does.
                opts = msg.get("params", {}).get("options", [])
                pick = next((o["optionId"] for o in opts if str(o.get("kind", "")).startswith("allow")),
                            (opts[0]["optionId"] if opts else None))
                if pick is not None:
                    await self._send({"jsonrpc": "2.0", "id": mid, "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
                else:
                    await self._send({"jsonrpc": "2.0", "id": mid, "result": {"outcome": {"outcome": "cancelled"}}})
            else:
                # fs/read_text_file, fs/write_text_file, terminal/* — not offered by us
                await self._send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "not supported by the AgentOS ACP client"}})
