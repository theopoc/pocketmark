#!/usr/bin/env python3
"""Select full, extension-only or documentation checks from the complete diff."""
import json
import os
from pathlib import PurePosixPath
import re
import subprocess


def documentation(path):
    path = PurePosixPath(path)
    # These documents are release inputs; keep packaging validation for them.
    if str(path) in {"CHANGELOG.md", "docs/RELEASE_INSTALL.md", "extension/README.md"}:
        return False
    if len(path.parts) == 1 and path.suffix == ".md":
        return True
    if path.parts[0] == "docs" and path.suffix in {".md", ".json", ".png", ".jpg", ".jpeg", ".svg"}:
        return True
    return str(path) == ".github/pull_request_template.md"


def check_scope(event_name, event):
    if event_name == "pull_request":
        pr = event.get("pull_request", {})
        base, head = pr.get("base", {}).get("sha", ""), pr.get("head", {}).get("sha", "")
        separator = "..."  # All PR commits since the merge base, including edits/reopens.
    elif event_name == "push":
        base, head = event.get("before", ""), event.get("after", "")
        separator = ".."  # Every commit in the push, not just its last commit.
    else:
        return 'full'  # Manual and scheduled runs always produce complete evidence.
    if any(not re.fullmatch(r"[0-9a-f]{40}", sha) or sha == "0" * 40 for sha in (base, head)):
        return 'full'
    try:
        changed = subprocess.check_output([
            "git", "diff", "--name-only", "--no-renames", "-z", base + separator + head, "--"
        ], stderr=subprocess.PIPE, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return 'full'
    # NUL delimiters and disabled rename detection cover unusual names and both
    # sides of a rename. Never rely on a truncated API file list.
    paths = [os.fsdecode(path) for path in changed.split(b"\0") if path]
    if not paths:
        return 'full'
    extension = False
    for path in paths:
        if path.startswith('extension/'):
            extension = True
        elif not documentation(path):
            return 'full'
    return 'extension' if extension else 'docs'


if __name__ == "__main__":
    with open(os.environ["GITHUB_EVENT_PATH"]) as source:
        scope = check_scope(os.environ["GITHUB_EVENT_NAME"], json.load(source))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"full={str(scope == 'full').lower()}\n")
        output.write(f"extension={str(scope != 'docs').lower()}\n")
    print(f"Selected CI scope: {scope}.")
