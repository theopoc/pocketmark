"""Allocate one database per native browser test or benchmark."""
from contextlib import contextmanager
import os
import secrets
import subprocess
from urllib.parse import urlsplit, unquote, parse_qsl, urlencode


@contextmanager
def disposable_database():
    cluster = os.environ.get("POCKETMARK_TEST_DATABASE_URL", "")
    parts = urlsplit(cluster)
    if parts.scheme not in ("postgres", "postgresql"):
        raise ValueError("Set POCKETMARK_TEST_DATABASE_URL to a disposable cluster with CREATEDB")
    name = "pocketmark_test_" + secrets.token_hex(12)
    # Keep a URI with private credentials out of the process argument list.
    env = os.environ.copy()
    if parts.username is not None:
        env["PGUSER"] = unquote(parts.username)
    if parts.password is not None:
        env["PGPASSWORD"] = unquote(parts.password)
    query = dict(parse_qsl(parts.query))
    if "password" in query:
        env["PGPASSWORD"] = query.pop("password")
    admin_uri = parts.scheme + "://" + parts.netloc.rsplit("@", 1)[-1] + parts.path
    if query:
        admin_uri += "?" + urlencode(query)

    def admin(sql):
        subprocess.run(["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-d", admin_uri],
                       input=sql + ";\n", text=True, env=env, check=True, stdout=subprocess.DEVNULL)

    admin("CREATE DATABASE " + name + " TEMPLATE template0")
    try:
        yield parts.scheme + "://" + parts.netloc + "/" + name + ("?" + parts.query if parts.query else "")
    finally:
        admin("DROP DATABASE " + name + " WITH (FORCE)")
