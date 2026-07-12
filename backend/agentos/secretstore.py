"""Dependency-free at-rest encryption for the master token via Windows DPAPI.

Security finding #1: the master API token must not sit in PLAINTEXT on disk. We
wrap it with the Windows Data Protection API (DPAPI) — CryptProtectData with no
extra entropy and UI forbidden — which keys the ciphertext to the CURRENT Windows
user account on THIS machine. There is no key file to steal alongside the blob:
only this logged-in user can recover the token. DPAPI is reached through ctypes
against crypt32.dll, so the frozen PyInstaller build gains NO new dependency.

Stored format is self-describing:  ``"dpapi:v1:" + base64(ciphertext)``. Anything
without that prefix is treated as legacy plaintext and passed through unchanged,
so an old plaintext token keeps working and can be transparently re-encrypted.

Graceful degradation is a hard requirement. On non-Windows, or if DPAPI cannot be
loaded/called for any reason, ``protect()`` returns the plaintext UNCHANGED (with a
one-time warning) instead of raising: the app must never lock itself out of its own
token just because encryption was unavailable. ``available()`` reports which mode
we are in.
"""

from __future__ import annotations

import base64
import ctypes
import logging
import sys

log = logging.getLogger("agentos.secretstore")

# Self-describing envelope. Bump the version suffix if the wire format ever changes;
# unprotect() keys off this exact prefix, everything else is legacy plaintext.
_PREFIX = "dpapi:v1:"

# Run headless / as a service: never let DPAPI pop a UI prompt — fail the call
# instead (we degrade to plaintext on failure rather than block on a dialog).
_CRYPTPROTECT_UI_FORBIDDEN = 0x1

_warned = False


def _warn_once(msg: str) -> None:
    """Log a degradation warning exactly once (protect() may be called repeatedly)."""
    global _warned
    if not _warned:
        log.warning(msg)
        _warned = True


class _DATA_BLOB(ctypes.Structure):
    """The DATA_BLOB DPAPI passes data in/out through: a length + byte pointer.

    Declared with plain ctypes scalar types (c_uint32 / POINTER(c_char)) rather
    than ctypes.wintypes so this module imports cleanly on non-Windows too — the
    struct is only ever *used* behind an sys.platform=='win32' guard."""

    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


# Cached (crypt32, kernel32) pair once probed; None means "DPAPI not available".
_dpapi: tuple | None = None
_dpapi_probed = False


def _load() -> tuple | None:
    """Lazily load crypt32/kernel32 with correct call signatures, cached.

    Returns the module pair on success, or None on non-Windows or any load failure
    (so callers degrade to plaintext instead of crashing)."""
    global _dpapi, _dpapi_probed
    if _dpapi_probed:
        return _dpapi
    _dpapi_probed = True
    if sys.platform != "win32":
        return None
    try:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        blob_p = ctypes.POINTER(_DATA_BLOB)
        # BOOL CryptProtect/UnprotectData(pDataIn, szDescr, pEntropy, reserved,
        #                                 pPromptStruct, dwFlags, pDataOut)
        for fn in (crypt32.CryptProtectData, crypt32.CryptUnprotectData):
            fn.argtypes = [blob_p, ctypes.c_wchar_p, blob_p, ctypes.c_void_p,
                           ctypes.c_void_p, ctypes.c_uint32, blob_p]
            fn.restype = ctypes.c_int  # BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
    except (OSError, AttributeError) as exc:  # library missing / symbol missing
        log.warning("DPAPI unavailable (crypt32 load failed: %s)", exc)
        return None
    _dpapi = (crypt32, kernel32)
    return _dpapi


def available() -> bool:
    """True on Windows where DPAPI (crypt32) loads; False on non-Windows or if the
    library can't be loaded. When False, protect() is a plaintext no-op."""
    return _load() is not None


def _dpapi_call(encrypt: bool, data: bytes) -> bytes:
    """Run one CryptProtectData/CryptUnprotectData round. Caller guarantees
    available(). Raises OSError (ctypes.WinError) if the API call fails."""
    crypt32, kernel32 = _load()  # type: ignore[misc]  # guarded by available()
    func = crypt32.CryptProtectData if encrypt else crypt32.CryptUnprotectData
    # create_string_buffer appends a NUL (so size == len(data)+1); we pass cbData =
    # len(data) explicitly so that trailing NUL is never part of the payload.
    buf_in = ctypes.create_string_buffer(data)
    blob_in = _DATA_BLOB(len(data), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DATA_BLOB()
    ok = func(ctypes.byref(blob_in), None, None, None, None,
              _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        # DPAPI allocates the output with LocalAlloc — we own freeing it.
        kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))


def is_encrypted(stored: str) -> bool:
    """True iff `stored` is in our DPAPI envelope form (vs legacy plaintext)."""
    return isinstance(stored, str) and stored.startswith(_PREFIX)


def protect(plaintext: str) -> str:
    """Encrypt `plaintext` to the self-describing ``dpapi:v1:<base64>`` form.

    Degrades to a NO-OP — returns `plaintext` unchanged with a one-time warning —
    when DPAPI is unavailable OR the call fails, so the app keeps working even when
    it cannot encrypt at rest. Never raises."""
    if not available():
        _warn_once("DPAPI unavailable (non-Windows or crypt32 load failed): the "
                   "master token will be stored in PLAINTEXT at rest.")
        return plaintext
    try:
        cipher = _dpapi_call(True, plaintext.encode("utf-8"))
    except OSError as exc:
        _warn_once(f"DPAPI CryptProtectData failed ({exc}): storing token in PLAINTEXT.")
        return plaintext
    return _PREFIX + base64.b64encode(cipher).decode("ascii")


def unprotect(stored: str) -> str:
    """Inverse of protect().

    A ``dpapi:v1:`` value is base64-decoded and decrypted back to the original text.
    Anything else is assumed to be a LEGACY PLAINTEXT token and returned UNCHANGED
    (the passthrough that lets old files keep working). Raises only when a genuine
    DPAPI blob cannot be decoded/decrypted — corrupt, or sealed for a different
    Windows user/machine — so the caller can decide how to treat that."""
    if not is_encrypted(stored):
        return stored
    cipher = base64.b64decode(stored[len(_PREFIX):], validate=True)
    if not available():
        # A DPAPI blob but no DPAPI to open it (e.g. the file was copied to a
        # non-Windows host). We cannot recover it here; surface it rather than
        # silently hand back garbage.
        raise RuntimeError("token is DPAPI-encrypted but DPAPI is unavailable here")
    return _dpapi_call(False, cipher).decode("utf-8")
