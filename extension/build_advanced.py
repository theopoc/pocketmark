#!/usr/bin/env python3
"""Build an explicitly opted-in Chromium debugger variant. Does not install it."""
import argparse
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="New output directory (must not exist)")
args = parser.parse_args()
source = Path(__file__).resolve().parent
args.output.mkdir(parents=True, exist_ok=False)
for name in ("popup.html", "popup.js", "popup.css", "README.md"):
    shutil.copy2(source / name, args.output / name)
manifest = json.loads((source / "manifest.json").read_text())
manifest["name"] = "Pocketmark — Advanced capture"
manifest["minimum_chrome_version"] = "120"
manifest["permissions"].append("debugger")
(args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Built {args.output}. Load this directory manually only if you accept debugger access.")
