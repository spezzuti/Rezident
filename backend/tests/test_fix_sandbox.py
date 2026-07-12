"""Regression tests for the sandbox path-guard + spawn-guard hardening.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_fix_sandbox.py

Covers four fixes in agentos/sandbox.py + agentos/spawn_guard.py:

  FIX 1 (path guard, bidirectional containment) — a Grep/Glob rooted at the PARENT
    of a denylisted path used to slip through: containment only tested "target
    inside a denied path", never "denied path inside the search root". Now a search
    root that CONTAINS a denied path is denied too, without over-blocking a normal
    workspace that holds none.
  FIX 2 (WebFetch SSRF) — http(s) whose host is/resolves to loopback / link-local
    (incl. the 169.254.169.254 metadata IP) / private ranges is denied; public
    hosts stay allowed.
  FIX 3 (write tools) — Write/Edit/MultiEdit now run through the same containment
    check, so a protected path can't be clobbered.
  FIX 4 (spawn guard) — a secret-shaped env name stays dropped even when named in
    `sandbox:env_passthrough`; non-secret passthrough still works.

Hermetic: the denylist is injected straight into sandbox._cache (with _load_cache
stubbed for the duration) so no DB, no settings, and no real network are touched.
DNS-path SSRF cases stub sandbox.socket.getaddrinfo; literal-IP cases need nothing.
"""

import contextlib
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> agentos.*

from agentos import sandbox, spawn_guard  # noqa: E402


@contextlib.contextmanager
def _denylist(paths):
    """Seed the path guard with exactly `paths` as the denylist and hold it there
    (stub _load_cache so the TTL refresh can't clobber the seed). Restores the real
    loader + resets the cache on exit so later tests see live behavior."""
    orig_load = sandbox._load_cache
    resolved = [Path(p) for p in paths]
    tokens = set()
    for p in resolved:
        try:
            tokens.add(sandbox._norm(sandbox._resolve(p)))
        except Exception:  # noqa: BLE001
            pass
    tokens = {t for t in tokens if len(t) >= 5}
    sandbox._load_cache = lambda: None  # type: ignore[assignment]
    sandbox._cache.update(ts=time.monotonic(), guard=True, paths=resolved, tokens=tokens)
    try:
        yield
    finally:
        sandbox._load_cache = orig_load  # type: ignore[assignment]
        sandbox._reset_cache()


def _mkdirs():
    """Two sibling temp trees: a data dir holding the denylisted `token` file, and a
    separate workspace that contains NO denied path. Siblings => neither contains
    the other, so the workspace stays allowed."""
    data_dir = Path(tempfile.mkdtemp(prefix="fixsb_data_"))
    workspace = Path(tempfile.mkdtemp(prefix="fixsb_work_"))
    token = data_dir / "token"
    token.write_text("secret", encoding="utf-8")
    (workspace / "normal.txt").write_text("hello", encoding="utf-8")
    return data_dir, workspace, token


# --- FIX 1: search root that contains a denied path is denied -------------------

def test_grep_rooted_at_parent_of_denied_is_denied():
    data_dir, _work, token = _mkdirs()
    with _denylist([token]):
        # Grep/Glob rooted at data_dir, which CONTAINS the denylisted token file.
        assert sandbox.is_denied("Grep", {"path": str(data_dir)}) is not None
        assert sandbox.is_denied("Glob", {"path": str(data_dir)}) is not None


def test_direct_read_of_denied_file_still_denied():
    data_dir, _work, token = _mkdirs()
    with _denylist([token]):
        assert sandbox.is_denied("Read", {"file_path": str(token)}) is not None


def test_read_inside_denied_dir_still_denied():
    # A denylisted DIRECTORY: a read of a file *under* it is denied (direction 1).
    secret_dir = Path(tempfile.mkdtemp(prefix="fixsb_secret_"))
    inner = secret_dir / "inner" / "creds"
    inner.parent.mkdir(parents=True, exist_ok=True)
    inner.write_text("x", encoding="utf-8")
    with _denylist([secret_dir]):
        assert sandbox.is_denied("Read", {"file_path": str(inner)}) is not None
        # ...and a search rooted at the denied dir's parent is denied (direction 2).
        assert sandbox.is_denied("Grep", {"path": str(secret_dir.parent)}) is not None


def test_normal_workspace_reads_and_greps_are_allowed():
    data_dir, workspace, token = _mkdirs()
    with _denylist([token]):
        assert sandbox.is_denied("Read", {"file_path": str(workspace / "normal.txt")}) is None
        assert sandbox.is_denied("Grep", {"path": str(workspace)}) is None
        assert sandbox.is_denied("Glob", {"path": str(workspace), "pattern": "**/*.py"}) is None


# --- FIX 3: write tools are containment-checked ---------------------------------

def test_write_edit_multiedit_into_denied_path_denied():
    data_dir, workspace, token = _mkdirs()
    with _denylist([token]):
        assert sandbox.is_denied("Write", {"file_path": str(token)}) is not None
        assert sandbox.is_denied("Edit", {"file_path": str(token)}) is not None
        assert sandbox.is_denied("MultiEdit", {"file_path": str(token)}) is not None
        # A write into the denied dir's parent that targets the denied file's dir.
        assert sandbox.is_denied("Write", {"file_path": str(data_dir)}) is not None
        # A write into the normal workspace stays allowed.
        assert sandbox.is_denied("Write", {"file_path": str(workspace / "out.txt")}) is None


# --- FIX 2: WebFetch SSRF -------------------------------------------------------

def test_webfetch_literal_internal_ip_denied():
    # No DNS needed for literal IPs.
    with _denylist([]):
        assert sandbox.is_denied("WebFetch", {"url": "http://127.0.0.1/"}) is not None
        assert sandbox.is_denied("WebFetch", {"url": "http://169.254.169.254/latest/meta-data/"}) is not None
        assert sandbox.is_denied("WebFetch", {"url": "http://[::1]/"}) is not None
        assert sandbox.is_denied("WebFetch", {"url": "http://10.0.0.5:8080/x"}) is not None
        assert sandbox.is_denied("WebFetch", {"url": "http://localhost:9000/"}) is not None


def test_webfetch_public_ip_allowed():
    with _denylist([]):
        # Numeric public host => getaddrinfo is a local parse, no real network.
        assert sandbox.is_denied("WebFetch", {"url": "http://8.8.8.8/"}) is None


def test_webfetch_resolved_host_denied_and_public_allowed():
    orig = sandbox.socket.getaddrinfo
    try:
        # Named host that resolves to a loopback address => denied.
        sandbox.socket.getaddrinfo = lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 0))]
        with _denylist([]):
            assert sandbox.is_denied("WebFetch", {"url": "https://sneaky.example/"}) is not None
        # Named host that resolves to a public address => allowed.
        sandbox.socket.getaddrinfo = lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))]
        with _denylist([]):
            assert sandbox.is_denied("WebFetch", {"url": "https://real.example/"}) is None
    finally:
        sandbox.socket.getaddrinfo = orig


# --- FIX 4: spawn-guard passthrough can't resurrect a secret --------------------

def test_passthrough_cannot_resurrect_secret_var():
    # A secret-shaped name stays dropped even when explicitly passed through.
    assert spawn_guard._is_allowed("ANTHROPIC_API_KEY", frozenset({"ANTHROPIC_API_KEY"})) is False
    assert spawn_guard._is_allowed("MY_SERVICE_TOKEN", frozenset({"MY_SERVICE_TOKEN"})) is False
    assert spawn_guard._is_allowed("AWS_SECRET_ACCESS_KEY", frozenset({"AWS_SECRET_ACCESS_KEY"})) is False
    # A non-secret var IS re-added by passthrough (even if not on the base allowlist).
    assert spawn_guard._is_allowed("MY_TOOLCHAIN_HOME", frozenset({"MY_TOOLCHAIN_HOME"})) is True


def test_scrub_env_drops_passed_through_secret_keeps_nonsecret():
    base = {
        "ANTHROPIC_API_KEY": "sk-should-be-dropped",
        "MY_TOOLCHAIN_HOME": "C:/tools",
        "PATH": "C:/windows",
    }
    passthrough = frozenset({"ANTHROPIC_API_KEY", "MY_TOOLCHAIN_HOME"})
    out = spawn_guard._scrub_env(base, passthrough)
    assert "ANTHROPIC_API_KEY" not in out  # secret stays dropped despite passthrough
    assert out.get("MY_TOOLCHAIN_HOME") == "C:/tools"  # non-secret passthrough kept
    assert out.get("PATH") == "C:/windows"  # base allowlist untouched


def _run_all():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
