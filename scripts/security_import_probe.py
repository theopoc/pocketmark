#!/usr/bin/env python3
"""Probe only a disposable local Docker instance; never an existing service."""

import argparse
import http.client
import json
import os
import secrets
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    name = "pocketmark-import-probe-" + secrets.token_hex(6)
    key = secrets.token_hex(32)
    environment = {**os.environ, "POCKETMARK_TOKEN": key}

    def docker(*arguments):
        return subprocess.check_output(
            ["docker", *arguments], text=True, env=environment, timeout=60
        ).strip()

    results = {"image": args.image, "memoryLimitBytes": 128 << 20, "requests": []}
    passed = True
    try:
        docker(
            "run", "-d", "--name", name, "--label", "pocketmark.audit=import-probe",
            "--memory", "128m", "--memory-swap", "128m", "--cpus", "1",
            "--pids-limit", "64", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1::8090",
            "-e", "POCKETMARK_TOKEN", "-e", "POCKETMARK_CAPTURE=false", args.image,
        )
        port = int(docker("port", name, "8090/tcp").rsplit(":", 1)[1])

        def request(method, path, body=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
            try:
                connection.request(method, path, body=body, headers={
                    "Authorization": "Bearer " + key, "Content-Type": "application/json",
                })
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()

        for _ in range(100):
            try:
                if request("GET", "/healthz") == 200:
                    break
            except OSError:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("Disposable instance failed readiness")
        results["imageID"] = docker("inspect", "--format", "{{.Image}}", name)
        results["identity"] = docker("exec", name, "id")
        objects = b"{}," * 999999 + b"{}"
        for case, payload in (
            ("million-links", b'{"links":[' + objects + b"]}"),
            ("million-pins", b'{"links":[],"pinnedLinks":[' + objects + b"]}"),
            ("million-tags", b'{"links":[{"tags":[' + objects + b"]}]}"),
            ("trailing-document", b'{"links":[]} [' + objects + b"]"),
        ):
            row = {"case": case, "inputBytes": len(payload)}
            try:
                row["status"] = request("POST", "/api/import", payload)
                row["healthAfter"] = request("GET", "/healthz")
                row["libraryAfter"] = request("GET", "/api/stats")
            except (OSError, http.client.HTTPException) as error:
                row["connectionError"] = type(error).__name__
            state = json.loads(docker("inspect", "--format", "{{json .State}}", name))
            row.update(running=state["Running"], oomKilled=state["OOMKilled"])
            if state["Running"]:
                row["cgroupMemoryPeakBytes"] = int(docker("exec", name, "cat", "/sys/fs/cgroup/memory.peak"))
            passed &= (row.get("status") == 400 and row.get("healthAfter") == 200
                       and row.get("libraryAfter") == 200 and not state["OOMKilled"])
            results["requests"].append(row)
            if not state["Running"]:
                break
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", name],
                       stdout=subprocess.DEVNULL, check=False, timeout=60)
    results["passed"] = passed
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    if not passed:
        raise SystemExit("Import resource regression detected")


if __name__ == "__main__":
    main()
