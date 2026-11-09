#!/usr/bin/env python3
"""Qualify a published GHCR image and retain a sanitized result, including failures."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DIGEST = r"sha256:[0-9a-f]{64}"
REVISION = r"[0-9a-f]{40}"
VERSION = r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
IMAGE = rf"(ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+):({VERSION})"


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


def health(image_id, platform):
    """Exercise the image's own HEALTHCHECK without repeating candidate journeys."""
    container = command('docker', 'run', '--detach', '--pull=never', '--network=none',
                        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                        '--memory=128m', '--cpus=1', '--pids-limit=64',
                        '--tmpfs=/data:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700',
                        '--health-interval=1s', '--health-timeout=2s', '--health-start-period=2s',
                        '--health-retries=30', '--platform', platform, image_id).strip()
    require(re.fullmatch('[0-9a-f]{64}', container), 'missing qualification container ID')
    try:
        deadline = time.monotonic() + 45
        while True:
            state = json.loads(command('docker', 'inspect', container, '--format', '{{json .State}}'))
            require(state.get('Running') is True, 'qualification container stopped')
            status = state.get('Health', {}).get('Status')
            require(status in ('starting', 'healthy'), 'qualification healthcheck failed or missing')
            if status == 'healthy':
                return
            require(time.monotonic() < deadline, 'qualification healthcheck timed out')
            time.sleep(0.5)
    finally:
        command('docker', 'rm', '--force', '--volumes', container)


def qualify(image, digest, revision, platform, report_path, check_privacy=True):
    result = {"schema_version": 2, "status": "failed", "stage": "input", "checks": {}}
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

        result["stage"] = "health"
        # Execute only the local bytes whose digest, architecture and labels matched.
        health(image_id, platform)
        result["checks"]["health"] = True

        if check_privacy:
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
    parser.add_argument('--skip-privacy', action='store_true',
                        help='The workflow already checked privacy once for the whole index')
    args = parser.parse_args()
    result = qualify(args.image, args.digest, args.revision, args.platform, args.report,
                     check_privacy=not args.skip_privacy)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
