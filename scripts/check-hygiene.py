#!/usr/bin/env python3
"""Fail on private data that a later commit cannot take back.

A bug gets fixed in the next release. A machine path, a client name or a
personal address is scraped the moment it lands on a public repo, and removing
it costs a history rewrite that every clone and fork has to follow. So this runs
on the PR, not at release.

Three shapes are worth naming, because all three actually shipped in this repo's
siblings and none would have been caught by an obvious `/Users/` grep:

  - Home directories arrive DASH-MANGLED from tooling that flattens paths
    (`-Users-<name>-<project>`). `pip-compile` wrote one into a committed lock
    file as a `# via -r <path>` annotation; nobody typed it, and it sat in a
    public repo for two commits.
  - Client and employer names leak through COMMIT MESSAGES far more often than
    through files, because messages get far less review than diffs. Two sibling
    repos leaked a client name that way, never in any file.
  - Client names usually arrive INSIDE a hostname (`clientname.com`), so hashing
    only whole tokens misses them. Dot- and dash-separated parts are checked too.

Identifiers are matched by SHA-256, never in plaintext. A denylist written in
the clear publishes, inside the guard, the exact strings the guard exists to
keep out — which is precisely how one sibling repo leaked a private address,
inside the very check meant to catch it.

Run locally with `python3 scripts/check-hygiene.py`; CI runs the same file.
"""
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Operator, employer and client identifiers. Add one with:
#   python3 -c "import hashlib;print(hashlib.sha256(b'value').hexdigest()[:32])"
BANNED = {
    "95aae01e3ad9faaf0679cff78c8948fd",
    "d85074cb992106e8f9d3fcee509c8faf",
    "29ac921146e53202b38bc6145b0431e4",
    "55f7c00f1c064164f28a53a7803f1bc8",
}

MACHINE_PATHS = [
    (re.compile(r"/private/tmp/claude-[0-9]+/"), "agent sandbox path"),
    (re.compile(r"/Users/(?!<)[A-Za-z0-9._-]+/"), "macOS home directory"),
    (re.compile(r"(?<![\w-])-Users-[A-Za-z0-9._-]+-"), "dash-mangled macOS home directory"),
]

FREE_MAIL = re.compile(
    r"[a-zA-Z0-9._%+-]+@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|proton|"
    r"protonmail|gmx|seznam|aol)\.[a-z.]{2,}", re.I)

SECRETS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key block"),
    (re.compile(r"[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@"), "credentialed connection string"),
    (re.compile(r"(?i)authorization\s*:\s*(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}"),
     "auth header with credential"),
    (re.compile(r"""(?i)\b(api[_-]?key|secret|token|password|credential)s?\b\W{0,3}[:=]\s*"""
                r"""["'][A-Za-z0-9/+_.-]{16,}["']"""), "assigned credential literal"),
]

SUFFIXES = (".md", ".py", ".js", ".jsx", ".php", ".json", ".yml", ".yaml", ".sh", ".txt", ".css", ".html")

failures = []


def scan(where, text):
    for i, line in enumerate(text.splitlines(), 1):
        at = f"{where}:{i}"
        for tok in re.findall(r"[A-Za-z0-9._-]{4,}", line):
            for part in {tok, *re.split(r"[.\-_]", tok)}:
                if len(part) >= 4 and hashlib.sha256(part.lower().encode()).hexdigest()[:32] in BANNED:
                    failures.append(f"{at}: operator/client identifier — use a placeholder")
        for rx, what in MACHINE_PATHS:
            if rx.search(line):
                failures.append(f"{at}: {what} — use a placeholder")
        m = FREE_MAIL.search(line)
        if m:
            failures.append(f"{at}: personal email {m.group(0)}")
        for rx, what in SECRETS:
            if rx.search(line):
                failures.append(f"{at}: {what} — never commit a credential")


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True,
                          text=True, check=True).stdout


for rel in git("ls-files").split("\n"):
    # This file carries every pattern by definition; scanning it fails on itself.
    if not rel or rel.endswith("check-hygiene.py") or not rel.endswith(SUFFIXES):
        continue
    f = ROOT / rel
    if f.is_file():
        scan(rel, f.read_text(errors="ignore"))

# Commit messages — where the real leaks were.
for entry in git("log", "--all", "--format=%H%x00%B%x00").split("\0\0"):
    parts = entry.split("\0")
    if len(parts) >= 2 and parts[0].strip():
        scan(f"commit {parts[0].strip()[:9]}", parts[1])

if failures:
    print(f"✘ {len(failures)} hygiene failure(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("✔ hygiene clean — no machine paths, operator/client identifiers, personal mail, or secrets")
