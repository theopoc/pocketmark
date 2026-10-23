#!/usr/bin/env python3
"""Validate a PR title as the future squash commit used by Release Please."""
import json
import os
import re


TITLE = re.compile(
    r"(?:feat|fix|perf|revert|docs|style|refactor|test|build|ci|chore)"
    r"(?:\([^()\r\n]+\))?!?: \S[^\r\n]*"
)


def validate_title(title):
    if not isinstance(title, str) or not TITLE.fullmatch(title):
        raise ValueError("Use a Conventional Commit PR title, for example: fix(api): reject invalid tokens")


def main():
    # Read untrusted metadata as JSON, never interpolate it into shell code.
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event_file:
        validate_title(json.load(event_file)["pull_request"]["title"])
    print("PR title is valid for squash merging and Release Please.")


if __name__ == "__main__":
    main()
