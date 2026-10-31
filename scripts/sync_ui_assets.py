"""Keep local extension assets identical to the embedded UI's canonical sources."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ("name-limit.js", "theme-switch.js")


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
    if stale:
        raise SystemExit("Shared UI assets differ: " + ", ".join(stale) + "; run python3 scripts/sync_ui_assets.py --write")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    sync(parser.parse_args().write)
