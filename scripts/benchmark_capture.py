#!/usr/bin/env python3
"""Validate isolated Compose deployment and measure live public-page capture.

Requires a built Docker image and Python 3, no extra packages. Creates and removes
only a randomly named Compose project and its synthetic data volume.
"""
import argparse
import base64
import concurrent.futures
import datetime
import hashlib
import json
import platform
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from disposable_auth import bootstrap

ROOT = Path(__file__).resolve().parents[1]
URLS = [
    "https://go.dev/doc/",
    "https://go.dev/ref/spec",
    "https://www.sqlite.org/lang.html",
    "https://www.sqlite.org/lang_select.html",
    "https://docs.python.org/3/tutorial/index.html",
    "https://www.rfc-editor.org/rfc/rfc9110.html",
]
# Kernel lifetime peaks complement current-memory samples. The helper is included
# in cgroup memory, but excluded from application PID 1 RSS.
SAMPLER = r"""
while kill -0 1 2>/dev/null; do
  rss=0; hwm=0
  while read -r key value unit; do
    case "$key" in VmRSS:) rss=$value;; VmHWM:) hwm=$value;; esac
  done < /proc/1/status
  read -r current < /sys/fs/cgroup/memory.current
  read -r peak < /sys/fs/cgroup/memory.peak
  printf '%s %s %s %s\n' "$rss" "$hwm" "$current" "$peak"
  sleep 0.1
done
"""


def docker(*args, timeout=120):
    return subprocess.check_output(["docker", *args], text=True, timeout=timeout).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def summarize(samples):
    require(bool(samples), "no container memory samples received")
    return {
        "rss_peak_mib": round(max(s[1] for s in samples) / 1024, 2),
        "rss_kernel_high_water_mib": round(max(s[2] for s in samples) / 1024, 2),
        "cgroup_current_peak_mib": round(max(s[3] for s in samples) / 2**20, 2),
        "cgroup_kernel_peak_mib": round(max(s[4] for s in samples) / 2**20, 2),
        "samples": len(samples),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="pocketmark:validation")
    parser.add_argument("--output", default="reports/benchmark-capture.json")
    parser.add_argument("--features", action="store_true", help="also exercise offline archives, 19 MiB upload, annotations, bulk, WebDAV and full backup")
    args = parser.parse_args()
    project = "pocketmark-validation-" + secrets.token_hex(5)
    image = json.loads(docker("image", "inspect", args.image))[0]
    config = json.loads(docker("compose", "-f", str(ROOT / "compose.yaml"), "config", "--format", "json"))
    config.pop("name", None)
    service = config["services"]["pocketmark"]
    service.pop("build", None)
    service["image"] = args.image
    # Preserve actual Compose resource/security settings; isolate names and port.
    service["ports"] = [{"target": 8090, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}]
    for volume in config.get("volumes", {}).values():
        volume.pop("name", None)
    for network in config.get("networks", {}).values():
        network.pop("name", None)
    phase = ["idle_empty"]
    samples = []
    monitor = None
    reader = None
    with tempfile.TemporaryDirectory(prefix=project) as temp:
        config_path = Path(temp) / "compose.json"
        config_path.write_text(json.dumps(config))
        compose = ["compose", "-p", project, "-f", str(config_path)]
        try:
            docker(*compose, "up", "-d", "--wait", "--wait-timeout", "90")
            cid = docker(*compose, "ps", "-q", "pocketmark")
            inspect = json.loads(docker("inspect", cid))[0]
            host = inspect["HostConfig"]
            require(inspect["State"]["Health"]["Status"] == "healthy", "container is unhealthy")
            require(inspect["Config"]["User"] == "10001:10001", "unexpected runtime user")
            require(host["ReadonlyRootfs"], "root filesystem is not read-only")
            require(host["Memory"] == 128 * 2**20, "unexpected container memory limit")
            require(host["NanoCpus"] == 10**9 and host["PidsLimit"] == 64, "resource limits differ")
            require("ALL" in host["CapDrop"], "capabilities not dropped")
            require(any(s.startswith("no-new-privileges") for s in host["SecurityOpt"]), "privilege setting missing")
            require(docker("exec", cid, "stat", "-c", "%a:%u", "/data/server-secret") == "600:10001",
                    "secret permissions differ")
            token = ""
            port = inspect["NetworkSettings"]["Ports"]["8090/tcp"][0]["HostPort"]
            base = "http://127.0.0.1:" + port

            def call(path, payload=None, authenticated=True, raw=False, method=None, content_type="application/json"):
                headers = {"Content-Type": content_type}
                if authenticated and token:
                    headers["Authorization"] = "Bearer " + token
                body = payload if isinstance(payload, bytes) else (None if payload is None else json.dumps(payload).encode())
                req = urllib.request.Request(base + path, data=body, headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=45) as response:
                    return (response.read(), dict(response.headers)) if raw else json.load(response)

            try:
                call("/api/stats", authenticated=False)
                raise RuntimeError("unauthenticated API request unexpectedly succeeded")
            except urllib.error.HTTPError as error:
                require(error.code == 401, "expected HTTP 401")
            page, _ = call("/", authenticated=False, raw=True)
            require(b"Pocketmark" in page, "embedded UI missing")
            require(call("/healthz")["status"] == "ok", "health endpoint failed")
            token, session, password = bootstrap(base)
            monitor = subprocess.Popen(["docker", "exec", cid, "sh", "-c", SAMPLER],
                                       text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            def collect():
                for line in monitor.stdout:
                    values = line.split()
                    if len(values) == 4 and all(v.isdigit() for v in values):
                        samples.append((phase[0], *(int(v) for v in values)))

            reader = threading.Thread(target=collect, daemon=True)
            reader.start()
            time.sleep(3)
            phase[0] = "capture_and_search"
            start = time.perf_counter()
            imported = call("/api/import", {"format": "pocketmark", "version": 1, "collections": [],
                "links": [{"url": url, "tags": ["capture-benchmark"]} for url in URLS]})
            require(imported["imported"] == len(URLS), "fixture import incomplete")

            def search_stream(offset):
                for i in range(offset, 200, 4):
                    path = ["/api/links?q=language", "/api/links?tag=capture-benchmark",
                            "/api/links?unread=1", "/api/stats"][i % 4]
                    call(path)
                    time.sleep(0.05)

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(search_stream, offset) for offset in range(4)]
                deadline = time.monotonic() + 180
                while call("/api/stats")["pending"]:
                    require(time.monotonic() < deadline, "capture queue did not drain in 180 seconds")
                    time.sleep(0.25)
                for future in futures:
                    future.result()
            duration = time.perf_counter() - start
            stats = call("/api/stats")
            phase[0] = "verify_archives"
            records = []
            for link in call("/api/links")["links"]:
                detail = call("/api/links/" + str(link["id"]))
                record = {"url": link["url"], "status": detail["status"],
                          "text_bytes": len(detail.get("content", "").encode()), "error": detail.get("error", "")}
                if detail["status"] == "ready":
                    archive, headers = call(f'/api/links/{link["id"]}/archive', raw=True)
                    require(headers.get("Content-Disposition", "").startswith("attachment"), "archive isn't attachment")
                    require("sandbox" in headers.get("Content-Security-Policy", ""), "archive lacks sandbox")
                    require(archive, "successful capture archive is empty")
                    record.update(archive_bytes=len(archive), archive_sha256=hashlib.sha256(archive).hexdigest())
                records.append(record)
                print(json.dumps({"capture": record}), flush=True)
            require(len(records) == len(URLS), "bookmark count changed")
            require(len(call("/api/export")["links"]) == len(URLS), "export incomplete")
            features = {}
            if args.features:
                phase[0] = "extended_features"
                link = next(l for l in call("/api/links")["links"] if l["url"] == URLS[0])
                lid = link["id"]
                offline = call(f"/api/links/{lid}/preserve", {})
                require(offline["asset"]["size"] > 0, "offline snapshot is empty")
                features["offline"] = {"bytes": offline["asset"]["size"], "embedded": offline["embedded"], "omitted": offline["omitted"]}
                phase[0] = "large_upload"
                # Syntactically minimal PDF with trailing whitespace, 19 MiB.
                pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
                pdf += b" " * (19 * 2**20 - len(pdf))
                asset = call(f"/api/links/{lid}/assets?name=large-fixture.pdf", pdf, content_type="application/pdf")
                require(asset["size"] == len(pdf), "large upload truncated")
                downloaded, _ = call(f'/api/assets/{asset["id"]}', raw=True)
                require(hashlib.sha256(downloaded).digest() == hashlib.sha256(pdf).digest(), "uploaded bytes changed")
                features["large_upload_bytes"] = len(pdf)
                del pdf, downloaded
                file_record = call("/api/files?name=standalone.html", b"<!doctype html><html><body><article><h1>Standalone fixture</h1><p>Local document library test.</p></article></body></html>", content_type="text/html")
                require(file_record["link"]["type"] == "file" and file_record["link"]["status"] == "ready", "standalone file was queued as a URL")
                features["standalone_file_id"] = file_record["link"]["id"]
                phase[0] = "library_operations"
                collection = call("/api/collections", {"name": "Benchmark features"})
                call(f'/api/collections/{collection["id"]}', {"name": "Renamed benchmark", "parentId": None}, method="PUT")
                call("/api/links/bulk", {"ids": [lid], "action": "move", "collectionId": collection["id"]})
                call("/api/links/bulk", {"ids": [lid], "action": "read", "value": True})
                detail = call(f"/api/links/{lid}")
                text = detail["content"]
                quote = text[:min(30, len(text))]
                annotation = call(f"/api/links/{lid}/annotations", {"quote": quote, "start": 0, "end": len(quote), "note": "Benchmark note", "color": "yellow"})
                require(annotation["id"] > 0 and len(call(f"/api/links/{lid}/annotations")) == 1, "annotation failed")
                require(call("/api/links?q=Golang&fuzzy=1&sort=title")["pageSize"] == 40, "fuzzy query failed")
                bookmarks, _ = call("/api/export/html", raw=True)
                imported_html = call("/api/import/html", bookmarks, content_type="text/html")
                require(imported_html["imported"] == 0, "HTML roundtrip duplicated URLs")
                xbel, headers = call("/dav/bookmarks.xbel", raw=True)
                etag = next((v for k, v in headers.items() if k.lower() == "etag"), None)
                require(etag, "WebDAV response lacks ETag")
                req = urllib.request.Request(base + "/dav/bookmarks.xbel", data=xbel, method="PUT", headers={"Authorization": "Bearer " + token, "Content-Type": "application/xbel+xml", "If-Match": etag})
                with urllib.request.urlopen(req, timeout=45) as response:
                    require(response.status == 204, "WebDAV roundtrip failed")
                require(call(f"/api/links/{lid}/annotations")[0]["note"] == "Benchmark note", "sync discarded annotation")
                require(call(f'/api/links/{file_record["link"]["id"]}')["type"] == "file", "WebDAV removed standalone file")
                features["collection_bulk_annotation_html_xbel"] = True
                phase[0] = "floccus_staged_dav"
                dav_auth = "Basic " + base64.b64encode(("benchmark:" + token).encode()).decode()
                def dav(method, path, body=None, extra=None):
                    request = urllib.request.Request(base + path, data=body, method=method,
                        headers={"Authorization": dav_auth, "Origin": "chrome-extension://benchmark", "Sec-Fetch-Site": "cross-site",
                                 "Content-Type": "application/xml", **(extra or {})})
                    with urllib.request.urlopen(request, timeout=45) as response:
                        return response.status, response.read()
                require(dav("PROPFIND", "/dav/")[0] == 207, "extension Basic DAV discovery failed")
                require(dav("PUT", "/dav/bookmarks.xbel.lock", b"benchmark lock")[0] in (201, 204), "DAV lock failed")
                _, staged_xbel = dav("GET", "/dav/bookmarks.xbel")
                require(dav("PUT", "/dav/bookmarks.xbel.temp", staged_xbel)[0] in (201, 204), "DAV staging failed")
                _, properties = dav("PROPFIND", "/dav/bookmarks.xbel.temp")
                sizes = [node.text for node in ET.fromstring(properties).iter("{DAV:}getcontentlength")]
                require(sizes == [str(len(staged_xbel))], "DAV staged byte count differs")
                require(dav("MOVE", "/dav/bookmarks.xbel.temp", extra={"Destination": base + "/dav/bookmarks.xbel", "Overwrite": "T"})[0] == 204, "DAV MOVE failed")
                require(dav("GET", "/dav/bookmarks.xbel")[1] == staged_xbel, "DAV changed uploaded bytes")
                require(dav("DELETE", "/dav/bookmarks.xbel.lock")[0] == 204, "DAV unlock failed")
                features["floccus_basic_lock_temp_move_exact_bytes"] = True
                phase[0] = "full_backup"
                reauth = urllib.request.Request(base + "/api/reauth", data=json.dumps({"password": password}).encode(), headers={"Cookie": session, "Content-Type": "application/json"})
                with urllib.request.urlopen(reauth, timeout=30) as response:
                    require(response.status == 200, "backup reauthentication failed")
                req = urllib.request.Request(base + "/api/backup", headers={"Cookie": session})
                backup_path = Path(temp) / "backup.zip"
                with urllib.request.urlopen(req, timeout=60) as response, backup_path.open("wb") as target:
                    while block := response.read(64 * 1024):
                        target.write(block)
                with zipfile.ZipFile(backup_path) as backup:
                    require(backup.testzip() is None and "pocketmark.db" in backup.namelist(), "invalid backup ZIP")
                features["backup_zip_bytes"] = backup_path.stat().st_size
                features["full_backup_valid"] = True
                stats = call("/api/stats")
            phase[0] = "idle_captured"
            time.sleep(5)
            # End measurement before restart resets kernel lifetime counters.
            monitor.terminate()
            monitor.wait(timeout=10)
            reader.join(timeout=5)
            require(samples and not reader.is_alive(), "sampler did not finish")
            measured = list(samples)
            events = dict(line.split() for line in docker("exec", cid, "cat", "/sys/fs/cgroup/memory.events").splitlines())
            require(int(events["oom_kill"]) == 0, "container experienced OOM")
            binary_sha = docker("exec", cid, "sha256sum", "/usr/local/bin/pocketmark").split()[0]
            kernel = docker("exec", cid, "uname", "-srmo")
            docker(*compose, "restart", "pocketmark")
            # Docker may reassign an ephemeral published port on restart.
            restarted = json.loads(docker("inspect", cid))[0]
            port = restarted["NetworkSettings"]["Ports"]["8090/tcp"][0]["HostPort"]
            base = "http://127.0.0.1:" + port
            for attempt in range(100):
                try:
                    if call("/healthz")["status"] == "ok":
                        break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("server did not restart")
            require(call("/api/stats") == stats, "library or authentication did not persist")
            if args.features:
                require(call("/dav/bookmarks.xbel", raw=True)[0] == staged_xbel,
                        "DAV snapshot bytes changed after restart")
            for old in records:
                if old["status"] != "ready":
                    continue
                link = next(l for l in call("/api/links")["links"] if l["url"] == old["url"])
                archive, _ = call(f'/api/links/{link["id"]}/archive', raw=True)
                require(hashlib.sha256(archive).hexdigest() == old["archive_sha256"], "archive changed after restart")
            require(not json.loads(docker("inspect", cid))[0]["State"]["OOMKilled"], "container was OOM killed")
            results = {
                "measured_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "host": platform.platform(), "container_kernel": kernel,
                "image_id": image["Id"], "image_architecture": image["Architecture"],
                "image_size_mib": round(image["Size"] / 2**20, 2), "binary_sha256": binary_sha,
                "capture_enabled": True, "memory_limit_mib": host["Memory"] / 2**20,
                "go_memory_limit": "32MiB", "capture_concurrency": 1,
                "requests": 200, "request_concurrency": 4,
                "capture_and_search_seconds": round(duration, 3), "stats": stats, "captures": records,
                "extended_features": features,
                "overall": summarize(measured),
                "phases": {p: summarize([s for s in measured if s[0] == p])
                           for p in dict.fromkeys(s[0] for s in measured)},
                "memory_events_before_restart": events,
                "validation": {"healthy_startup": True, "non_root": True, "read_only_root": True,
                    "dropped_capabilities": True, "resource_limits": True, "token_permissions": True,
                    "unauthenticated_api_denied": True, "embedded_ui": True, "archive_headers": True,
                    "metadata_export": True, "restart_persistence": True, "oom_killed": False},
                "limits": "Six live public HTML pages, not 10000 captured pages or worst-case stress. RSS is PID 1 only. Cgroup includes page cache, healthcheck and small shell/sleep sampler. Kernel peaks are lifetime values; phase current peaks are sampled about every100ms. Docker VM/host/browser excluded. Remote content/timings can change; no upstream comparison."
            }
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(results, indent=2), flush=True)
            require(stats["failed"] == 0, "some captures failed; see recorded per-page errors")
            require(all(r["text_bytes"] for r in records), "some captured pages have no reader text; see recorded per-page results")
        except Exception:
            # App logs contain paths/errors, never the generated token value.
            print(docker(*compose, "logs", "--no-color", "--tail", "30"), flush=True)
            raise
        finally:
            if monitor and monitor.poll() is None:
                monitor.terminate()
                monitor.wait(timeout=10)
            if reader:
                reader.join(timeout=5)
            docker(*compose, "down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
