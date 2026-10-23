#!/usr/bin/env python3
"""Select extension regressions using complete Git diffs, including deleted paths."""
import json
import os
from pathlib import Path
import subprocess


def affected(paths):
    return any(path.startswith("extension/") or path in {
        "Makefile", ".github/workflows/ci.yml", "scripts/extension_changes.py",
        "scripts/test_extension_changes.py",
    } for path in paths)


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def changed(event, name):
    if name == "pull_request":
        base = git("merge-base", event["pull_request"]["base"]["sha"], "HEAD")
    elif name == "push" and event.get("before", "").strip("0"):
        base = event["before"]
    else:
        # Manual release-PR dispatches compare the whole branch to main. On main,
        # scheduled/manual checks compare the last commit, not an empty main diff.
        base = git("merge-base", "origin/main", "HEAD")
        if base == git("rev-parse", "HEAD"):
            base = git("rev-parse", "HEAD^")
    return affected(git("diff", "--name-only", "--no-renames", base, "HEAD").splitlines())


if __name__ == "__main__":
    selected = changed(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()), os.environ["GITHUB_EVENT_NAME"])
    with open(os.environ["GITHUB_OUTPUT"], "a") as target:
        target.write(f"extension={str(selected).lower()}\n")
