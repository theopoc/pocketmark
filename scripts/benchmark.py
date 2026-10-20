#!/usr/bin/env python3
"""Measure process RSS with a repeatable personal-bookmark workload (macOS/Linux).

Uses only Python's standard library. Runs an isolated, temporary instance with
capture disabled; never touches an existing library or fetches bookmark URLs.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import platform
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="bin/pocketmark")
    parser.add_argument("--links", type=int, default=10000)
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    if not 1 <= args.links <= 10000:
        parser.error("--links must be between 1 and 10000")
    binary = Path(args.binary).resolve()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    token = secrets.token_hex(32)
    stopped = threading.Event()
    samples = []
    phase = ["startup"]

    def call(path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(base + path, data=body, headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    with tempfile.TemporaryDirectory(prefix="pocketmark-bench-") as data:
        with open(Path(data) / "server.log", "w+") as log:
            env = {**os.environ, "POCKETMARK_TOKEN": token, "GOMEMLIMIT": "32MiB"}
            proc = subprocess.Popen([str(binary), "-listen", f"127.0.0.1:{port}",
                                     "-data", data, "-no-capture"], env=env, stdout=log, stderr=log)

            def monitor():
                while not stopped.is_set():
                    try:
                        # macOS and Linux ps both report resident set size in KiB.
                        value = subprocess.check_output(["ps", "-o", "rss=", "-p", str(proc.pid)], text=True)
                        samples.append((phase[0], int(value.strip()) / 1024))
                    except (subprocess.SubprocessError, ValueError):
                        pass
                    stopped.wait(0.05)

            thread = threading.Thread(target=monitor, daemon=True)
            thread.start()
            try:
                for attempt in range(100):
                    try:
                        call("/healthz")
                        break
                    except OSError:
                        if proc.poll() is not None:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(0.05)
                else:
                    raise RuntimeError("server did not become ready")
                phase[0] = "idle_empty"
                time.sleep(2)
                payload = {"format": "pocketmark", "version": 1, "collections": [], "links": [
                    {"url": f"https://example.com/bookmark/{i}", "title": f"Bookmark {i} SQLite research",
                     "description": "Synthetic metadata fixture for a reproducible benchmark.",
                     "notes": "Read and compare storage architectures.", "tags": ["research", f"topic-{i % 20}"],
                     "favorite": i % 5 == 0, "read": i % 3 == 0}
                    for i in range(args.links)]}
                phase[0] = "import"
                start = time.perf_counter()
                imported = call("/api/import", payload)
                import_seconds = time.perf_counter() - start
                assert imported["imported"] == args.links, imported
                del payload
                phase[0] = "search_and_list"
                start = time.perf_counter()
                def query(i):
                    path = ["/api/links?q=SQLite", "/api/links?tag=research&favorite=1",
                            "/api/links?unread=1", "/api/links?page=2"][i % 4]
                    result = call(path)
                    assert isinstance(result["links"], list)
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(query, range(200)))
                search_seconds = time.perf_counter() - start
                phase[0] = "export"
                exported = call("/api/export")
                assert len(exported["links"]) == args.links
                del exported
                phase[0] = "idle_loaded"
                time.sleep(3)
                if not samples:
                    raise RuntimeError("RSS sampling failed; ps access is required")
                results = {
                    "platform": platform.platform(), "architecture": platform.machine(),
                    "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "binary_mib": round(binary.stat().st_size / 2**20, 2),
                    "links": args.links, "capture_enabled": False, "go_memory_limit": "32MiB",
                    "requests": 200, "concurrency": 4,
                    "import_seconds": round(import_seconds, 3), "requests_seconds": round(search_seconds, 3),
                    "rss_peak_mib": round(max(v for _, v in samples), 2),
                    "phase_peak_rss_mib": {p: round(max(v for k, v in samples if k == p), 2)
                                           for p in dict.fromkeys(k for k, _ in samples)},
                    "rss_samples": len(samples), "sampling_interval_seconds": 0.05,
                    "limits": "Process RSS only; sampled peaks may miss spikes. Synthetic metadata, no captures, browser, Docker, or upstream baseline."
                }
                text = json.dumps(results, indent=2) + "\n"
                if args.output:
                    Path(args.output).write_text(text)
                print(text, end="")
            finally:
                stopped.set()
                thread.join(timeout=2)
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


if __name__ == "__main__":
    main()
