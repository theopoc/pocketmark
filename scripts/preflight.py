"""Inspect local Make and Chromium prerequisites without installing dependencies."""
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess


def output(*args, env=None):
    """Only return successful output. Tool errors can contain local configuration."""
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, env=env).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def storage(label, path, *, must_exist=False):
    directory = Path(path)
    if must_exist and not directory.is_dir():
        print(f"{label}: {path} (missing or not a directory)")
        return
    while not directory.exists() and directory != directory.parent:
        directory = directory.parent
    try:
        free = shutil.disk_usage(directory).free / (1 << 30)
    except OSError as error:
        print(f"{label}: {path} (cannot inspect storage, errno {error.errno})")
        return
    writable = directory.is_dir() and os.access(directory, os.W_OK | os.X_OK)
    status = "writable" if writable else "not writable"
    if directory != Path(path):
        status = f"missing, parent {status}"
    print(f"{label}: {path} ({free:.1f} GiB free, {status})")


def main():
    go = json.loads(output("go", "env", "-json", "GOVERSION", "CGO_ENABLED", "CC",
                           "GOCACHE", "GOMODCACHE", "GOTMPDIR",
                           env={**os.environ, "GOPROXY": "off"}) or "{}")
    print("Go:", go.get("GOVERSION", "unavailable locally"), "(required baseline in go.mod)")
    print("CGO_ENABLED:", go.get("CGO_ENABLED", "unknown"))
    compiler = shlex.split(go.get("CC", ""))
    print("C compiler:", (shutil.which(compiler[0]) if compiler else None) or "unavailable")
    for key in ("GOCACHE", "GOMODCACHE"):
        if go.get(key):
            storage(key, go[key])
    storage("Go temporary directory", go.get("GOTMPDIR") or os.environ.get("TMPDIR") or "/tmp", must_exist=True)
    print("Node:", output("node", "--version") or "unavailable", "(CI uses 24)")
    print("npm:", output("npm", "--version") or "unavailable")
    for project in ("frontend", "e2e"):
        installed = output("npm", "ls", "--offline", "--logs-max=0", "--depth=0", "--prefix", project)
        print(f"{project} npm dependencies:", "installed" if installed else "unavailable or incomplete")

    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
        print("Loopback listener: available")
    except OSError as error:
        print(f"Loopback listener: unavailable (errno {error.errno})")

    override = os.environ.get("E2E_CHROMIUM_EXECUTABLE")
    if override:
        executable = Path(override)
        usable = executable.is_file() and os.access(executable, os.X_OK)
        print("E2E_CHROMIUM_EXECUTABLE:", "executable" if usable else "missing or not executable")

    # Ask the locked CLI which browser build this machine needs, including cache overrides.
    plan = output("e2e/node_modules/.bin/playwright", "install", "--dry-run", "chromium")
    locations = [line.partition(":")[2].strip() for line in plan.splitlines()
                 if line.strip().startswith("Install location:")]
    if not locations:
        print("Playwright browser inventory: unavailable")
    for location in locations:
        installed = (Path(location) / "INSTALLATION_COMPLETE").is_file()
        print(f"{Path(location).name}: {'installed' if installed else 'missing'}")


if __name__ == "__main__":
    main()
