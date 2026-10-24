#!/usr/bin/env python3
"""Wait for the complete main CI run, including final SHA-image validation."""
import argparse
import json
import os
import re
import subprocess
import time


def successful_run(runs, revision, repo):
    candidates = [run for run in runs if run.get("head_sha") == revision
                  and run.get("event") == "push" and run.get("head_branch") == "main"
                  and run.get("path") == ".github/workflows/ci.yml"
                  and run.get("head_repository", {}).get("full_name", "").lower() == repo.lower()]
    if not candidates:
        return None
    latest = max(candidates, key=lambda run: run["id"])
    if latest["status"] != "completed":
        return None
    if latest["conclusion"] != "success":
        raise ValueError("Main CI did not succeed: " + latest["html_url"])
    return latest["id"]


def require_artifacts(artifacts):
    available = {artifact["name"] for artifact in artifacts if not artifact.get("expired", True)}
    expected = {"linux-amd64", "linux-arm64", "container-index"}
    if not expected <= available:
        raise ValueError("Main CI is missing retained binaries or SHA-image evidence: " + ", ".join(sorted(expected - available)))


def wait(revision, timeout=3300):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("invalid source revision")
    repo = os.environ["GITHUB_REPOSITORY"]
    deadline = time.monotonic() + timeout
    while True:
        response = subprocess.check_output([
            "gh", "api", f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={revision}&event=push&branch=main&per_page=100"
        ], text=True, timeout=60)
        run_id = successful_run(json.loads(response)["workflow_runs"], revision, repo)
        if run_id:
            pages = json.loads(subprocess.check_output([
                "gh", "api", "--paginate", "--slurp", f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100"
            ], text=True, timeout=60))
            require_artifacts([artifact for page in pages for artifact in page["artifacts"]])
            return run_id
        if time.monotonic() >= deadline:
            raise TimeoutError("No successful main CI with a validated SHA image; rerun CI for this main commit.")
        time.sleep(15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    run_id = wait(args.revision)
    with open(os.environ["GITHUB_OUTPUT"], "a") as target:
        target.write(f"run_id={run_id}\n")
