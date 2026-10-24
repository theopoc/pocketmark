"""Fail closed on mutable version tags, incomplete indexes and registry errors."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("container_release", Path(__file__).with_name("container_release.py"))
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
REVISION = "a" * 40
EXPECTED = {"amd64": "sha256:" + "b" * 64, "arm64": "sha256:" + "c" * 64}
INDEX = {"schemaVersion": 2, "digest": "sha256:" + "d" * 64,
         "manifests": [{"platform": {"architecture": arch, "os": "linux"}, "digest": digest}
                       for arch, digest in EXPECTED.items()]}


class ContainerReleaseTests(unittest.TestCase):
    def test_prepare_requires_validated_main_run(self):
        release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False, "published_at": "synthetic"}
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/pocketmark"}), \
                patch.object(RELEASE, "run", side_effect=[json.dumps(release), REVISION, ""]), \
                patch.object(RELEASE, "wait", return_value=123) as wait, patch.object(RELEASE, "output") as emit:
            RELEASE.prepare("v0.1.0")
            wait.assert_called_once_with(REVISION)
            emit.assert_called_once_with(tag="v0.1.0", revision=REVISION,
                                         image="ghcr.io/example/pocketmark")

    def test_only_published_stable_releases_can_start_docker(self):
        release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False, "published_at": "synthetic"}
        for changes in ({"draft": True}, {"prerelease": True}, {"published_at": None}, {"tag_name": "v0.2.0"}):
            with self.subTest(changes=changes), \
                    patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/pocketmark"}), \
                    patch.object(RELEASE, "run", return_value=json.dumps(release | changes)), \
                    patch.object(RELEASE, "wait") as wait, patch.object(RELEASE, "output") as emit:
                with self.assertRaises(ValueError):
                    RELEASE.prepare("v0.1.0")
                wait.assert_not_called()
                emit.assert_not_called()

    def test_unsuccessful_main_ci_blocks_image_preparation(self):
        release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False, "published_at": "synthetic"}
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/pocketmark"}), \
                patch.object(RELEASE, "run", side_effect=[json.dumps(release), REVISION, ""]), \
                patch.object(RELEASE, "wait", side_effect=ValueError("Main CI did not succeed")), \
                patch.object(RELEASE, "output") as emit:
            with self.assertRaises(ValueError):
                RELEASE.prepare("v0.1.0")
            emit.assert_not_called()

    def test_only_stable_safe_tags_are_accepted(self):
        self.assertEqual(RELEASE.tag_name("v0.1.0"), "v0.1.0")
        for tag in ("main", "sha-" + REVISION, "v01.2.3", "v1.0.0-rc1", "v1.2.3\nINJECT=value", "../main"):
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

if __name__ == "__main__":
    unittest.main()
