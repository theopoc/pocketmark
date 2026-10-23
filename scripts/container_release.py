#!/usr/bin/env python3
"""Validate release provenance and publish an index of exactly two tested images."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ARCHES = {"amd64", "arm64"}
DIGEST = r"sha256:[0-9a-f]{64}"
REVISION = r"[0-9a-f]{40}"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tag_name(tag):
    require(re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag),
            "expected a stable vMAJOR.MINOR.PATCH tag")
    return tag


def run(*args):
    return subprocess.check_output(args, text=True, timeout=120).strip()


def output(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as target:
        for key, value in values.items():
            require("\n" not in value and "\r" not in value, "invalid workflow output")
            target.write(f"{key}={value}\n")


def prepare(tag):
    tag_name(tag)
    repo = os.environ["GITHUB_REPOSITORY"]
    release = json.loads(run("gh", "api", f"repos/{repo}/releases/tags/{tag}"))
    require(release["tag_name"] == tag and not release["draft"] and not release["prerelease"]
            and release["published_at"], "a published stable GitHub release is required")
    revision = run("git", "rev-parse", f"refs/tags/{tag}^{{}}")
    require(re.fullmatch(REVISION, revision), "invalid source revision")
    run("git", "merge-base", "--is-ancestor", revision, "origin/main")
    checks = json.loads(run("gh", "api", "--method", "GET", f"repos/{repo}/commits/{revision}/check-runs",
                            "-f", "per_page=100"))
    # A recovery workflow checks out the tag but its checks belong to the workflow ref.
    # The ordinary main CI calls the same complete suite on the tagged revision.
    require(any(check["name"] in ("CI passed", "Verify release source / CI passed")
                and check["conclusion"] == "success" and check["app"]["slug"] == "github-actions"
                for check in checks["check_runs"]), "the release commit must have passed the complete CI")
    output(tag=tag, revision=revision, image="ghcr.io/" + repo.lower())


def validate_index(index, expected):
    require(index.get("schemaVersion") == 2, "unexpected manifest schema")
    require(re.fullmatch(DIGEST, index.get("digest", "")), "missing index digest")
    members = index.get("manifests", [])
    actual = {}
    for member in members:
        platform = member.get("platform", {})
        arch = platform.get("architecture")
        require(platform.get("os") == "linux" and arch in ARCHES and arch not in actual,
                "unexpected or duplicate image platform")
        require(re.fullmatch(DIGEST, member.get("digest", "")), "invalid platform digest")
        actual[arch] = member["digest"]
    require(actual == expected and set(actual) == ARCHES, "index does not contain exactly the tested platform digests")


def inspect(reference, missing_ok=False):
    result = subprocess.run(["docker", "buildx", "imagetools", "inspect", reference,
                             "--format", "{{json .Manifest}}"], capture_output=True, text=True, timeout=120)
    if result.returncode:
        error = result.stderr.lower()
        missing = any(x in error for x in ("manifest unknown", "not found", "404"))
        denied = any(x in error for x in ("unauthorized", "denied", "forbidden", "failed to authorize"))
        if missing_ok and missing and not denied:
            return None
        raise RuntimeError(result.stderr.strip() or "cannot inspect the registry manifest")
    return json.loads(result.stdout)


def publish(image, tag, revision, directory, report):
    tag_name(tag)
    require(re.fullmatch(REVISION, revision), "invalid source revision")
    require(re.fullmatch(r"ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+", image), "invalid registry image")
    expected = {}
    require({p.name for p in directory.iterdir()} == {f"{arch}.json" for arch in ARCHES}, "unexpected digest files")
    for arch in sorted(ARCHES):
        record = json.loads((directory / f"{arch}.json").read_text())
        require(record["arch"] == arch and record["revision"] == revision
                and re.fullmatch(DIGEST, record["digest"]), "invalid tested-image record")
        expected[arch] = record["digest"]
    reference = image + ":" + tag
    existing = inspect(reference, missing_ok=True)
    if existing:
        # Idempotent for the same digests; never replace another version's bytes.
        validate_index(existing, expected)
    else:
        run("docker", "buildx", "imagetools", "create", "--tag", reference,
            "--annotation", f"index:org.opencontainers.image.version={tag}",
            "--annotation", f"index:org.opencontainers.image.revision={revision}",
            *[f"{image}@{expected[arch]}" for arch in sorted(ARCHES)])
    index = inspect(reference)
    validate_index(index, expected)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"image": reference, "revision": revision, "digest": index["digest"],
                                  "platforms": expected}, indent=2) + "\n")
    output(digest=index["digest"])
    print(report.read_text())


def private(image, tag):
    tag_name(tag)
    require(re.fullmatch(r"ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+", image), "invalid registry image")
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
        print("Anonymous pull is denied for the authenticated, successfully pulled release image.")
        return
    raise ValueError("release image is anonymously readable; expected a private package")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preparation = commands.add_parser("prepare")
    preparation.add_argument("--tag", required=True)
    record = commands.add_parser("record")
    record.add_argument("--arch", choices=sorted(ARCHES), required=True)
    record.add_argument("--digest", required=True)
    record.add_argument("--revision", required=True)
    record.add_argument("--output", type=Path, required=True)
    publication = commands.add_parser("publish")
    for name in ("image", "tag", "revision"):
        publication.add_argument("--" + name, required=True)
    publication.add_argument("--directory", type=Path, required=True)
    publication.add_argument("--report", type=Path, required=True)
    privacy = commands.add_parser("private")
    privacy.add_argument("--image", required=True)
    privacy.add_argument("--tag", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.tag)
    elif args.command == "private":
        private(args.image, args.tag)
    elif args.command == "record":
        require(re.fullmatch(DIGEST, args.digest) and re.fullmatch(REVISION, args.revision), "invalid image provenance")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"arch": args.arch, "digest": args.digest, "revision": args.revision}) + "\n")
    else:
        publish(args.image, args.tag, args.revision, args.directory, args.report)


if __name__ == "__main__":
    main()
