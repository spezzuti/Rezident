"""Security finding #1 — the master token must be ENCRYPTED at rest (Windows DPAPI),
never stored in plaintext, with dependency-free ctypes and graceful degradation.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_secretstore.py

Covers:
  * secretstore.protect -> unprotect round-trips to the original (a real DPAPI
    round-trip on this Windows box; a plaintext no-op elsewhere).
  * is_encrypted: True for a protected envelope, False for legacy plaintext.
  * unprotect of a legacy plaintext string returns it UNCHANGED (passthrough).
  * config.ensure_token resolution: env-var-first returns verbatim and never
    touches the file; a legacy plaintext token file is auto-migrated to encrypted
    while preserving the exact value; a fresh provision is written encrypted and
    reads back to the same token.

These config tests never touch the real data dir — they point settings.data_dir at
a tempdir (the pattern from test_fix_concurrency.py) and restore it afterwards.
"""

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import config, secretstore  # noqa: E402
from agentos.config import settings  # noqa: E402


# ---- secretstore primitives --------------------------------------------------

def test_protect_unprotect_roundtrip():
    for secret in ("s3cr3t-token_urlsafe.ABCdef-123", "unicode-éñ-\U0001f512"):
        stored = secretstore.protect(secret)
        assert secretstore.unprotect(stored) == secret, "round-trip must return the original"
        if secretstore.available():
            assert secretstore.is_encrypted(stored), "on Windows protect() must emit a dpapi envelope"
            assert stored != secret, "the stored ciphertext must differ from the plaintext"
        else:
            assert stored == secret, "off Windows protect() must be a plaintext no-op"


def test_is_encrypted_flags():
    assert secretstore.is_encrypted("dpapi:v1:AAAA") is True
    assert secretstore.is_encrypted("plain-token") is False
    assert secretstore.is_encrypted("") is False
    if secretstore.available():
        assert secretstore.is_encrypted(secretstore.protect("abc")), "a protected value is encrypted"


def test_unprotect_legacy_passthrough():
    # Anything without the dpapi:v1: prefix is legacy plaintext, returned unchanged.
    assert secretstore.unprotect("legacy-plaintext-xyz") == "legacy-plaintext-xyz"
    assert secretstore.unprotect("") == ""


# ---- config.ensure_token resolution ------------------------------------------

def test_config_env_first_verbatim():
    tmp = Path(tempfile.mkdtemp(prefix="secstore-"))
    orig_dir, orig_tok = settings.data_dir, settings.token
    try:
        settings.data_dir = tmp
        settings.token = "ENV-VERBATIM-abc123"  # simulates AGENTOS_TOKEN already loaded
        result = config.ensure_token()
        assert result == "ENV-VERBATIM-abc123", "an env/.env token must be returned verbatim"
        assert not (tmp / "token").exists(), "env-first must never create/touch the token file"
    finally:
        settings.data_dir, settings.token = orig_dir, orig_tok
        shutil.rmtree(tmp, ignore_errors=True)


def test_config_migrates_legacy_plaintext():
    tmp = Path(tempfile.mkdtemp(prefix="secstore-"))
    orig_dir, orig_tok = settings.data_dir, settings.token
    try:
        settings.data_dir = tmp
        settings.token = ""
        legacy = "LEGACY-PLAINTEXT-tok-0001"
        (tmp / "token").write_text(legacy, encoding="utf-8")  # pre-existing plaintext file

        result = config.ensure_token()

        assert result == legacy, "migration must preserve the exact token value"
        assert settings.token == legacy, "settings.token must hold the plaintext value"
        on_disk = (tmp / "token").read_text(encoding="utf-8").strip()
        if secretstore.available():
            assert secretstore.is_encrypted(on_disk), "legacy plaintext must be re-written encrypted"
            assert on_disk != legacy, "the at-rest form must no longer be plaintext"
            assert secretstore.unprotect(on_disk) == legacy, "the encrypted file must decrypt to the same value"
        else:
            assert on_disk == legacy, "off Windows the value stays plaintext (no-op)"
    finally:
        settings.data_dir, settings.token = orig_dir, orig_tok
        shutil.rmtree(tmp, ignore_errors=True)


def test_config_provisions_encrypted_and_reads_back():
    tmp = Path(tempfile.mkdtemp(prefix="secstore-"))
    orig_dir, orig_tok = settings.data_dir, settings.token
    try:
        settings.data_dir = tmp
        settings.token = ""
        first = config.ensure_token()
        assert first and first.strip() == first, "provisioning must yield a non-blank token"
        assert (tmp / "token").exists(), "provisioning must persist a token file"
        on_disk = (tmp / "token").read_text(encoding="utf-8").strip()
        if secretstore.available():
            assert secretstore.is_encrypted(on_disk), "a provisioned token must be encrypted at rest"
            assert on_disk != first, "the file must not contain the plaintext token"

        # A fresh resolution (settings.token cleared, as on a later launch) must read
        # the SAME persisted token back — decrypting the file, not minting a new one.
        settings.token = ""
        second = config.ensure_token()
        assert second == first, "re-resolution must return the same persisted token"
    finally:
        settings.data_dir, settings.token = orig_dir, orig_tok
        shutil.rmtree(tmp, ignore_errors=True)


TESTS = [
    test_protect_unprotect_roundtrip,
    test_is_encrypted_flags,
    test_unprotect_legacy_passthrough,
    test_config_env_first_verbatim,
    test_config_migrates_legacy_plaintext,
    test_config_provisions_encrypted_and_reads_back,
]


def main() -> int:
    failed = 0
    dpapi = "available (real DPAPI round-trip)" if secretstore.available() else "UNAVAILABLE (plaintext no-op)"
    print(f"DPAPI on this box: {dpapi}\n")
    for t in TESTS:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
