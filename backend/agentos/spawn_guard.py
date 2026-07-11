"""Child-process environment scrub (Sandbox — Feature 2, part A).

Every child this app spawns — the SDK's `claude`, git, `bash.exe -lc`, and the
env-scan `<tool> --version` probes — funnels through `subprocess.Popen`, and the
Claude SDK *merges* `os.environ` into the child's environment (so a caller can't
make the child "start empty"). The one reliable chokepoint is therefore the same
`subprocess.Popen.__init__` monkeypatch that `desktop/app.py:_suppress_child_windows`
uses for CREATE_NO_WINDOW. This module installs a second, composable layer on that
patch that rebuilds the child env down to an ALLOWLIST, so master tokens / API keys
that live in `os.environ` never reach an agent-controlled child.

Design notes:
  * ALLOWLIST, not denylist — everything unlisted is dropped, so a newly-added
    secret env var is safe by default. Secret-shaped names (`*_API_KEY`,
    `*_TOKEN`, `*_SECRET`, `AWS_*`, and the known auth vars) are additionally
    hard-denied so a future allowlist widening can't leak them.
  * Escape hatch: the `sandbox:env_passthrough` settings key (comma / JSON list of
    var names) re-adds specific vars for a toolchain that genuinely needs one; an
    explicit passthrough wins over the secret-shaped hard-deny (operator's call).
  * Toggle: `sandbox:env_scrub` (default ON). When OFF the child env is left
    completely untouched.
  * The install is idempotent, and the entry point (`install_child_env_scrub`) is
    the single call the desktop and headless entrypoints both invoke.

The allowlist targets Windows (this app's platform); the toolchain (`claude`,
git, git-bash) needs only PATH/PATHEXT/SystemRoot/TEMP/USERPROFILE/… — all listed
— and local Claude auths via `~/.claude` (a file), so dropping ANTHROPIC_API_KEY
is safe.
"""

import json
import os
import sqlite3
import time

_SCRUB_KEY = "sandbox:env_scrub"
_PASSTHROUGH_KEY = "sandbox:env_passthrough"

# Compared case-insensitively (Windows env names are case-insensitive); the
# original key casing is preserved when the scrubbed env dict is rebuilt.
_ALLOWLIST = {
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
    "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "PROGRAMW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    "USERNAME", "USERDOMAIN", "NO_COLOR",
}
# WebView2 child processes (msedgewebview2.exe) read these; keep them intentional.
_ALLOW_PREFIXES = ("WEBVIEW2_",)

_SECRET_SUFFIXES = ("_API_KEY", "_TOKEN", "_SECRET")
_SECRET_PREFIXES = ("AWS_",)
_SECRET_EXACT = {
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY",
    "GITHUB_TOKEN", "GH_TOKEN", "AGENTOS_TOKEN",
}

# The settings-table read runs from inside the Popen patch (the event-loop thread
# spawns children), so cache it on a short TTL: at most one tiny indexed SQLite
# read per this many seconds rather than one per spawn.
_SETTINGS_TTL = 2.0
_settings_cache: dict = {"ts": -1.0, "scrub": True, "passthrough": frozenset()}


def _coerce_bool(raw, default: bool) -> bool:
    if raw is None:
        return default
    try:
        v = json.loads(raw)
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return bool(v)
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes", "on")
    except (TypeError, ValueError):
        pass
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _parse_passthrough(raw) -> frozenset:
    if not raw:
        return frozenset()
    names: list = []
    parsed = None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, list):
        names = [str(x) for x in parsed]
    elif isinstance(parsed, str) and parsed.strip():
        names = parsed.split(",")
    else:
        names = str(raw).split(",")
    return frozenset(n.strip().upper() for n in names if n and n.strip())


def _load_settings() -> None:
    """Refresh the cached scrub toggle + passthrough set (TTL-bounded).

    Reads the SQLite settings table directly with a short-lived sync connection —
    mirrors config._read_security_lan_setting, and required because this runs at
    spawn time (possibly before the async DB layer connects). Any failure
    (missing DB/table, lock) fails SAFE: scrub stays ON, passthrough empty."""
    now = time.monotonic()
    if _settings_cache["ts"] >= 0 and now - _settings_cache["ts"] < _SETTINGS_TTL:
        return
    scrub = True
    passthrough: frozenset = frozenset()
    try:
        from .config import settings

        db_path = settings.db_path
        if db_path.exists():  # never let a probe create an empty db file
            con = sqlite3.connect(str(db_path), timeout=0.5)
            try:
                rows = con.execute(
                    "SELECT key, value FROM settings WHERE key IN (?, ?)",
                    (_SCRUB_KEY, _PASSTHROUGH_KEY),
                ).fetchall()
            finally:
                con.close()
            vals = {k: v for k, v in rows}
            scrub = _coerce_bool(vals.get(_SCRUB_KEY), default=True)
            passthrough = _parse_passthrough(vals.get(_PASSTHROUGH_KEY))
    except Exception:  # noqa: BLE001 — never break a spawn; fail safe (scrub ON)
        scrub = True
        passthrough = frozenset()
    _settings_cache.update(ts=now, scrub=scrub, passthrough=passthrough)


def _is_secret_shaped(up: str) -> bool:
    if up in _SECRET_EXACT:
        return True
    if any(up.endswith(s) for s in _SECRET_SUFFIXES):
        return True
    if any(up.startswith(p) for p in _SECRET_PREFIXES):
        return True
    return False


def _is_allowed(name: str, passthrough: frozenset) -> bool:
    up = name.upper()
    if up in passthrough:  # explicit escape hatch wins over everything
        return True
    if _is_secret_shaped(up):  # hard-deny secrets even if an allowlist widens
        return False
    if up in _ALLOWLIST:
        return True
    return any(up.startswith(p) for p in _ALLOW_PREFIXES)


def _scrub_env(base, passthrough: frozenset) -> dict:
    """Rebuild an env mapping down to the allowlist (+ passthrough). Preserves the
    original key casing so case-sensitive consumers on non-Windows still resolve."""
    result: dict = {}
    try:
        items = list(base.items())
    except Exception:  # noqa: BLE001 — unexpected mapping type; leave it be
        return dict(base) if isinstance(base, dict) else {}
    for name, value in items:
        try:
            if _is_allowed(str(name), passthrough):
                result[name] = value
        except Exception:  # noqa: BLE001 — one odd key can't abort the whole scrub
            continue
    return result


def install_child_env_scrub() -> None:
    """Install the env-scrub layer on subprocess.Popen. Idempotent, and safe to
    call alongside desktop/app.py's _suppress_child_windows patch (they compose —
    each only touches its own kwargs). This is the single entry the desktop and
    headless entrypoints both call; the actual call sites are wired elsewhere."""
    try:
        import subprocess
    except Exception:  # noqa: BLE001 — nothing to guard without subprocess
        return
    orig_init = subprocess.Popen.__init__
    if getattr(orig_init, "_agentos_env_scrub", False):
        return  # already installed

    def _init(self, *args, **kwargs):
        try:
            _load_settings()
            if _settings_cache["scrub"]:
                # env absent OR None => the child would inherit the full os.environ;
                # an explicit dict is scrubbed in place. Either way, rebuild it.
                if "env" in kwargs and kwargs["env"] is not None:
                    base = kwargs["env"]
                else:
                    base = os.environ
                kwargs["env"] = _scrub_env(base, _settings_cache["passthrough"])
        except Exception:  # noqa: BLE001 — a scrub failure must never block a spawn
            pass
        return orig_init(self, *args, **kwargs)

    _init._agentos_env_scrub = True  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = _init  # type: ignore[assignment]


def _reset_cache() -> None:
    """Test hook: force the next spawn to re-read the settings toggle."""
    _settings_cache.update(ts=-1.0, scrub=True, passthrough=frozenset())
