#!/usr/bin/env python3
"""Package allowlisted release files; no runtime data or build-directory globbing."""
import argparse
import gzip
import json
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXTENSION_FILES = ("manifest.json", "popup.html", "popup.js", "popup.css", "README.md")


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"expected a regular release input: {path}")
    return path.read_bytes()


def extensions(output):
    original = {name: regular(ROOT / "extension" / name) for name in EXTENSION_FILES}
    for advanced in (False, True):
        files = dict(original)
        manifest = json.loads(files["manifest.json"])
        if advanced:
            manifest["name"] = "Pocketmark — Advanced capture"
            manifest["minimum_chrome_version"] = "120"
            manifest["permissions"].append("debugger")
        files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
        suffix = "-advanced" if advanced else ""
        with zipfile.ZipFile(output / f"pocketmark-extension{suffix}.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(files.items()):
                entry = zipfile.ZipInfo(name)
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED)


def linux(output, arch, binary):
    executable = regular(binary)
    machine = {"amd64": 62, "arm64": 183}[arch]
    if (executable[:6] != b"\x7fELF\x02\x01" or len(executable) < 20
            or int.from_bytes(executable[18:20], "little") != machine):
        raise ValueError(f"expected a Linux ELF64 {arch} executable")
    files = {"pocketmark": (executable, 0o755),
             "README.md": (regular(ROOT / "docs" / "RELEASE_INSTALL.md"), 0o644)}
    destination = output / f"pocketmark-linux-{arch}.tar.gz"
    import io
    with destination.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for name, (content, mode) in sorted(files.items()):
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode, entry.mtime = len(content), mode, 0
                archive.addfile(entry, io.BytesIO(content))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("linux", "extensions"))
    parser.add_argument("--arch", choices=("amd64", "arm64"))
    parser.add_argument("--binary", type=Path, default=ROOT / "bin" / "pocketmark")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if args.kind == "linux" and not args.arch:
        parser.error("linux packages require --arch")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.kind == "extensions":
        extensions(args.output)
    else:
        linux(args.output, args.arch, args.binary)


if __name__ == "__main__":
    main()
