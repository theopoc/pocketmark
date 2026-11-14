#!/usr/bin/env python3
"""Probe only a disposable local Docker instance; never an existing service."""

import argparse
import http.client
import json
import os
import secrets
import subprocess
import time
import tempfile
from pathlib import Path
from disposable_auth import bootstrap


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    name = "pocketmark-import-probe-" + secrets.token_hex(6)
    key = secrets.token_hex(32)
    environment = {**os.environ, "POCKETMARK_TOKEN": key, "POCKETMARK_DB_PASSWORD": secrets.token_hex(32)}

    def docker(*arguments):
        return subprocess.check_output(
            ["docker", *arguments], text=True, env=environment, timeout=60
        ).strip()

    results = {"image": args.image, "memoryLimitBytes": 128 << 20, "requests": []}
    passed = True
    with tempfile.TemporaryDirectory(prefix=name) as directory:
        config = json.loads(docker("compose", "-f", str(Path(__file__).resolve().parents[1] / "compose.yaml"),
                                   "config", "--format", "json"))
        config.pop("name", None)
        for category in ("volumes", "networks"):
            for entry in config.get(category, {}).values():
                entry.pop("name", None)
        service = config["services"]["pocketmark"]
        service.pop("build", None)
        service["image"] = args.image
        service["ports"] = [{"target":8090, "published":"0", "host_ip":"127.0.0.1", "protocol":"tcp"}]
        service["environment"].update(POCKETMARK_CAPTURE="false", POCKETMARK_TOKEN=key)
        service["memswap_limit"] = service["mem_limit"]
        config_path = Path(directory) / "compose.json"
        config_path.write_text(json.dumps(config))
        compose = ["compose","-p",name,"-f",str(config_path)]
        try:
            docker(*compose, "up", "-d", "--wait", "--wait-timeout", "45")
            container = docker(*compose, "ps", "-q", "pocketmark")
            port = int(docker("port", container, "8090/tcp").rsplit(":", 1)[1])

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
            key, _, _ = bootstrap(f"http://127.0.0.1:{port}")
            results["imageID"] = docker("inspect", "--format", "{{.Image}}", container)
            results["identity"] = docker("exec", container, "id")
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
                state = json.loads(docker("inspect", "--format", "{{json .State}}", container))
                row.update(running=state["Running"], oomKilled=state["OOMKilled"])
                if state["Running"]:
                    row["cgroupMemoryPeakBytes"] = int(docker("exec", container, "cat", "/sys/fs/cgroup/memory.peak"))
                passed &= (row.get("status") == 400 and row.get("healthAfter") == 200
                           and row.get("libraryAfter") == 200 and not state["OOMKilled"])
                results["requests"].append(row)
                if not state["Running"]:
                    break
        finally:
            docker(*compose, "down", "--volumes", "--remove-orphans")
    results["passed"] = passed
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    if not passed:
        raise SystemExit("Import resource regression detected")


if __name__ == "__main__":
    main()
