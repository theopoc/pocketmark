"""Exercise published-image qualification through its result and report interface."""
import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import qualify_image as QUALIFY

REVISION = "a" * 40
DIGEST = "sha256:" + "b" * 64
IMAGE_ID = "sha256:" + "c" * 64
REPOSITORY = "ghcr.io/example/pocketmark"
DETAILS = {"Id": IMAGE_ID, "RepoDigests": [REPOSITORY + "@" + DIGEST], "Os": "linux", "Architecture": "arm64",
           "Config": {"Labels": {"org.opencontainers.image.revision": REVISION,
                                 "org.opencontainers.image.version": "sha-" + REVISION}}}


class QualificationTests(unittest.TestCase):
    def run_qualification(self, tag="v1.2.3", details=None, failure=None, privacy_failure=None,
                          smoke_changes=None, registry_digest=DIGEST, **overrides):
        calls = []
        details = copy.deepcopy(DETAILS if details is None else details)

        def execute(*args, **kwargs):
            calls.append(args)
            kind = "pull" if args[:2] == ("docker", "pull") else "digest" if args[0] == "docker" else "smoke"
            if failure and kind == failure:
                raise subprocess.CalledProcessError(1, args, output="secret-output", stderr="secret-token")
            if kind == "digest":
                if args[:3] == ("docker", "buildx", "imagetools"):
                    return json.dumps({"digest": registry_digest})
                return json.dumps([details])
            if kind == "smoke":
                self.assertEqual(args[args.index("--image") + 1], IMAGE_ID)
                self.assertEqual(args[args.index("--version") + 1], "sha-" + REVISION)
                smoke = {"image_id": IMAGE_ID, "checks": {name: True for name in QUALIFY.SMOKE_CHECKS}}
                smoke.update(smoke_changes or {})
                Path(args[args.index("--output") + 1]).write_text(json.dumps(smoke))
            return ""

        with tempfile.TemporaryDirectory() as directory, patch.object(QUALIFY, "command", side_effect=execute), \
                patch.object(QUALIFY, "require_private", side_effect=privacy_failure) as privacy:
            path = Path(directory) / "nested/report.json"
            inputs = {"image": REPOSITORY + ":" + tag, "digest": DIGEST, "revision": REVISION,
                      "platform": "linux/arm64", "report_path": path} | overrides
            result = QUALIFY.qualify(**inputs)
            self.assertEqual(result, json.loads(path.read_text()))
            self.assertNotIn("secret-token", path.read_text())
            self.assertNotIn("secret-output", path.read_text())
            return result, calls, privacy.call_count

    def test_sha_and_version_tags_share_the_same_qualification_and_expected_label(self):
        for tag in ("sha-" + REVISION, "v1.2.3"):
            with self.subTest(tag=tag):
                result, _, privacy_calls = self.run_qualification(tag=tag)
                self.assertEqual(result["status"], "passed")
                self.assertEqual(result["stage"], "complete")
                self.assertEqual(result["expected"]["version"], "sha-" + REVISION)
                self.assertEqual(result["image_id"], IMAGE_ID)
                self.assertEqual(set(result["checks"]), {"input", "pull", "digest", "labels", "smoke", "privacy"})
                self.assertEqual(privacy_calls, 1)

    def test_invalid_inputs_produce_report_without_running_tools(self):
        for changes in ({"image": "local:ci"}, {"digest": "secret-token"}, {"revision": "bad"},
                        {"platform": "linux/386"}, {"image": REPOSITORY + ":sha-" + "d" * 40},
                        {"image": "ghcr.io/example/pocketmark:v01.2.3"}):
            with self.subTest(changes=changes):
                result, calls, privacy_calls = self.run_qualification(**changes)
                self.assertEqual((result["status"], result["stage"]), ("failed", "input"))
                self.assertEqual(calls, [])
                self.assertEqual(privacy_calls, 0)

    def test_wrong_digest_stops_before_container_execution(self):
        for digests in ([], [REPOSITORY + "@sha256:" + "d" * 64], ["ghcr.io/other/image@" + DIGEST]):
            details = copy.deepcopy(DETAILS)
            details["RepoDigests"] = digests
            with self.subTest(digests=digests):
                result, calls, privacy_calls = self.run_qualification(details=details)
                self.assertEqual((result["status"], result["stage"]), ("failed", "digest"))
                self.assertEqual(set(result["checks"]), {"input", "pull"})
                self.assertFalse(any(args[0] == sys.executable for args in calls))
                self.assertEqual(privacy_calls, 0)

    def test_stale_local_digest_cannot_hide_a_changed_registry_tag(self):
        result, calls, privacy_calls = self.run_qualification(registry_digest="sha256:" + "d" * 64)
        self.assertEqual((result["status"], result["stage"]), ("failed", "digest"))
        self.assertFalse(any(args[0] == sys.executable for args in calls))
        self.assertEqual(privacy_calls, 0)

    def test_wrong_platform_or_labels_stop_before_smoke_tests(self):
        cases = [DETAILS | {"Architecture": "amd64"}, DETAILS | {"Config": {"Labels": {}}}]
        for key in ("org.opencontainers.image.revision", "org.opencontainers.image.version"):
            details = copy.deepcopy(DETAILS)
            details["Config"]["Labels"][key] = "secret-token"
            cases.append(details)
        for details in cases:
            with self.subTest(details=details):
                result, calls, privacy_calls = self.run_qualification(details=details)
                self.assertEqual((result["status"], result["stage"]), ("failed", "labels"))
                self.assertTrue(result["checks"]["digest"])
                self.assertFalse(any(args[0] == sys.executable for args in calls))
                self.assertEqual(privacy_calls, 0)

    def test_failed_commands_have_sanitized_reports_and_preserve_completed_checks(self):
        for stage in ("pull", "digest", "smoke"):
            with self.subTest(stage=stage):
                result, _, privacy_calls = self.run_qualification(failure=stage)
                self.assertEqual((result["status"], result["stage"]), ("failed", stage))
                self.assertEqual(result["reason"], stage + " failed")
                self.assertNotIn(stage, result["checks"])
                self.assertEqual(privacy_calls, 0)

    def test_missing_or_wrong_smoke_evidence_fails_before_privacy(self):
        for changes in ({"image_id": "sha256:" + "d" * 64}, {"checks": {}},
                        {"checks": {name: False for name in QUALIFY.SMOKE_CHECKS}}):
            with self.subTest(changes=changes):
                result, _, privacy_calls = self.run_qualification(smoke_changes=changes)
                self.assertEqual((result["status"], result["stage"]), ("failed", "smoke"))
                self.assertEqual(privacy_calls, 0)

    def test_privacy_network_failure_is_blocking_and_secret_free(self):
        result, _, calls = self.run_qualification(privacy_failure=OSError("secret-token"))
        self.assertEqual((result["status"], result["stage"]), ("failed", "privacy"))
        self.assertTrue(result["checks"]["smoke"])
        self.assertEqual(result["reason"], "privacy failed")
        self.assertEqual(calls, 1)

    def test_anonymous_access_is_denied_and_unexpected_http_errors_fail_closed(self):
        for status in (401, 403, 404, 500):
            failure = urllib.error.HTTPError("https://ghcr.io/token", status, "secret-token", {}, None)
            with self.subTest(status=status), patch.object(QUALIFY.urllib.request, "urlopen", side_effect=failure):
                if status == 500:
                    with self.assertRaises(QUALIFY.QualificationError):
                        QUALIFY.require_private(REPOSITORY, "v1.2.3")
                else:
                    QUALIFY.require_private(REPOSITORY, "v1.2.3")
        with patch.object(QUALIFY.urllib.request, "urlopen",
                          side_effect=[io.BytesIO(b'{"token":"secret-token"}'), io.BytesIO(b'{}')]):
            with self.assertRaises(QUALIFY.QualificationError):
                QUALIFY.require_private(REPOSITORY, "v1.2.3")

    def test_cli_exit_status_agrees_with_retained_result(self):
        for status, code in (("passed", 0), ("failed", 1)):
            with self.subTest(status=status), patch.object(sys, "argv", ["qualify_image.py", "--image", "image",
                    "--digest", "digest", "--revision", "revision", "--platform", "platform", "--report", "report"]), \
                    patch.object(QUALIFY, "qualify", return_value={"status": status}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(QUALIFY.main(), code)

    def test_cli_input_failure_writes_json_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            completed = subprocess.run([sys.executable, str(Path(QUALIFY.__file__)), "--image", "secret-token",
                                       "--digest", DIGEST, "--revision", REVISION, "--platform", "linux/arm64",
                                       "--report", str(path)], capture_output=True, text=True, timeout=10)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(json.loads(path.read_text())["stage"], "input")
            self.assertNotIn("secret-token", completed.stdout + completed.stderr + path.read_text())


if __name__ == "__main__":
    unittest.main()
