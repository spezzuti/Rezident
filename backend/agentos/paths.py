"""Frozen-aware path resolution.

One switch — is_frozen() — separates two run modes that share a single codebase:

  * dev     : run from the repo. State lives in <repo>/data, read-only assets
              (the built SPA) come from the repo tree, config from backend/.env.
  * frozen  : the packaged desktop app (PyInstaller). State lives in
              %LOCALAPPDATA%\\Rezident (the install dir under Program Files is
              read-only), and assets are unpacked under sys._MEIPASS.

Everything that needs a writable dir or a bundled resource resolves through
here so the frozen build "just works" while dev stays byte-for-byte identical.
"""

import os
import sys
from pathlib import Path

# In dev, config.py/main.py live at <repo>/backend/agentos/*.py.
# In a frozen build they live at <_MEIPASS>/agentos/*.py, so these two are only
# meaningful in dev — frozen paths go through resource_dir()/default_data_dir().
BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


def is_frozen() -> bool:
    """True when running inside a PyInstaller (or similar) bundle."""
    return bool(getattr(sys, "frozen", False))


def is_desktop() -> bool:
    """Desktop mode: the packaged app (frozen) OR desktop-from-source, which the
    launcher opts into with AGENTOS_DESKTOP=1. Desktop mode redirects writes to
    %LOCALAPPDATA%, binds loopback, and self-provisions a token instead of
    reading backend/.env — so running the launcher from source behaves exactly
    like the installed app (and is testable without building the exe)."""
    return is_frozen() or os.environ.get("AGENTOS_DESKTOP", "").lower() in ("1", "true", "yes")


def resource_dir() -> Path:
    """Root under which bundled read-only resources (frontend/dist) live.

    PyInstaller unpacks datas under sys._MEIPASS; in dev the repo root holds them.
    """
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", str(BACKEND_DIR)))
    return PROJECT_DIR


def frontend_dist() -> Path:
    """The built SPA that main.py serves at '/'."""
    return resource_dir() / "frontend" / "dist"


def _local_appdata() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    return Path(base) if base else Path.home() / "AppData" / "Local"


def app_home() -> Path:
    """Per-user home for the packaged app: %LOCALAPPDATA%\\Rezident."""
    home = _local_appdata() / "Rezident"
    _migrate_legacy_home(home)
    return home


_home_migrated = False


def _migrate_legacy_home(home: Path) -> None:
    """Rename-era shim: installs from the AgentOS days keep their state. Moves
    the old %LOCALAPPDATA%\\AgentOS\\data (db, token, worktrees) into the new
    home. The data dir specifically — the desktop shell may have already
    created <home>\\logs before this runs, so testing the home dir alone would
    skip a needed migration. A locked/failed rename falls back to a fresh home."""
    global _home_migrated
    if _home_migrated:
        return
    _home_migrated = True
    old = _local_appdata() / "AgentOS" / "data"
    new = home / "data"
    if old.exists() and not new.exists():
        try:
            home.mkdir(parents=True, exist_ok=True)
            old.rename(new)
        except OSError:
            pass


def default_data_dir() -> Path:
    """Where the app writes its state (db, worktrees, scratch, token, runtime.json)."""
    if is_desktop():
        return app_home() / "data"
    return PROJECT_DIR / "data"


def env_file() -> Path | None:
    """Dev loads backend/.env; desktop mode ships none (env vars + generated token)."""
    if is_desktop():
        return None
    return BACKEND_DIR / ".env"


def default_host() -> str:
    """Desktop app is loopback-only (no firewall prompt); dev keeps the LAN
    bind for the existing phone/Tailscale workflow. Either way the Bearer token
    gates access; override with AGENTOS_HOST."""
    return "127.0.0.1" if is_desktop() else "0.0.0.0"
