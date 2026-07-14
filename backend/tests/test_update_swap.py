"""Regression tests for the self-update swap helper — the "installing… never
restarts" incident. Two stacked bugs:
  1. write_text mangled \\r\\n -> \\r\\r\\n, leaving a stray \\r on every batch
     LABEL, so `goto swapped` couldn't find `:swapped` and the swap aborted.
  2. (desktop shutdown, tested elsewhere) the process never exited so the helper
     waited on a live pid forever.
This covers #1: clean line endings + labels, and an actual end-to-end swap.
"""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("AGENTOS_DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("AGENTOS_TOKEN", "test")

import agentos.update as U  # noqa: E402


def test_helper_line_endings_clean():
    work = Path(tempfile.mkdtemp())
    exe = work / "App.exe"
    new = Path(str(exe) + ".new")
    h = U._write_portable_helper(4242, exe, new)
    raw = h.read_bytes()
    assert b"\r\r\n" not in raw, "double-CRLF corrupts batch labels (goto fails)"
    text = raw.decode("mbcs")
    # every `goto X` must have a matching clean `:X` label (no stray trailing CR)
    for line in text.splitlines():
        s = line.strip()
        if s.lower().startswith("goto "):
            label = s.split(None, 1)[1].strip()
            assert f":{label}\r\n" in text, f"goto {label} has no clean :{label} label"


def test_portable_swap_runs_end_to_end():
    """A guaranteed-dead pid makes the wait loop fall through immediately; the
    helper must move .new -> exe, consume .new, and drop the .old backup."""
    if os.name != "nt":
        print("SKIP (Windows-only swap helper)")
        return
    work = Path(tempfile.mkdtemp())
    exe = work / "App.exe"
    new = Path(str(exe) + ".new")
    exe.write_bytes(b"OLD-BUILD")
    new.write_bytes(b"NEW-BUILD")
    h = U._write_portable_helper(999990, exe, new)  # pid that cannot exist
    subprocess.run(["cmd.exe", "/c", str(h)], capture_output=True, timeout=25, cwd=str(work))
    time.sleep(0.5)
    assert exe.exists() and exe.read_bytes() == b"NEW-BUILD", "exe was not swapped to the new build"
    assert not new.exists(), ".new was not consumed"
    assert not Path(str(exe) + ".old").exists(), ".old backup should be cleaned after a good swap"


def test_hidden_launcher_shim():
    """The scheduler runs the helper through a wscript shim so NO console window
    appears mid-update (field request: the cmd box was off-putting). The shim
    must start the batch hidden, and the batch must delete the shim on its way out."""
    work = Path(tempfile.mkdtemp())
    helper = work / "rezident_swap_777.cmd"
    helper.write_text("@echo off\r\n", encoding="mbcs", newline="")
    vbs = U._write_hidden_launcher(helper)
    assert vbs.suffix == ".vbs" and vbs.exists()
    text = vbs.read_bytes().decode("mbcs")
    assert 'Run "cmd.exe /c ""' in text and str(helper) in text, text
    assert '", 0, False' in text, "window style 0 (hidden) + no-wait are the point"
    h = U._write_installer_helper(4242, work / "Setup.exe", str(work), task="RezidentUpdateT")
    body = h.read_bytes().decode("mbcs")
    assert 'del /Q "%~dpn0.vbs"' in body, "the helper must clean up its shim"


def main():
    fails = 0
    for fn in (test_helper_line_endings_clean, test_portable_swap_runs_end_to_end, test_hidden_launcher_shim):
        try:
            fn()
            print("PASS ", fn.__name__)
        except AssertionError as e:
            fails += 1
            print("FAIL ", fn.__name__, "->", e)
    print(f"{'all pass' if not fails else str(fails)+' FAILED'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
