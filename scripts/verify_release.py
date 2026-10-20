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
EXTENSION_FILES = {"manifest.json", "popup.html", "popup.js", "popup.css", "README.md"}
ASSETS = {f"pocketmark-linux-{arch}{suffix}" for arch in ARCHES for suffix in (".tar.gz", ".buildinfo.txt")}
ASSETS |= {"pocketmark-extension.zip", "pocketmark-extension-advanced.zip"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


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
    for advanced in (False, True):
        suffix = "-advanced" if advanced else ""
        with zipfile.ZipFile(locate(f"pocketmark-extension{suffix}.zip")) as archive:
            names = archive.namelist()
            require(len(names) == 5 and set(names) == EXTENSION_FILES and archive.testzip() is None,
                    "unexpected extension archive contents")
            configuration = json.loads(archive.read("manifest.json"))
            require(("debugger" in configuration["permissions"]) == advanced, "extension permission mismatch")
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
