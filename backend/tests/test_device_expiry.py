"""Device-token default expiry (Security review finding #2, option A).

create_device stamps expires_at from the devices:token_ttl_days setting
(default 90; 0 = never), verify_device_token rejects a token past its expiry,
and legacy tokens with a NULL expiry still verify (no disruption to the phone
paired before this change).

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_device_expiry.py
"""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import devices  # noqa: E402
from agentos.config import settings  # noqa: E402
from agentos.db import db, row_to_dict  # noqa: E402


async def _fresh_db() -> None:
    tmp = tempfile.mkdtemp(prefix="devexp-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()


async def _set_ttl(days) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (devices.TOKEN_TTL_KEY, json.dumps(days)),
    )


async def _row(device_id):
    return row_to_dict(await db.fetch_one("SELECT * FROM devices WHERE id = ?", (device_id,)))


async def _days_out(expires_at) -> float:
    r = await db.fetch_one("SELECT (julianday(?) - julianday('now')) AS d", (expires_at,))
    return r["d"]


async def run() -> bool:
    await _fresh_db()
    passed = 0

    # default TTL (90): expiry stamped ~90 days out and the fresh token verifies
    did, raw = await devices.create_device("phone-default")
    row = await _row(did)
    assert row["expires_at"] is not None, "default create should set expires_at"
    d = await _days_out(row["expires_at"])
    assert 89 < d < 91, f"expected ~90 days, got {d}"
    assert await devices.verify_device_token(raw) is not None, "fresh token should verify"
    print("PASS  default_ttl_stamps_90d_and_verifies"); passed += 1

    # ttl = 0 -> no expiry (NULL), token verifies
    await _set_ttl(0)
    did0, raw0 = await devices.create_device("phone-never")
    assert (await _row(did0))["expires_at"] is None, "ttl=0 should leave expires_at NULL"
    assert await devices.verify_device_token(raw0) is not None
    print("PASS  ttl_zero_never_expires"); passed += 1

    # custom ttl honored
    await _set_ttl(7)
    did7, _ = await devices.create_device("phone-7d")
    d7 = await _days_out((await _row(did7))["expires_at"])
    assert 6 < d7 < 8, f"expected ~7 days, got {d7}"
    print("PASS  custom_ttl_honored"); passed += 1

    # an already-expired token is rejected
    await _set_ttl(0)
    dide, rawe = await devices.create_device("phone-expired")
    await db.execute(
        "UPDATE devices SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id = ?",
        (dide,),
    )
    assert await devices.verify_device_token(rawe) is None, "expired token must be rejected"
    print("PASS  expired_token_rejected"); passed += 1

    # a legacy token (NULL expiry, paired before this change) still verifies
    dl, rawl = await devices.create_device("phone-legacy")
    await db.execute("UPDATE devices SET expires_at = NULL WHERE id = ?", (dl,))
    assert await devices.verify_device_token(rawl) is not None, "NULL-expiry (legacy) must still verify"
    print("PASS  legacy_null_expiry_still_verifies"); passed += 1

    await db.close()
    print(f"\n{passed}/5 passed")
    return passed == 5


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(run()) else 1)
