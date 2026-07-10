"""Redact the WS bearer token from uvicorn access logs.

The WebSocket auth token rides the URL query string (`/ws?token=...`) because
browsers can't set WS request headers (auth.py, frontend ws.ts). uvicorn's access
logger writes the full request path — query string included — to stdout, which in
the packaged windowed app is appended to %LOCALAPPDATA%\\Rezident\\logs\\agentos.log
(desktop/app.py::_ensure_stdio). That would leak a live credential into a plaintext
log a user might attach to a bug report.

This installs a logging.Filter on the `uvicorn.access` logger that rewrites any
`token=<value>` in the record (query `?token=`/`&token=` and, defensively, a
`#token=` fragment) to `token=REDACTED` before it is emitted. The WS auth mechanism
itself is unchanged in this wave — this only stops the leak to logs.

OPERATOR NOTE: a token that already appeared in shared/exported logs should be
rotated (delete <data_dir>/token and restart to regenerate, then re-open the app).
"""

import logging
import re

# token= up to the next delimiter (&, #, whitespace, quote) or end of string.
_TOKEN_RE = re.compile(r"([?&#]token=)[^&#\s\"']*", re.IGNORECASE)


def _redact(s: str) -> str:
    return _TOKEN_RE.sub(r"\1REDACTED", s)


class RedactTokenFilter(logging.Filter):
    """Scrub `token=...` from a log record's message and args in place. Returns True
    (never drops a record) — it only rewrites. Failure-tolerant: a surprise record
    shape must never break logging."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if record.args:
                if isinstance(record.args, tuple):
                    record.args = tuple(_redact(a) if isinstance(a, str) else a for a in record.args)
                elif isinstance(record.args, dict):
                    record.args = {k: (_redact(v) if isinstance(v, str) else v) for k, v in record.args.items()}
            if isinstance(record.msg, str):
                record.msg = _redact(record.msg)
        except Exception:  # noqa: BLE001 — never let redaction break logging
            pass
        return True


def install_access_log_redaction() -> None:
    """Attach the redaction filter to the uvicorn access logger (idempotent).

    Call it from every process entrypoint that runs uvicorn (headless `python -m
    agentos` and the desktop shell). uvicorn logs access lines through the
    `uvicorn.access` logger, so a filter on that logger runs before each record is
    formatted/emitted."""
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, RedactTokenFilter) for f in logger.filters):
        logger.addFilter(RedactTokenFilter())
