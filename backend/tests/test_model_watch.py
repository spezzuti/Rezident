"""Model-availability watch (agentos.model_watch) — the graceful-vanish guard
for companions on subscription models (Nick Valentine / Fable 5).

  - the CLI's model-unavailability phrasing (and the raw API error type) match
  - ordinary failures (network, tool, verify) NEVER match — vanish needs hard evidence
  - prune() expires entries after the retry window so companions rejoin on their own

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_model_watch.py
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import model_watch  # noqa: E402


def test_cli_signature_matches():
    err = ("There's an issue with the selected model (claude-fable-5). It may not exist "
           "or you may not have access to it. Run --model to pick a different model.")
    assert model_watch.is_unavailability_error(err)


def test_api_error_type_matches():
    assert model_watch.is_unavailability_error(
        '{"type":"not_found_error","message":"model: claude-fable-5"}'
    )


def test_ordinary_failures_do_not_match():
    for err in (
        "verification failed:\nexit 1",
        "Agent stream ended without a result message",
        "could not reach 'hermes': ConnectTimeout",
        "codex exited with code 1: something broke",
        "",  # empty error
    ):
        assert not model_watch.is_unavailability_error(err), err


def test_prune_expires_after_retry_window():
    now = time.time()
    entries = {
        "fable": now - model_watch.RETRY_SECONDS - 5,   # expired → companion returns
        "opus": now - 60,                                # fresh → still standing down
        "junk": "not-a-timestamp",                       # corrupt → dropped
    }
    live = model_watch.prune(entries, now)
    assert live == {"opus": entries["opus"]}, live


TESTS = [
    test_cli_signature_matches,
    test_api_error_type_matches,
    test_ordinary_failures_do_not_match,
    test_prune_expires_after_retry_window,
]


def main() -> int:
    failed = 0
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
