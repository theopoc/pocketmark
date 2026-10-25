#!/usr/bin/env python3
"""Qualify a published GHCR image and retain a sanitized result, including failures."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIGEST = r"sha256:[0-9a-f]{64}"
REVISION = r"[0-9a-f]{40}"
VERSION = r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
IMAGE = rf"(ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+):({VERSION})"
SMOKE_CHECKS = ("health_auth_hardening_limits", "sqlite_fts5_and_capture_ssrf_rejection",
                "full_backup", "restart_persistence_and_no_oom")


class QualificationError(ValueError):
    """A fixed diagnostic safe to retain in a public CI log or artifact."""


def require(condition, reason):
    if not condition:
        raise QualificationError(reason)


def command(*args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=timeout).stdout


def require_private(image, tag):
    repository = image.removeprefix("ghcr.io/")
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{repository}:pull"})
    try:
        with urllib.request.urlopen("https://ghcr.io/token?" + query, timeout=30) as response:
            token = json.load(response)["token"]
        request = urllib.request.Request(f"https://ghcr.io/v2/{repository}/manifests/{tag}", headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
        })
        with urllib.request.urlopen(request, timeout=30):
            pass
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        require(status in (401, 403, 404), "cannot establish private registry access")
        return
    raise QualificationError("published image is anonymously readable")


def qualify(image, digest, revision, platform, report_path):
    result = {"schema_version": 1, "status": "failed", "stage": "input", "checks": {}}
    try:
        reference = re.fullmatch(IMAGE, image)
        require(reference is not None, "expected a GHCR stable version image")
        require(re.fullmatch(DIGEST, digest) is not None, "invalid expected index digest")
        require(re.fullmatch(REVISION, revision) is not None, "invalid expected source revision")
        require(platform in ("linux/amd64", "linux/arm64"), "unsupported image platform")
        repository, tag = reference.groups()
        version = tag
        result["expected"] = {"image": image, "digest": digest, "revision": revision,
                              "platform": platform, "version": version}
        result["checks"]["input"] = True

        result["stage"] = "pull"
        command("docker", "pull", "--platform", platform, image)
        result["checks"]["pull"] = True

        result["stage"] = "digest"
        index = json.loads(command("docker", "buildx", "imagetools", "inspect", image,
                                   "--format", "{{json .Manifest}}"))
        require(index.get("digest") == digest, "published tag does not resolve to the expected index digest")
        details = json.loads(command("docker", "image", "inspect", image))[0]
        require(repository + "@" + digest in (details.get("RepoDigests") or []),
                "published tag does not resolve to the expected index digest")
        image_id = details.get("Id", "")
        require(re.fullmatch(DIGEST, image_id) is not None, "missing pulled image ID")
        result["image_id"] = image_id
        result["checks"]["digest"] = True

        result["stage"] = "labels"
        require(details.get("Os", "") + "/" + details.get("Architecture", "") == platform,
                "pulled image has the wrong platform")
        labels = details.get("Config", {}).get("Labels") or {}
        require(labels.get("org.opencontainers.image.revision") == revision, "wrong image source revision")
        require(labels.get("org.opencontainers.image.version") == version, "wrong image OCI version")
        result["checks"]["labels"] = True

        result["stage"] = "smoke"
        with tempfile.TemporaryDirectory(prefix="pocketmark-qualification-") as directory:
            smoke_path = Path(directory) / "smoke.json"
            # The tag can move after inspection; execute only the already-verified local bytes.
            command(sys.executable, str(ROOT / "scripts/smoke_docker.py"), "--image", image_id,
                    "--platform", platform, "--revision", revision, "--version", version,
                    "--output", str(smoke_path), timeout=360)
            smoke = json.loads(smoke_path.read_text())
            require(smoke.get("image_id") == image_id, "smoke test used a different image")
            checks = smoke.get("checks", {})
            require(all(checks.get(name) is True for name in SMOKE_CHECKS), "incomplete smoke test evidence")
            result["smoke_checks"] = {name: True for name in SMOKE_CHECKS}
        result["checks"]["smoke"] = True

        result["stage"] = "privacy"
        require_private(repository, tag)
        result["checks"]["privacy"] = True
        result["status"] = "passed"
        result["stage"] = "complete"
    except Exception as error:
        # Child output, HTTP errors and malformed registry data may contain credentials.
        # Preserve only fixed diagnostics, never raw exception messages or subprocess output.
        result["reason"] = str(error) if isinstance(error, QualificationError) else result["stage"] + " failed"
    report_path = Path(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("image", "digest", "revision", "platform", "report"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    result = qualify(args.image, args.digest, args.revision, args.platform, args.report)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
