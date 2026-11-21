"""Sync extension assets with the embedded UI. Rendering updated PNGs requires rsvg-convert."""
import argparse
import hashlib
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FILES = ("name-limit.js", "theme-switch.js", "icon.svg")
ICON_SIZES = (16, 24, 32, 48, 128)


def sync_chrome_icons(write):
    source = ROOT / "internal/webui/static/icon.svg"
    extension = ROOT / "extension"
    icons = [extension / f"icon-{size}.png" for size in ICON_SIZES]
    checksums = extension / "icons.sha256"

    def hashes():
        return "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                       for path in [source, *icons])

    if all(path.is_file() for path in icons) and checksums.is_file() and checksums.read_text() == hashes():
        return True
    if not write:
        return False
    for size, icon in zip(ICON_SIZES, icons):
        try:
            subprocess.run(["rsvg-convert", "--width", str(size), "--height", str(size),
                            "--output", str(icon), str(source)], check=True)
        except FileNotFoundError:
            raise SystemExit("Install librsvg (rsvg-convert) to regenerate Chrome PNG icons.") from None
    checksums.write_text(hashes())
    return True


def sync(write=False):
    stale = []
    for name in FILES:
        source = (ROOT / "internal/webui/static" / name).read_bytes()
        target = ROOT / "extension" / name
        if not target.exists() or target.read_bytes() != source:
            if write:
                target.write_bytes(source)
            else:
                stale.append(name)
    if not sync_chrome_icons(write):
        stale.append("Chrome PNG icons")
    if stale:
        raise SystemExit("Shared UI assets differ: " + ", ".join(stale) + "; run python3 scripts/sync_ui_assets.py --write")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    sync(parser.parse_args().write)
