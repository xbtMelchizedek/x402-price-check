#!/usr/bin/env python3
"""Fail if any tracked (or about-to-be-committed) file looks like it holds a secret."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private key block": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "github token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
    "aws key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "slack token": re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    "openai-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    "assignment": re.compile(
        r"(?i)\b(?:password|passphrase|mnemonic|api[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*['\"][^'\"]{8,}"
    ),
    "base58 64-byte secret": re.compile(
        r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,90}(?![1-9A-HJ-NP-Za-km-z])"
    ),
}
BAD_NAMES = re.compile(r"(?i)(\.seed|\.pem|\.key|\.keystore\.json|\.pass|\.env)$|(^|/)keys/")
SKIP = {"scripts/secret_scan.py"}


def files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return [f for f in out.stdout.splitlines() if f]


def main() -> int:
    hits = []
    seen = files()
    for f in seen:
        if BAD_NAMES.search(f):
            hits.append((f, "secret-like filename"))
            continue
        if f in SKIP or f.startswith("test/"):
            continue
        p = ROOT / f
        if not p.is_file():
            continue
        text = p.read_text(errors="ignore")
        for name, rx in PATTERNS.items():
            if rx.search(text):
                hits.append((f, name))
    for f, why in hits:
        print(f"SECRET? {f}: {why}")
    print(f"secret scan: {len(seen)} files, {len(hits)} findings")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
