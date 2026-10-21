#!/usr/bin/env python3
"""Package the manually installed Chrome extension; never include local data."""
import argparse
from pathlib import Path
import zipfile

FILES = ("manifest.json", "popup.html", "popup.js", "popup.css", "README.md",
         "background.js", "common.js", "capture.js", "job-store.js")


def package(output):
    source = Path(__file__).resolve().parent
    for name in FILES:
        if (source / name).is_symlink() or not (source / name).is_file():
            raise ValueError(f"invalid production file: {name}")
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(source / name, name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New ZIP file, ready to extract and load in chrome://extensions")
    args = parser.parse_args()
    package(args.output)
    print(f"Created {args.output}. Extract it and load the folder manually in Chrome.")
