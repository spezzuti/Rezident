"""Regression tests for the LAN-exposure fix (vulnerability #5).

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_lan_policy.py

The bug: the server bound 0.0.0.0 by default in dev and when autostart was given
no explicit host, and the client speaks plain http+ws when the page is http — so
the long-lived bearer token crossed a plain LAN (Authorization header + ws URL),
capturable by LAN interception. The fix makes non-loopback binding OPT-IN behind
an explicit override (AGENTOS_ALLOW_INSECURE_LAN env/.env OR the
security:allow_insecure_lan settings key); without it a LAN request downgrades to
127.0.0.1 and records a warning.

Hermetic: no real server bind, no real elevation. settings.data_dir is pointed at
a temp dir, os.name/_run_ps are faked where needed, so this runs on any OS.
"""

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import autostart, config  # noqa: E402
from agentos.config import settings  # noqa: E402

ENV_KEY = "AGENTOS_ALLOW_INSECURE_LAN"


class _Sandbox:
    """Clean, isolated policy state: a fresh temp data_dir (no db by default),
    the env override cleared, and the pydantic field forced false. Restores all
    three on exit."""

    def __init__(self, *, seed_setting: bool | None = None, env: str | None = None):
        self.seed_setting = seed_setting
        self.env = env

    def __enter__(self):
        self._orig_data_dir = settings.data_dir
        self._orig_field = settings.allow_insecure_lan
        self._orig_env = os.environ.get(ENV_KEY)
        self.tmp = Path(tempfile.mkdtemp(prefix="rezident_lan_test_"))
        settings.data_dir = self.tmp
        settings.allow_insecure_lan = False
        os.environ.pop(ENV_KEY, None)
        if self.env is not None:
            os.environ[ENV_KEY] = self.env
        if self.seed_setting is not None:
            self._write_setting(self.seed_setting)
        return self

    def _write_setting(self, val: bool) -> None:
        con = sqlite3.connect(str(settings.db_path))
        try:
            con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            con.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (config.SECURITY_LAN_KEY, json.dumps(val)),
            )
            con.commit()
        finally:
            con.close()

    def __exit__(self, *exc):
        settings.data_dir = self._orig_data_dir
        settings.allow_insecure_lan = self._orig_field
        os.environ.pop(ENV_KEY, None)
        if self._orig_env is not None:
            os.environ[ENV_KEY] = self._orig_env
        return False


# ---- resolve_bind_host --------------------------------------------------------

def test_loopback_passes_through():
    with _Sandbox():
        for host in ("127.0.0.1", "localhost", "::1"):
            eff, warn = config.resolve_bind_host(host)
            assert eff == host, (host, eff)
            assert warn is None, (host, warn)


def test_lan_without_override_downgrades():
    with _Sandbox():
        eff, warn = config.resolve_bind_host("0.0.0.0")
        assert eff == "127.0.0.1", eff
        assert warn and "refused" in warn.lower(), warn
        assert config.insecure_lan_allowed() is False


def test_specific_lan_ip_without_override_downgrades():
    with _Sandbox():
        eff, warn = config.resolve_bind_host("192.168.1.50")
        assert eff == "127.0.0.1", eff
        assert warn is not None, warn


def test_lan_with_env_override_binds_asis():
    with _Sandbox(env="1"):
        assert config.insecure_lan_allowed() is True
        eff, warn = config.resolve_bind_host("0.0.0.0")
        assert eff == "0.0.0.0", eff
        assert warn is None, warn


def test_env_truthy_variants_and_falsey():
    for v in ("1", "true", "TRUE", "yes", "on"):
        with _Sandbox(env=v):
            assert config.insecure_lan_allowed() is True, v
    for v in ("0", "false", "no", "", "off", "nope"):
        with _Sandbox(env=v):
            assert config.insecure_lan_allowed() is False, repr(v)


def test_lan_with_settings_key_override_binds_asis():
    with _Sandbox(seed_setting=True):
        assert config.insecure_lan_allowed() is True
        eff, warn = config.resolve_bind_host("0.0.0.0")
        assert eff == "0.0.0.0", eff
        assert warn is None, warn


def test_settings_key_false_downgrades():
    with _Sandbox(seed_setting=False):
        assert config.insecure_lan_allowed() is False
        eff, warn = config.resolve_bind_host("0.0.0.0")
        assert eff == "127.0.0.1" and warn is not None


def test_dotenv_field_override_binds_asis():
    """AGENTOS_ALLOW_INSECURE_LAN in backend/.env lands on the pydantic field, not
    os.environ — that path must also count as opted-in (the dev workflow)."""
    with _Sandbox():
        settings.allow_insecure_lan = True
        assert config.insecure_lan_allowed() is True
        eff, warn = config.resolve_bind_host("0.0.0.0")
        assert eff == "0.0.0.0" and warn is None


def test_missing_db_is_safe_default():
    with _Sandbox():
        assert not settings.db_path.exists()  # probe must not create it
        assert config._read_security_lan_setting() is False
        assert not settings.db_path.exists(), "policy read must never create a db file"


# ---- autostart.install refusal ------------------------------------------------

def _stub_run_ps():
    captured: list[str] = []
    orig = autostart._run_ps

    async def fake(command: str, timeout: float = 30.0):
        captured.append(command)
        return 0, ""

    autostart._run_ps = fake  # type: ignore[assignment]
    return captured, (lambda: setattr(autostart, "_run_ps", orig))


async def test_install_refuses_lan_without_override():
    with _Sandbox():
        orig_name = os.name
        os.name = "nt"  # get past the Windows-only guard
        captured, restore = _stub_run_ps()
        try:
            res = await autostart.install("0.0.0.0")
        finally:
            os.name = orig_name
            restore()
        assert res["ok"] is False, res
        assert "lan" in res["detail"].lower(), res
        # refusal happens BEFORE any elevation attempt
        assert captured == [], captured


async def test_install_allows_loopback_without_override():
    with _Sandbox():
        orig_name = os.name
        os.name = "nt"
        captured, restore = _stub_run_ps()
        try:
            res = await autostart.install("127.0.0.1")
        finally:
            os.name = orig_name
            restore()
        assert res["ok"] is True, res
        assert len(captured) == 1, captured  # elevation was attempted


async def test_install_allows_lan_with_override():
    with _Sandbox(env="1"):
        orig_name = os.name
        os.name = "nt"
        captured, restore = _stub_run_ps()
        try:
            res = await autostart.install("0.0.0.0")
        finally:
            os.name = orig_name
            restore()
        assert res["ok"] is True, res
        assert len(captured) == 1, captured


# ---- runner -------------------------------------------------------------------

SYNC_TESTS = [
    test_loopback_passes_through,
    test_lan_without_override_downgrades,
    test_specific_lan_ip_without_override_downgrades,
    test_lan_with_env_override_binds_asis,
    test_env_truthy_variants_and_falsey,
    test_lan_with_settings_key_override_binds_asis,
    test_settings_key_false_downgrades,
    test_dotenv_field_override_binds_asis,
    test_missing_db_is_safe_default,
]

ASYNC_TESTS = [
    test_install_refuses_lan_without_override,
    test_install_allows_loopback_without_override,
    test_install_allows_lan_with_override,
]


def main() -> int:
    failed = 0
    for t in SYNC_TESTS:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    for t in ASYNC_TESTS:
        try:
            asyncio.run(t())
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    total = len(SYNC_TESTS) + len(ASYNC_TESTS)
    print(f"\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
