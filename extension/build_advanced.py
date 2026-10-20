#!/usr/bin/env python3
"""Build an explicitly opted-in Chromium debugger variant. Does not install it."""
import argparse
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="Output directory (must be new unless --reuse is set)")
parser.add_argument("--reuse", action="store_true", help="Refresh the five production files in an existing packaging directory")
args = parser.parse_args()
source = Path(__file__).resolve().parent
names = ("popup.html", "popup.js", "popup.css", "README.md", "manifest.json")
if args.output.is_symlink() or any((args.output / name).is_symlink() for name in names):
    parser.error("output directory and production files must not be symlinks")
args.output.mkdir(parents=True, exist_ok=args.reuse)
for name in ("popup.html", "popup.js", "popup.css", "README.md"):
    shutil.copy2(source / name, args.output / name)
manifest = json.loads((source / "manifest.json").read_text())
manifest["name"] = "Pocketmark — Advanced capture"
manifest["minimum_chrome_version"] = "120"
manifest["permissions"].append("debugger")
(args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Built {args.output}. Load this directory manually only if you accept debugger access.")
