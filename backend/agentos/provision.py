"""On-demand tool provisioning — the bundled-tailscale idiom for vendor CLIs.

CONNECT on a bare machine should JUST WORK: when the codex CLI is missing,
Rezident downloads OpenAI's standalone exe into <data_dir>/bin itself — no
npm, no node, no manual step — then proceeds straight into the sign-in.

This lives OUTSIDE agentos.integrations on purpose: that module's outbound
clients are pinned to follow_redirects=False (they talk to USER-CONFIGURED
endpoints, where a redirect can exfiltrate auth headers — see
tests/test_fix_integrations.py). Provisioning talks only to FIXED, hardcoded
GitHub URLs, where following the release-asset redirect chain is required
and safe.
"""

import os
from pathlib import Path

import httpx


class ProvisionError(RuntimeError):
    """A fetch failure the CONNECT card should surface verbatim (with a retry)."""


_CODEX_RELEASES_API = "https://api.github.com/repos/openai/codex/releases/latest"


def bundled_bin_dir() -> Path:
    from .config import settings

    return settings.data_dir / "bin"


async def provision_codex(ses: dict) -> str:
    """Fetch the standalone codex CLI into <data_dir>/bin/codex.exe. Progress
    streams through `ses['detail']` (the CONNECT card polls it). Atomic write
    (.part → replace); TLS to GitHub is the trust anchor — OpenAI publishes no
    checksum manifest for these assets."""
    if os.name != "nt":
        raise ProvisionError("automatic codex download is Windows-only — install the codex CLI manually")
    import platform

    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    asset_name = f"codex-{arch}-pc-windows-msvc.exe"
    ses["detail"] = "asking openai/codex for the latest CLI…"
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(_CODEX_RELEASES_API, headers={"Accept": "application/vnd.github+json"})
            resp.raise_for_status()
            assets = resp.json().get("assets") or []
    except httpx.HTTPError as exc:
        raise ProvisionError(f"couldn't reach openai/codex releases ({type(exc).__name__}) — retry, or install the CLI manually") from exc
    url = next((a.get("browser_download_url") for a in assets if a.get("name") == asset_name), "")
    if not url:
        raise ProvisionError(f"openai/codex latest release has no {asset_name}")
    dest_dir = bundled_bin_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "codex.exe"
    part = dest_dir / "codex.exe.part"
    got = 0
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("Content-Length") or 0)
                with open(part, "wb") as f:
                    async for chunk in resp.aiter_bytes(65536):
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            ses["detail"] = f"downloading the codex CLI… {int(got * 100 / total)}%"
    except httpx.HTTPError as exc:
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass
        raise ProvisionError(f"codex download failed ({type(exc).__name__}) — retry, or install the CLI manually") from exc
    os.replace(part, dest)
    ses["detail"] = "codex CLI installed — starting the sign-in…"
    return str(dest)
