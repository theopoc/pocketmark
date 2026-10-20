"""Fail closed on mutable version tags, incomplete indexes and registry errors."""
import copy
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SPEC = importlib.util.spec_from_file_location("container_release", Path(__file__).with_name("container_release.py"))
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
REVISION = "a" * 40
EXPECTED = {"amd64": "sha256:" + "b" * 64, "arm64": "sha256:" + "c" * 64}
INDEX = {"schemaVersion": 2, "digest": "sha256:" + "d" * 64,
         "manifests": [{"platform": {"architecture": arch, "os": "linux"}, "digest": digest}
                       for arch, digest in EXPECTED.items()]}


class ContainerReleaseTests(unittest.TestCase):
    def test_only_stable_safe_tags_are_accepted(self):
        self.assertEqual(RELEASE.tag_name("v0.1.0"), "v0.1.0")
        for tag in ("main", "v01.2.3", "v1.0.0-rc1", "v1.2.3\nINJECT=value", "../main"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                RELEASE.tag_name(tag)

    def test_index_requires_exactly_both_tested_digests(self):
        RELEASE.validate_index(INDEX, EXPECTED)
        bad = []
        missing = copy.deepcopy(INDEX)
        missing["manifests"].pop()
        bad.append(missing)
        duplicate = copy.deepcopy(INDEX)
        duplicate["manifests"][1] = duplicate["manifests"][0]
        bad.append(duplicate)
        changed = copy.deepcopy(INDEX)
        changed["manifests"][0]["digest"] = "sha256:" + "e" * 64
        bad.append(changed)
        wrong_os = copy.deepcopy(INDEX)
        wrong_os["manifests"][0]["platform"]["os"] = "windows"
        bad.append(wrong_os)
        for index in bad:
            with self.subTest(index=index), self.assertRaises(ValueError):
                RELEASE.validate_index(index, EXPECTED)

    def test_only_a_real_missing_manifest_allows_creation(self):
        for error, missing in (("manifest unknown", True), ("not found", True),
                               ("failed to authorize: 404 not found", False),
                               ("unauthorized", False), ("TLS handshake timeout", False)):
            result = subprocess.CompletedProcess([], 1, "", error)
            with self.subTest(error=error), patch.object(RELEASE.subprocess, "run", return_value=result):
                if missing:
                    self.assertIsNone(RELEASE.inspect("synthetic", missing_ok=True))
                else:
                    with self.assertRaises(RuntimeError):
                        RELEASE.inspect("synthetic", missing_ok=True)

    def test_existing_version_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = root / "digests"
            records.mkdir()
            for arch, digest in EXPECTED.items():
                (records / f"{arch}.json").write_text(json.dumps({"arch": arch, "digest": digest, "revision": REVISION}))
            wrong = copy.deepcopy(INDEX)
            wrong["manifests"][0]["digest"] = "sha256:" + "e" * 64
            with patch.object(RELEASE, "inspect", return_value=wrong), patch.object(RELEASE, "run") as execute:
                with self.assertRaises(ValueError):
                    RELEASE.publish("ghcr.io/example/pocketmark", "v0.1.0", REVISION, records, root / "report.json")
                execute.assert_not_called()
            with patch.object(RELEASE, "inspect", return_value=INDEX), patch.object(RELEASE, "run") as execute, \
                    patch.dict(os.environ, {"GITHUB_OUTPUT": str(root / "output")}):
                RELEASE.publish("ghcr.io/example/pocketmark", "v0.1.0", REVISION, records, root / "report.json")
                execute.assert_not_called()
                self.assertEqual(json.loads((root / "report.json").read_text())["platforms"], EXPECTED)

    def test_anonymous_access_is_denied_and_network_errors_fail_closed(self):
        for status in (401, 403, 404, 500):
            failure = urllib.error.HTTPError("https://ghcr.io/token", status, "synthetic", {}, None)
            with self.subTest(status=status), patch.object(RELEASE.urllib.request, "urlopen", side_effect=failure):
                if status == 500:
                    with self.assertRaises(ValueError):
                        RELEASE.private("ghcr.io/example/pocketmark", "v0.1.0")
                else:
                    RELEASE.private("ghcr.io/example/pocketmark", "v0.1.0")
        with patch.object(RELEASE.urllib.request, "urlopen",
                          side_effect=[io.BytesIO(b'{"token":"synthetic-anonymous-token"}'), io.BytesIO(b'{}')]):
            with self.assertRaises(ValueError):
                RELEASE.private("ghcr.io/example/pocketmark", "v0.1.0")


if __name__ == "__main__":
    unittest.main()
