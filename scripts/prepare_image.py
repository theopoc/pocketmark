#!/usr/bin/env python3
"""Stage a minimal image context from the exact validated CI executable."""
import argparse
from pathlib import Path
import re
import shutil
import struct
import subprocess

ARCHES = {'amd64': 62, 'arm64': 183}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_elf(binary, arch):
    with binary.open('rb') as source:
        header = source.read(64)
        require(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01', 'expected a 64-bit little-endian ELF')
        require(int.from_bytes(header[18:20], 'little') == ARCHES[arch], 'wrong executable architecture')
        offset = int.from_bytes(header[32:40], 'little')
        size, count = struct.unpack_from('<HH', header, 54)
        require(size == 56 and 0 < count < 1024 and offset + count * size <= binary.stat().st_size,
                'invalid ELF program headers')
        source.seek(offset)
        for _ in range(count):
            kind = int.from_bytes(source.read(size)[:4], 'little')
            require(kind != 3, 'release executable must be static (no ELF interpreter)')


def prepare(directory, arch, revision, output, dockerfile):
    require(re.fullmatch('[0-9a-f]{40}', revision), 'invalid source revision')
    binary = directory / 'pocketmark'
    metadata = directory / f'pocketmark-linux-{arch}.buildinfo.txt'
    require({p.name for p in directory.iterdir()} == {binary.name, metadata.name}, 'unexpected artifact files')
    require(all(p.is_file() and not p.is_symlink() for p in (binary, metadata)), 'expected regular artifact files')
    validate_elf(binary, arch)
    # Verify metadata from the executable itself, not only its accompanying text.
    info = subprocess.check_output(['go', 'version', '-m', str(binary)], text=True, timeout=30)
    require(info.splitlines()[1:] == metadata.read_text().splitlines()[1:], 'build metadata does not match executable')
    settings = {}
    for line in info.splitlines():
        if line.startswith('\tbuild\t'):
            key, _, value = line.removeprefix('\tbuild\t').partition('=')
            settings[key] = value
    for key, value in {'vcs.revision': revision, 'vcs.modified': 'false', 'GOOS': 'linux',
                       'GOARCH': arch, 'CGO_ENABLED': '1'}.items():
        require(settings.get(key) == value, f'unexpected build setting: {key}')
    require(set(settings.get('-tags', '').strip('"').split(',')) ==
            {'sqlite_fts5', 'sqlite_omit_load_extension'}, 'missing SQLite build tags')
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(binary, output / 'pocketmark')
    (output / 'pocketmark').chmod(0o755)
    shutil.copyfile(dockerfile, output / 'Dockerfile')
    print(f'Staged verified {arch} executable from {revision}; no rebuild.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--arch', choices=ARCHES, required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dockerfile', type=Path, default=Path('Dockerfile.release'))
    args = parser.parse_args()
    prepare(args.directory, args.arch, args.revision, args.output, args.dockerfile)


if __name__ == '__main__':
    main()
