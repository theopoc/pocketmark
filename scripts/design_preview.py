"""Start or stop a disposable local Pocketmark preview for rendered design review.

    make build
    python3 scripts/design_preview.py start <empty-dir-outside-repo>
    python3 scripts/design_preview.py stop <same-dir>

`start` creates a loopback-only PostgreSQL cluster and Pocketmark server inside the
directory, bootstraps a throwaway MFA account, imports a few synthetic bookmarks and
writes `preview.json` with the URL and the session cookie to add to a disposable
browser context. Nothing is written to the repository.
"""
import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from disposable_auth import bootstrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = [
    {"url": "https://example.com/articles/calm-interfaces", "title": "Designing calm interfaces",
     "description": "Synthetic preview bookmark with tags and notes.", "notes": "Compare spacing rhythm.",
     "tags": ["design", "reading"], "favorite": True, "read": False},
    {"url": "https://example.org/guides/keyboard-focus", "title": "A practical guide to keyboard focus states",
     "description": "Synthetic preview bookmark marked as read.", "tags": ["accessibility"], "favorite": False, "read": True},
    {"url": "https://example.net/very/long/path/" + "segment/" * 12, "title": "An intentionally long bookmark title that "
     "checks truncation, wrapping and overflow in list rows, grid cards and dialogs at phone widths",
     "description": "Long metadata fixture.", "tags": ["overflow", "a-very-long-tag-name-for-wrapping"], "favorite": False, "read": False},
]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def state_file(directory):
    return os.path.join(directory, "preview.json")


def private_write(path, text):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        handle.write(text)


def save(directory, state):
    private_write(state_file(directory), json.dumps(state, indent=2))


def start(directory, binary):
    directory = os.path.abspath(directory)
    if os.path.commonpath([directory, ROOT]) == ROOT:
        sys.exit("choose a directory outside the repository")
    if os.path.exists(directory) and os.listdir(directory):
        sys.exit("choose an empty directory")
    if not os.access(binary, os.X_OK):
        sys.exit(f"{binary} is missing: run `make build` first")
    missing = [tool for tool in ("initdb", "pg_ctl", "createdb", "postgres") if not shutil.which(tool)]
    if missing:
        sys.exit("PostgreSQL 18 server binaries must be on PATH (missing: " + ", ".join(missing) +
                 "); on Debian/Ubuntu add /usr/lib/postgresql/18/bin")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    pgdata, pglog = os.path.join(directory, "pgdata"), os.path.join(directory, "postgres.log")
    pg_port, port = free_port(), free_port()
    password, pwfile = secrets.token_hex(24), os.path.join(directory, "pgpassword")
    private_write(pwfile, password + "\n")
    state = {"directory": directory, "pgdata": pgdata}
    save(directory, state)
    # macOS postmasters refuse to start without a valid LC_ALL. The password stays out of argv.
    pg = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
          "env": dict(os.environ, LC_ALL="C", PGPASSWORD=password)}
    subprocess.run(["initdb", "-A", "scram-sha-256", "-U", "pocketmark", "--pwfile", pwfile, "-E", "UTF8",
                    "--no-locale", "-D", pgdata], check=True, **pg)
    # Loopback TCP only: no Unix socket, whose path length the scratch directory may exceed.
    subprocess.run(["pg_ctl", "-D", pgdata, "-l", pglog, "-w", "-o", f"-h 127.0.0.1 -p {pg_port} -k ''", "start"],
                   check=True, **pg)
    subprocess.run(["createdb", "-h", "127.0.0.1", "-p", str(pg_port), "-U", "pocketmark", "pocketmark"],
                   check=True, **pg)

    env = {k: v for k, v in os.environ.items() if not k.startswith("POCKETMARK_")}
    env.update(POCKETMARK_DATABASE_URL=f"postgres://pocketmark:{password}@127.0.0.1:{pg_port}/pocketmark?sslmode=disable",
               POCKETMARK_SERVER_SECRET=secrets.token_hex(32))
    url = f"http://127.0.0.1:{port}"
    with open(os.path.join(directory, "server.log"), "w") as log:
        server = subprocess.Popen([os.path.abspath(binary), "-listen", f"127.0.0.1:{port}", "-no-capture",
                                   "-data", os.path.join(directory, "data")],
                                  env=env, stdout=log, stderr=log, start_new_session=True)
    state.update(server_pid=server.pid, url=url)
    save(directory, state)

    for _ in range(300):
        if server.poll() is not None:
            sys.exit(f"server exited; see {directory}/server.log")
        try:
            urllib.request.urlopen(url + "/healthz", timeout=2)
            break
        except OSError:
            time.sleep(0.1)
    else:
        sys.exit("server did not become ready")

    token, session, _ = bootstrap(url)
    payload = {"format": "pocketmark", "version": 1, "collections": [], "links": FIXTURE}
    request = urllib.request.Request(url + "/api/import", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    urllib.request.urlopen(request, timeout=30).close()
    name, _, value = session.partition("=")
    state["cookie"] = {"name": name, "value": value, "domain": "127.0.0.1", "path": "/"}
    save(directory, state)
    print(json.dumps({"url": url, "state": state_file(directory)}))


def stop(directory):
    with open(state_file(os.path.abspath(directory))) as handle:
        state = json.load(handle)
    try:
        if state.get("server_pid"):
            try:
                os.killpg(state["server_pid"], signal.SIGTERM)
            except OSError:
                pass
    finally:
        subprocess.run(["pg_ctl", "-D", state["pgdata"], "-m", "fast", "-w", "stop"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LC_ALL="C"))
    print("stopped; the directory can be deleted")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["start", "stop"])
    parser.add_argument("directory")
    parser.add_argument("--binary", default=os.path.join(ROOT, "bin", "pocketmark"))
    args = parser.parse_args()
    if args.action == "start":
        start(args.directory, args.binary)
    else:
        stop(args.directory)


if __name__ == "__main__":
    main()
