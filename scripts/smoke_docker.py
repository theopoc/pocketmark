#!/usr/bin/env python3
"""Deterministic, isolated Compose smoke test; no public-site availability needed."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=120).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    parser.add_argument("--revision", help="Require this OCI source revision label")
    parser.add_argument("--version", help="Require this OCI version label")
    parser.add_argument("--browser", action="store_true", help="Run essential Chromium journeys on this disposable instance")
    args = parser.parse_args()
    project = "pocketmark-smoke-" + secrets.token_hex(6)
    config = json.loads(docker("compose", "-f", str(ROOT / "compose.yaml"), "config", "--format", "json"))
    config.pop("name", None)
    service = config["services"]["pocketmark"]
    service.pop("build", None)
    service["image"] = args.image
    if args.platform:
        service["platform"] = args.platform
    service["ports"] = [{"target": 8090, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}]
    for category in ("volumes", "networks"):
        for entry in config.get(category, {}).values():
            entry.pop("name", None)
    checks = {}
    with tempfile.TemporaryDirectory(prefix=project) as directory:
        configuration = Path(directory) / "compose.json"
        configuration.write_text(json.dumps(config))
        compose = ["compose", "-p", project, "-f", str(configuration)]
        try:
            docker(*compose, "up", "-d", "--wait", "--wait-timeout", "90")
            cid = docker(*compose, "ps", "-q", "pocketmark")
            details = json.loads(docker("inspect", cid))[0]
            image = json.loads(docker("image", "inspect", details["Image"]))[0]
            platform = image["Os"] + "/" + image["Architecture"]
            if args.platform:
                require(platform == args.platform, "wrong image architecture")
            labels = details["Config"].get("Labels") or {}
            for key, expected in (("revision", args.revision), ("version", args.version)):
                if expected:
                    require(labels.get("org.opencontainers.image." + key) == expected, "wrong image " + key)
            host = details["HostConfig"]
            require(details["Config"]["User"] == "10001:10001", "runtime must be non-root")
            require(host["ReadonlyRootfs"] and "ALL" in host["CapDrop"], "container hardening changed")
            require(any(x.startswith("no-new-privileges") for x in host["SecurityOpt"]), "privilege protection missing")
            require(host["Memory"] == 128 * 2**20 and host["NanoCpus"] == 10**9 and host["PidsLimit"] == 64,
                    "Compose resource limits changed")
            require(docker("exec", cid, "stat", "-c", "%a:%u", "/data/access-token") == "600:10001", "token permissions changed")
            # Keep the generated token in memory, never in reports or logs.
            token = docker("exec", cid, "cat", "/data/access-token")
            port = details["NetworkSettings"]["Ports"]["8090/tcp"][0]["HostPort"]
            base = "http://127.0.0.1:" + port

            def call(path, payload=None, authenticated=True, raw=False):
                headers = {"Content-Type": "application/json"}
                if authenticated:
                    headers["Authorization"] = "Bearer " + token
                body = None if payload is None else json.dumps(payload).encode()
                req = urllib.request.Request(base + path, data=body, headers=headers)
                with urllib.request.urlopen(req, timeout=15) as response:
                    result = response.read()
                    return result if raw else json.loads(result)

            require(call("/healthz")["status"] == "ok", "health check failed")
            require(b"Pocketmark" in call("/", authenticated=False, raw=True), "embedded UI missing")
            try:
                call("/api/stats", authenticated=False)
            except urllib.error.HTTPError as error:
                require(error.code == 401, "expected unauthenticated 401")
            else:
                raise RuntimeError("unauthenticated API access succeeded")
            checks["health_auth_hardening_limits"] = True
            if args.browser:
                subprocess.run(["node", str(ROOT / "e2e/browser.mjs")],
                               env={**os.environ, "E2E_BASE_URL": base, "E2E_SETUP_TOKEN": token}, check=True, timeout=180)
                checks["browser_journeys"] = True
            collection = call("/api/collections", {"name": "Smoke collection", "description": "Synthetic CI data"})
            link = call("/api/links", {"url": "http://127.0.0.1/private-ci-fixture", "title": "Smoke bookmark",
                                        "collectionId": collection["id"], "tags": ["ci"]})
            # Capture stays enabled. A loopback URL must fail without a network fetch.
            for _ in range(100):
                saved = call(f"/api/links/{link['id']}")
                if saved["status"] == "failed":
                    break
                time.sleep(0.1)
            require(saved["status"] == "failed", "capture worker did not reject the private destination")
            require(call("/api/links?q=Smoke")["total"] == 1, "FTS5 search failed")
            checks["sqlite_fts5_and_capture_ssrf_rejection"] = True
            # A full backup must be a valid ZIP and must not contain the recovery token.
            backup = call("/api/backup", raw=True)
            with zipfile.ZipFile(io.BytesIO(backup)) as archive:
                require(archive.testzip() is None, "backup ZIP is corrupt")
                require(not any("access-token" in x for x in archive.namelist()), "backup contains the recovery token")
            checks["full_backup"] = True
            before = hashlib.sha256(call("/api/export", raw=True)).hexdigest()
            events = dict(line.split() for line in docker("exec", cid, "cat", "/sys/fs/cgroup/memory.events").splitlines())
            require(all(events.get(k) == "0" for k in ("max", "oom", "oom_kill")), "memory-limit or OOM event")
            require(not json.loads(docker("inspect", cid))[0]["State"]["OOMKilled"], "container was OOM killed")
            docker(*compose, "restart")
            # An ephemeral host port may be reassigned during a Docker restart.
            restarted = json.loads(docker("inspect", cid))[0]
            port = restarted["NetworkSettings"]["Ports"]["8090/tcp"][0]["HostPort"]
            base = "http://127.0.0.1:" + port
            for _ in range(100):
                try:
                    if call("/healthz")["status"] == "ok":
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("server did not become healthy after restart")
            require(before == hashlib.sha256(call("/api/export", raw=True)).hexdigest(), "library changed across restart")
            require(token == docker("exec", cid, "cat", "/data/access-token"), "token changed across restart")
            checks["restart_persistence_and_no_oom"] = True
            report = {"image": args.image, "image_id": details["Image"], "platform": platform,
                      "revision": labels.get("org.opencontainers.image.revision"),
                      "version": labels.get("org.opencontainers.image.version"),
                      "checks": checks, "memory_events_before_restart": events,
                      "scope": "Synthetic isolated Compose smoke; not a live-page or RAM benchmark"}
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report, indent=2))
        finally:
            docker(*compose, "down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
