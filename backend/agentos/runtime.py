"""Runtime helpers for the standalone/desktop launchers: port selection and a
small on-disk descriptor of the running instance.

runtime.json holds NO secret — just url/host/port/pid — so an installer's
uninstaller or a second launch can find (and stop) the running app.
"""

import json
import os
import socket
from pathlib import Path

from .config import settings


def pick_port(host: str, preferred: int) -> int:
    """Return `preferred` if free, otherwise an OS-assigned ephemeral port.

    A tiny TOCTOU window exists between this probe and the server bind; for a
    single-user loopback desktop app that is acceptable and avoids a hard
    EADDRINUSE crash when the preferred port is taken.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            s.bind((host, preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def runtime_path() -> Path:
    return settings.data_dir / "runtime.json"


def read_runtime() -> dict | None:
    """The last-written instance descriptor, or None if absent/unreadable."""
    try:
        return json.loads(runtime_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def probe_running(timeout: float = 2.0) -> dict | None:
    """The runtime descriptor IF that instance actually answers, else None.
    This is the cross-session single-server guard: the boot service and a
    manually launched instance run in different Windows sessions, so the
    per-session mutex can't see them — a live HTTP health probe can. A stale
    runtime.json (crash/power loss) fails the probe and is ignored."""
    info = read_runtime()
    if not info or not info.get("port"):
        return None
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{info['port']}/api/health", timeout=timeout) as r:
            if r.status == 200:
                return info
    except Exception:  # noqa: BLE001 — any failure means "not running"
        pass
    return None


def write_runtime(host: str, port: int) -> None:
    settings.ensure_dirs()
    display = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    runtime_path().write_text(
        json.dumps({"url": f"http://{display}:{port}/", "host": host, "port": port, "pid": os.getpid()}),
        encoding="utf-8",
    )


def clear_runtime() -> None:
    try:
        runtime_path().unlink(missing_ok=True)
    except OSError:
        pass
