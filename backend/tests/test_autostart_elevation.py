"""Regression test for the autostart local-privilege-escalation fix.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_autostart_elevation.py

The bug: _run_elevated used to write the elevation script to a predictable,
user-writable path (<data_dir>/autostart_action.ps1) and launch an elevated
PowerShell with `-File <that path>`. A same-user unprivileged process could
swap the file's contents in the TOCTOU window while the user decided on the
UAC prompt, so an attacker's script ran ELEVATED. The fix delivers the script
as an immutable `-EncodedCommand <base64>` argument — no on-disk file, no swap.

Hermetic: _run_ps is stubbed (no real powershell, no elevation), os.name is
faked to 'nt' where needed, so this runs on any OS.
"""

import asyncio
import base64
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import autostart  # noqa: E402
from agentos.config import settings  # noqa: E402


def _capture_run_ps():
    """Swap autostart._run_ps for a stub that records the wrapper command and
    returns success (exit 0). Returns (captured_list, restore_fn)."""
    captured: list[str] = []
    orig = autostart._run_ps

    async def fake_run_ps(command: str, timeout: float = 30.0):
        captured.append(command)
        return 0, ""

    autostart._run_ps = fake_run_ps  # type: ignore[assignment]

    def restore():
        autostart._run_ps = orig  # type: ignore[assignment]

    return captured, restore


async def test_encoded_command_no_file_no_toctou():
    sample = "$ErrorActionPreference = 'Stop'\nWrite-Host 'hello from the elevated step'\n"

    captured, restore = _capture_run_ps()
    orig_data_dir = settings.data_dir
    tmp = Path(tempfile.mkdtemp(prefix="rezident_autostart_test_"))
    settings.data_dir = tmp
    try:
        res = await autostart._run_elevated(sample)
    finally:
        settings.data_dir = orig_data_dir
        restore()

    # success exit-code handling preserved
    assert res == {"ok": True, "detail": "done"}, res

    # (a) NO script file written to the data dir — the whole point of the fix.
    assert not (tmp / "autostart_action.ps1").exists(), "elevation script must NOT be written to disk"
    assert not any(tmp.iterdir()), f"data dir must stay empty, found: {list(tmp.iterdir())}"

    # exactly one elevated invocation was built
    assert len(captured) == 1, captured
    wrapper = captured[0]

    # (b) the wrapper uses -EncodedCommand, never a `-File` ArgumentList token.
    #     (Start-Process itself uses -FilePath, so match the quoted '-File' token.)
    assert "-EncodedCommand" in wrapper, wrapper
    assert "'-File'" not in wrapper, wrapper
    assert "-Verb RunAs" in wrapper, wrapper

    # (c) the base64 arg round-trips to the original script text as UTF-16LE
    #     pull the single-quoted token that follows 'EncodedCommand',
    marker = "'-EncodedCommand',"
    start = wrapper.index(marker) + len(marker)
    assert wrapper[start] == "'", wrapper
    end = wrapper.index("'", start + 1)
    b64 = wrapper[start + 1:end]
    assert b64 and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=" for c in b64), b64
    decoded = base64.b64decode(b64).decode("utf-16-le")
    assert decoded == sample, repr(decoded)


async def test_uninstall_builds_encoded_command():
    """End-to-end via uninstall() with os.name faked to 'nt': still no file,
    still -EncodedCommand, and the decoded payload is the real uninstall script."""
    captured, restore = _capture_run_ps()
    orig_data_dir = settings.data_dir
    orig_name = os.name
    tmp = Path(tempfile.mkdtemp(prefix="rezident_autostart_test_"))
    settings.data_dir = tmp
    os.name = "nt"  # let uninstall() past its `if os.name != "nt"` guard
    try:
        res = await autostart.uninstall()
    finally:
        os.name = orig_name
        settings.data_dir = orig_data_dir
        restore()

    assert res["ok"] is True, res
    assert not (tmp / "autostart_action.ps1").exists(), "no script on disk"
    assert not any(tmp.iterdir()), list(tmp.iterdir())

    wrapper = captured[0]
    assert "-EncodedCommand" in wrapper and "'-File'" not in wrapper, wrapper
    marker = "'-EncodedCommand',"
    start = wrapper.index(marker) + len(marker) + 1
    end = wrapper.index("'", start)
    decoded = base64.b64decode(wrapper[start:end]).decode("utf-16-le")
    assert "Unregister-ScheduledTask" in decoded, decoded


# ---- runner -------------------------------------------------------------------

TESTS = [
    test_encoded_command_no_file_no_toctou,
    test_uninstall_builds_encoded_command,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            asyncio.run(t())
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
