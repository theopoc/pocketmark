"""Bootstrap credentials only on a disposable Pocketmark test instance."""
import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
import urllib.request


def bootstrap(base):
    password = secrets.token_hex(24)

    def post(path, data, cookie=None):
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        req = urllib.request.Request(base + path, data=json.dumps(data).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response), response.headers.get("Set-Cookie", "").split(";", 1)[0]

    _, pending = post("/api/setup", {"username": "disposable-test", "password": password})
    enrollment, _ = post("/api/mfa/enroll", {}, pending)
    secret = base64.b32decode(enrollment["secret"] + "=" * (-len(enrollment["secret"]) % 8))
    digest = hmac.new(secret, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    code = str((int.from_bytes(digest[offset:offset+4], "big") & 0x7fffffff) % 1000000).zfill(6)
    _, session = post("/api/mfa/verify", {"code": code}, pending)
    api_key, _ = post("/api/tokens", {"name": "disposable-test", "profile": "full"}, session)
    return api_key["token"], session, password
