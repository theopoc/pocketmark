#!/usr/bin/env python3
"""Validate GoReleaser outputs and copy only the approved publication assets."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import zipfile

ARCHES = {"amd64": 62, "arm64": 183}
EXTENSION_FILES = {"theme-switch.js", "ui-theme.js", "name-limit.js", "manifest.json", "popup.html", "popup.js", "popup.css", "selectors.js", "README.md", "background.js", "common.js", "capture.js", "job-store.js"}
ASSETS = {f"pocketmark-linux-{arch}{suffix}" for arch in ARCHES for suffix in (".tar.gz", ".buildinfo.txt")}
ASSETS |= {"pocketmark-extension.zip"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_release_state(pages, tag, commit):
    """Only create a missing release or finish the empty draft at this revision."""
    require(isinstance(pages, list) and bool(pages)
            and all(isinstance(page, list) and all(isinstance(item, dict) for item in page) for page in pages),
            "expected a complete paginated release listing")
    matches = [release for page in pages for release in page if release.get("tag_name") == tag]
    require(len(matches) <= 1, "ambiguous release state")
    if not matches:
        return
    release = matches[0]
    require(release.get("tag_name") == tag and release.get("draft") is True
            and release.get("prerelease") is False
            and release.get("target_commitish") == commit
            and release.get("assets") == [],
            "expected a missing release or an empty stable draft at the verified revision; "
            "refusing to overwrite an existing release")


def regular(path):
    require(not path.is_symlink() and path.is_file() and path.stat().st_size > 0, f"invalid release file: {path}")
    return path


def digest(path):
    result = hashlib.sha256()
    with regular(path).open("rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            result.update(block)
    return result.hexdigest()


def verify(directory, commit, metadata=None, output=None):
    def locate(name):
        if metadata and name.endswith(".buildinfo.txt"):
            arch = name.removeprefix("pocketmark-linux-").removesuffix(".buildinfo.txt")
            return regular(metadata / f"linux-{arch}" / name)
        return regular(directory / name)

    manifest = regular(directory / "SHA256SUMS")
    entries = {}
    for line in manifest.read_text().splitlines():
        expected, name = line.split("  ", 1)
        require(name in ASSETS and name not in entries, f"unexpected/duplicate checksum entry: {name}")
        entries[name] = expected
    require(set(entries) == ASSETS, "incomplete checksum manifest")
    for name, expected in entries.items():
        require(digest(locate(name)) == expected, f"checksum mismatch: {name}")
    for arch, machine in ARCHES.items():
        with tarfile.open(locate(f"pocketmark-linux-{arch}.tar.gz")) as archive:
            members = archive.getmembers()
            require(len(members) == 2 and {x.name for x in members} == {"pocketmark", "README.md"}
                    and all(x.isfile() for x in members), f"unexpected native archive contents: {arch}")
            require(archive.getmember("pocketmark").mode == 0o755, f"missing executable mode: {arch}")
            with archive.extractfile("pocketmark") as binary:
                header = binary.read(20)
            require(header[:6] == b"\x7fELF\x02\x01" and int.from_bytes(header[18:20], "little") == machine,
                    f"wrong ELF architecture: {arch}")
        info = locate(f"pocketmark-linux-{arch}.buildinfo.txt").read_text()
        require(f"vcs.revision={commit}" in info and "vcs.modified=false" in info,
                f"binary was not built from the verified clean commit: {arch}")
    with zipfile.ZipFile(locate("pocketmark-extension.zip")) as archive:
        names = archive.namelist()
        require(len(names) == len(EXTENSION_FILES) and set(names) == EXTENSION_FILES and archive.testzip() is None,
                "unexpected extension archive contents")
        configuration = json.loads(archive.read("manifest.json"))
        require(set(configuration["permissions"]) == {"activeTab", "scripting", "storage", "debugger"}, "extension permission mismatch")
        require(configuration.get("background") == {"service_worker": "background.js"}, "missing capture worker")
    if output:
        output.mkdir(parents=True, exist_ok=False)
        for name in sorted(ASSETS):
            shutil.copyfile(locate(name), output / name)
        shutil.copyfile(manifest, output / "SHA256SUMS")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    verify(args.directory, args.commit, args.metadata, args.output)
    print("Verified checksums, archive allowlists, native architecture, source revision and extension permissions.")


if __name__ == "__main__":
    main()
