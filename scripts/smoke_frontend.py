"""Exercise the compiled frontend with a disposable native server and Chromium."""
import argparse
import contextlib
import os
import secrets
import select
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from disposable_postgres import disposable_database


@contextlib.contextmanager
def fake_s3(directory):
    """Run tools/go/fakes3: an in-memory S3 endpoint for the backup journey."""
    tool = Path(directory) / "fakes3"
    subprocess.run(["go", "-C", "tools/go", "build", "-o", str(tool), "./fakes3"], check=True, timeout=300)
    access_key = "E2E" + secrets.token_hex(8).upper()
    process = subprocess.Popen([str(tool), "-bucket", "pocketmark-e2e", "-access-key", access_key],
                               stdout=subprocess.PIPE, text=True)
    try:
        ready, _, _ = select.select([process.stdout], [], [], 30)
        endpoint = process.stdout.readline().strip() if ready else ""
        if not endpoint.startswith("http://127.0.0.1:"):
            raise RuntimeError("fake S3 server did not start")
        yield {"E2E_S3_ENDPOINT": endpoint, "E2E_S3_BUCKET": "pocketmark-e2e", "E2E_S3_ACCESS_KEY": access_key}
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def smoke(binary):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    # Never inherit a personal instance's configuration or credentials.
    env = {key: value for key, value in os.environ.items() if not key.startswith("POCKETMARK_")}
    env.update(POCKETMARK_RATE_LIMIT="1000", POCKETMARK_RATE_BURST="10000")
    with disposable_database() as database, tempfile.TemporaryDirectory(prefix="pocketmark-react-") as directory, \
            tempfile.TemporaryDirectory(prefix="pocketmark-s3-") as tools, fake_s3(tools) as s3:
        env["POCKETMARK_DATABASE_URL"] = database
        with tempfile.TemporaryFile() as log:
            server = subprocess.Popen([str(binary), "-data", directory, "-listen", f"127.0.0.1:{port}", "-no-capture"], env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError("Disposable frontend server exited before becoming ready")
                    try:
                        with urllib.request.urlopen(base + "/healthz", timeout=1):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("Disposable frontend server did not become ready")
                subprocess.run(["node", "e2e/browser.mjs"], env={**env, **s3, "E2E_BASE_URL": base, "E2E_DATABASE_URL": env["POCKETMARK_DATABASE_URL"]}, check=True, timeout=300)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("bin/pocketmark"))
    args = parser.parse_args()
    smoke(args.binary.resolve())
