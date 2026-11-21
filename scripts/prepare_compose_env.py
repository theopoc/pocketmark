"""Create first-run credentials for the local Compose stack."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile


def main():
    if Path(".env").exists() or os.environ.get("POCKETMARK_DB_PASSWORD") or os.environ.get("COMPOSE_ENV_FILES"):
        return

    # Supply a placeholder only while resolving the configured volume name.
    config = subprocess.check_output(
        ["docker", "compose", "config", "--format", "json"],
        env={**os.environ, "POCKETMARK_DB_PASSWORD": "unused-for-config"},
    )
    database_volume = json.loads(config)["volumes"]["pocketmark-postgres"]["name"]
    volumes = subprocess.check_output(
        ["docker", "volume", "ls", "--filter", f"name={database_volume}", "--format", "{{.Name}}"],
        text=True,
    )
    if database_volume in volumes.splitlines():
        raise SystemExit("PostgreSQL volume already exists. Restore the original POCKETMARK_DB_PASSWORD in .env or your shell.")

    # Link the completed, owner-only file without replacing a concurrent writer.
    with tempfile.NamedTemporaryFile(mode="w", dir=".", prefix=".env.") as private:
        private.write(f"POCKETMARK_DB_PASSWORD={secrets.token_hex(32)}\n")
        private.flush()
        try:
            os.link(private.name, ".env")
        except FileExistsError:
            pass


if __name__ == "__main__":
    main()
