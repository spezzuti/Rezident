"""Rewrite every version copy in lockstep so a release can never ship mixed
numbers. The semantic source of truth is agentos.__version__; the three
packaging copies (pyproject, the VS_VERSION_INFO resource, the Inno Setup
#define) must always mirror it.

    backend/.venv/Scripts/python.exe backend/scripts/bump_version.py 0.1.1

Run this ONLY at ship time (the control thread bumps; feature branches never do).
"""

import re
import sys
from pathlib import Path

# scripts/ -> backend/ -> repo root
BACKEND = Path(__file__).resolve().parent.parent
ROOT = BACKEND.parent

INIT = BACKEND / "agentos" / "__init__.py"
PYPROJECT = BACKEND / "pyproject.toml"
VERSION_INFO = ROOT / "packaging" / "version_info.txt"
ISS = ROOT / "packaging" / "Rezident.iss"

_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _sub_once(path: Path, pattern: str, repl: str, *, count: int = 1) -> None:
    # Read bytes + detect the file's own newline style so a version bump only ever
    # rewrites the number, never churns CRLF<->LF (which would balloon the diff and
    # muddy `git blame`). We match against a \n-normalized copy so patterns stay
    # newline-agnostic, then restore the original ending on write.
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8").replace("\r\n", "\n")
    new, n = re.subn(pattern, repl, text, count=count, flags=re.MULTILINE)
    if n != count:
        raise SystemExit(f"{path}: expected {count} replacement(s) for /{pattern}/, made {n}")
    path.write_bytes(new.replace("\n", newline).encode("utf-8"))


def bump(version: str) -> None:
    if not _SEMVER.match(version):
        raise SystemExit(f"version must be X.Y.Z, got {version!r}")
    major, minor, patch = version.split(".")

    # 1) semantic source of truth
    _sub_once(INIT, r'__version__ = "\d+\.\d+\.\d+"', f'__version__ = "{version}"')

    # 2) distribution metadata
    _sub_once(PYPROJECT, r'^version = "\d+\.\d+\.\d+"', f'version = "{version}"')

    # 3) VS_VERSION_INFO resource — the two 4-tuples and the two display strings
    tup = f"({major}, {minor}, {patch}, 0)"
    _sub_once(VERSION_INFO, r"filevers=\(\d+, \d+, \d+, \d+\)", f"filevers={tup}")
    _sub_once(VERSION_INFO, r"prodvers=\(\d+, \d+, \d+, \d+\)", f"prodvers={tup}")
    _sub_once(VERSION_INFO, r"StringStruct\('FileVersion', '\d+\.\d+\.\d+'\)",
              f"StringStruct('FileVersion', '{version}')")
    _sub_once(VERSION_INFO, r"StringStruct\('ProductVersion', '\d+\.\d+\.\d+'\)",
              f"StringStruct('ProductVersion', '{version}')")

    # 4) Inno Setup installer version
    _sub_once(ISS, r'#define AppVersion "\d+\.\d+\.\d+"', f'#define AppVersion "{version}"')

    print(f"bumped all version copies -> {version}")
    print("  agentos/__init__.py, pyproject.toml, packaging/version_info.txt, packaging/Rezident.iss")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: bump_version.py <X.Y.Z>")
    bump(sys.argv[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
