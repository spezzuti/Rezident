"""Sensitive-path tool guard (Sandbox — Feature 2, part B).

`is_denied(tool_name, tool_input)` is the decision function behind a PreToolUse
deny hook. It fires for EVERY tool — including the pre-allowed Read/Glob/Grep that
skip the approval gate — so it is the layer that closes the ungated-read leak to
the on-disk secrets (`backend/.env`, `<data_dir>/token`, `agentos.db`, `~/.claude`,
`~/.ssh`).

Policy:
  * Read/Glob/Grep/NotebookEdit/Write/Edit/MultiEdit — resolve the path-shaped
    fields (file_path/path/pattern/glob/notebook_path) and deny when the target is
    (or lives inside) a denylisted path OR is a search root that CONTAINS one, via a
    bidirectional approvals._path_within containment test, plus a scan against the
    RESOLVED absolute-path tokens. The write tools are covered too, so a protected
    path can't be clobbered. Deliberately NOT the bare `.claude`/`.ssh`/`agentos.db`
    substrings — containment already pins the real ~/.claude, ~/.ssh and data-dir
    precisely, and the bare substrings would over-block a repo task on any project
    that merely contains a `.claude/` dir.
  * WebFetch — file:// URLs can read local files, so they run through the same
    path check; http(s) URLs whose host is/resolves to an internal address
    (loopback, link-local incl. the 169.254.169.254 metadata IP, or private/reserved)
    are denied as an SSRF bar-raiser; normal public URLs fall to the fetch path.
  * Bash — scan the command string for any denylisted path token (normalized,
    case-insensitive, substring). This is a bar-raiser, not a sandbox: env-var
    expansion can evade a substring scan, so deny generously on ambiguity;
    env-scrub + secrets-in-DB are the defense-in-depth behind it.
  * Toggle: `sandbox:path_guard` (default ON). When OFF, returns None for all.
  * Denylist seed = `sandbox:denylist` (extra entries) + built-in defaults.

Contract: NEVER throws — every path returns a deterministic decision (a reason
string to deny, or None to allow). The per-branch deny logic is self-contained and
does not depend on the outer catch; the outer catch only guards against a truly
unexpected internal error, in which case it fails open (env-scrub + DB-stored
secrets remain as defense-in-depth) rather than bricking the agent.
"""

import ipaddress
import json
import re
import socket
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlsplit

from .approvals import _path_within

_PATH_GUARD_KEY = "sandbox:path_guard"
_DENYLIST_KEY = "sandbox:denylist"

# Path-shaped tool-input fields to test (Read.file_path; Glob/Grep.path/pattern/glob).
_PATH_FIELDS = ("file_path", "path", "pattern", "glob")

# Distinctive tokens matched anywhere in a normalized command/field. `.env` and the
# token file use lookahead-guarded regexes so they don't fire on `os.environ`,
# `.environment`, `/tokens`, `token_store`, etc.
_ENV_RE = re.compile(r"\.env(?![a-z0-9])")
_TOKEN_RE = re.compile(r"/token(?![a-z0-9._\-])")
_PLAIN_TOKENS = (".ssh", ".claude", "agentos.db")

_SETTINGS_TTL = 2.0
_cache: dict = {"ts": -1.0, "guard": True, "paths": None, "tokens": None}


def _norm(s) -> str:
    return str(s).replace("\\", "/").lower()


def _resolve(p) -> Path:
    return Path(p).expanduser().resolve()


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


def _parse_denylist_setting(raw) -> list:
    if not raw:
        return []
    parsed = None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, list):
        entries = [str(x) for x in parsed]
    elif isinstance(parsed, str) and parsed.strip():
        entries = parsed.split(",")
    else:
        entries = str(raw).split(",")
    return [e.strip() for e in entries if e and e.strip()]


def _default_denylist_paths() -> list:
    from .config import settings
    from .paths import BACKEND_DIR

    paths = [BACKEND_DIR / ".env"]
    try:
        paths.append(settings.token_path)
        paths.append(settings.db_path)
    except Exception:  # noqa: BLE001 — settings always resolvable, but stay safe
        pass
    paths.append(Path.home() / ".claude")
    paths.append(Path.home() / ".ssh")
    return paths


def _build_denylist(extra: list) -> tuple:
    """Return (paths, tokens): expanded Path objects for containment tests + a set
    of normalized absolute-path substring tokens (plus the agentos.db WAL/SHM
    siblings) for the command/field scan."""
    from .paths import PROJECT_DIR

    paths: list = []
    for p in _default_denylist_paths():
        try:
            paths.append(Path(p).expanduser())
        except Exception:  # noqa: BLE001
            continue
    for e in extra:
        try:
            ep = Path(str(e)).expanduser()
            if not ep.is_absolute():
                ep = PROJECT_DIR / ep
            paths.append(ep)
        except Exception:  # noqa: BLE001
            continue

    tokens: set = set()
    for p in paths:
        try:
            tokens.add(_norm(_resolve(p)))
        except Exception:  # noqa: BLE001
            continue
    # agentos.db* siblings (WAL/SHM/journal are separate files, not "within" the db)
    try:
        from .config import settings

        db = _norm(_resolve(settings.db_path))
        for suf in ("-wal", "-shm", "-journal"):
            tokens.add(db + suf)
    except Exception:  # noqa: BLE001
        pass
    tokens = {t for t in tokens if len(t) >= 5}
    return paths, tokens


def _load_cache() -> None:
    """Refresh the cached toggle + built denylist (TTL-bounded). Sync SQLite read
    like config._read_security_lan_setting; fails SAFE (guard ON) on any error."""
    now = time.monotonic()
    if _cache["ts"] >= 0 and now - _cache["ts"] < _SETTINGS_TTL:
        return
    guard = True
    extra: list = []
    try:
        from .config import settings

        db_path = settings.db_path
        if db_path.exists():
            con = sqlite3.connect(str(db_path), timeout=0.5)
            try:
                rows = con.execute(
                    "SELECT key, value FROM settings WHERE key IN (?, ?)",
                    (_PATH_GUARD_KEY, _DENYLIST_KEY),
                ).fetchall()
            finally:
                con.close()
            vals = {k: v for k, v in rows}
            guard = _coerce_bool(vals.get(_PATH_GUARD_KEY), default=True)
            extra = _parse_denylist_setting(vals.get(_DENYLIST_KEY))
    except Exception:  # noqa: BLE001 — fail safe: guard ON, defaults only
        guard = True
        extra = []
    paths, tokens = _build_denylist(extra)
    _cache.update(ts=now, guard=guard, paths=paths, tokens=tokens)


def _reason(what: str) -> str:
    return (
        f"Blocked by the Rezident sandbox path guard: access to a protected path "
        f"('{what}') is denied. Disable it under Settings › Sandbox (sandbox:path_guard) "
        f"if this is intentional."
    )


def _scan_denied(text, tokens: set, include_plain: bool = True):
    """Substring/token scan of a normalized command or field value; returns a
    reason on the first hit, else None. `include_plain` gates the bare
    `.claude`/`.ssh`/`agentos.db` substrings — ON for Bash (no containment on a
    command string), OFF for path-shaped fields (containment handles those precisely,
    so the bare substrings would over-block project-local `.claude` dirs)."""
    if not isinstance(text, str) or not text.strip():
        return None
    n = _norm(text)
    for t in tokens:
        if t and t in n:
            return _reason(t)
    if include_plain:
        for tok in _PLAIN_TOKENS:
            if tok in n:
                return _reason(tok)
    if _ENV_RE.search(n):
        return _reason(".env")
    if _TOKEN_RE.search(n):
        return _reason("token file")
    return None


def _field_denied(value, paths: list, tokens: set):
    """Deny a path-shaped Read/Glob/Grep field: containment against the denylist
    (target is, or is inside, a protected path) plus the token/substring scan."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        target = str(Path(value).expanduser())
    except Exception:  # noqa: BLE001
        target = None
    if target is not None:
        for d in paths:
            try:
                # Bidirectional containment. Direction 1 (target inside/equals d):
                # a Read/Write of a protected file or something under a protected
                # dir. Direction 2 (d inside target): a search ROOT that contains a
                # protected path — e.g. Grep(path="<data_dir>") over a denylisted
                # "<data_dir>/token", or a search rooted at ~ that would sweep
                # ~/.ssh / ~/.claude / backend/.env. Direction 2 only fires when a
                # denylisted absolute path actually resolves under `target`, so a
                # normal workspace (or a project-local `.claude`, which isn't on the
                # denylist) is unaffected.
                if _path_within(target, str(d)) or _path_within(str(d), target):
                    return _reason(str(d))
            except Exception:  # noqa: BLE001
                continue
    # Path fields: containment (above) + resolved absolute-path tokens ONLY — NOT the
    # bare .claude/.ssh substrings, which would over-block a project-local .claude dir.
    return _scan_denied(value, tokens, include_plain=False)


def _ip_is_internal(ip_str) -> bool:
    """True when a literal address string is loopback / link-local (incl. the
    169.254.169.254 cloud-metadata endpoint) / private / otherwise reserved. Any
    unparseable value is NOT internal (returns False) so a real hostname isn't
    mistaken for a blocked address here."""
    try:
        ip = ipaddress.ip_address(str(ip_str).strip())
    except ValueError:
        return False
    # Unwrap IPv4-mapped/-compatible IPv6 (e.g. ::ffff:127.0.0.1) so a v4 private
    # target can't hide behind a v6 wrapper.
    try:
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
    except Exception:  # noqa: BLE001
        pass
    return bool(
        ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip.is_reserved
        or ip.is_unspecified
        or ip.is_multicast
    )


def _webfetch_ssrf_denied(url):
    """Deny an http(s) WebFetch whose host is/resolves to an internal address —
    loopback, link-local (incl. the 169.254.169.254 cloud-metadata IP), or a
    private/reserved range — to blunt SSRF against local services and metadata.
    Conservative and non-throwing: a public host, an unresolvable name, or any
    parse/lookup hiccup returns None (allow) and falls through to the normal fetch."""
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        parts = urlsplit(url.strip())
        scheme = (parts.scheme or "").lower()
        if scheme not in ("http", "https"):
            return None
        host = parts.hostname
        if not host:
            return None
        host = host.strip().strip(".")
        if not host:
            return None
        # Literal IP host (v4 or v6, incl. bracketed [::1] → "::1" via hostname).
        if _ip_is_internal(host):
            return _reason(host)
        low = host.lower()
        if low == "localhost" or low.endswith(".localhost"):
            return _reason(host)
        # Named host: deny if ANY resolved address is internal (a lookup failure
        # leaves it to the normal fetch path rather than blocking a public URL).
        try:
            infos = socket.getaddrinfo(host, None)
        except Exception:  # noqa: BLE001 — unresolvable/lookup error: don't block
            return None
        for info in infos:
            try:
                addr = info[4][0]
            except (IndexError, TypeError):
                continue
            if _ip_is_internal(addr):
                return _reason(host)
        return None
    except Exception:  # noqa: BLE001 — non-throwing contract: allow on any surprise
        return None


def is_denied(tool_name, tool_input):
    """Return a deny-reason string if the tool call touches a protected path, else
    None. Never raises."""
    try:
        _load_cache()
        if not _cache["guard"]:
            return None
        if not isinstance(tool_input, dict):
            return None
        paths = _cache["paths"] or []
        tokens = _cache["tokens"] or set()
        name = tool_name or ""
        # Write/Edit/MultiEdit carry the target in `file_path` (MultiEdit too), so
        # they run through the same containment/token check as Read/Glob/Grep — a
        # protected path is off-limits to write as well as read.
        if name in (
            "Read", "Glob", "Grep", "NotebookEdit", "Write", "Edit", "MultiEdit"
        ):
            for fld in _PATH_FIELDS + ("notebook_path",):
                reason = _field_denied(tool_input.get(fld), paths, tokens)
                if reason:
                    return reason
            return None
        if name == "Bash":
            return _scan_denied(tool_input.get("command"), tokens)
        if name == "WebFetch":
            url = tool_input.get("url")
            if isinstance(url, str) and url.strip().lower().startswith("file:"):
                local = re.sub(r"^file:/*", "/", url.strip(), flags=re.IGNORECASE)
                return _field_denied(local, paths, tokens)
            return _webfetch_ssrf_denied(url)
        return None
    except Exception:  # noqa: BLE001 — deterministic non-throwing contract; the
        # per-branch deny logic above never reaches here, so this only guards an
        # unexpected internal error, failing open behind env-scrub + DB secrets.
        return None


def _reset_cache() -> None:
    """Test hook: force the next is_denied to re-read settings + rebuild the list."""
    _cache.update(ts=-1.0, guard=True, paths=None, tokens=None)
