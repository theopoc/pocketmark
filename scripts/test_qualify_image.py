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

import qualify_image as QUALIFY

REVISION = "a" * 40
DIGEST = "sha256:" + "b" * 64
IMAGE_ID = "sha256:" + "c" * 64
REPOSITORY = "ghcr.io/example/pocketmark"
DETAILS = {"Id": IMAGE_ID, "RepoDigests": [REPOSITORY + "@" + DIGEST], "Os": "linux", "Architecture": "arm64",
           "Config": {"Labels": {"org.opencontainers.image.revision": REVISION,
                                 "org.opencontainers.image.version": "v1.2.3"}}}


class QualificationTests(unittest.TestCase):
    def run_qualification(self, tag="v1.2.3", details=None, failure=None,
                          registry_digest=DIGEST, health_state=None, **overrides):
        calls = []
        details = copy.deepcopy(DETAILS if details is None else details)

        def execute(*args, **kwargs):
            calls.append(args)
            kind = ("pull" if args[:2] == ("docker", "pull") else
                    "digest" if args[:3] in (("docker", "buildx", "imagetools"), ("docker", "image", "inspect"))
                    else "health")
            if failure and kind == failure:
                raise subprocess.CalledProcessError(1, args, output="secret-output", stderr="secret-token")
            if kind == "digest":
                if args[:3] == ("docker", "buildx", "imagetools"):
                    return json.dumps({"digest": registry_digest})
                return json.dumps([details])
            if args[:2] == ("docker", "run"):
                if args[-1] == "postgres:18-alpine":
                    self.assertIn("--network-alias", args)
                    return "d" * 64
                self.assertEqual(args[-1], IMAGE_ID)
                self.assertIn('--network', args)
                self.assertIn('POCKETMARK_DATABASE_URL=postgresql://postgres@db/postgres?sslmode=disable', args)
                self.assertIn('--read-only', args)
                return 'f' * 64
            if args[:2] == ("docker", "inspect"):
                return json.dumps({'Running': True, 'Health': {'Status': 'healthy'}}
                                  if health_state is None else health_state)
            return ""

        with tempfile.TemporaryDirectory() as directory, patch.object(QUALIFY, "command", side_effect=execute):
            path = Path(directory) / "nested/report.json"
            inputs = {"image": REPOSITORY + ":" + tag, "digest": DIGEST, "revision": REVISION,
                      "platform": "linux/arm64", "report_path": path} | overrides
            result = QUALIFY.qualify(**inputs)
            self.assertEqual(result, json.loads(path.read_text()))
            self.assertNotIn("secret-token", path.read_text())
            self.assertNotIn("secret-output", path.read_text())
            return result, calls

    def test_version_image_qualification_checks_the_release_version(self):
        result, _ = self.run_qualification()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["stage"], "complete")
        self.assertEqual(result["expected"]["version"], "v1.2.3")
        self.assertEqual(result["image_id"], IMAGE_ID)
        self.assertEqual(set(result["checks"]), {"input", "pull", "digest", "labels", "health"})

    def test_invalid_inputs_produce_report_without_running_tools(self):
        for changes in ({"image": "local:ci"}, {"digest": "secret-token"}, {"revision": "bad"},
                        {"platform": "linux/386"}, {"image": REPOSITORY + ":sha-" + "d" * 40},
                        {"image": "ghcr.io/example/pocketmark:v01.2.3"}):
            with self.subTest(changes=changes):
                result, calls = self.run_qualification(**changes)
                self.assertEqual((result["status"], result["stage"]), ("failed", "input"))
                self.assertEqual(calls, [])

    def test_wrong_digest_stops_before_container_execution(self):
        for digests in ([], [REPOSITORY + "@sha256:" + "d" * 64], ["ghcr.io/other/image@" + DIGEST]):
            details = copy.deepcopy(DETAILS)
            details["RepoDigests"] = digests
            with self.subTest(digests=digests):
                result, calls = self.run_qualification(details=details)
                self.assertEqual((result["status"], result["stage"]), ("failed", "digest"))
                self.assertEqual(set(result["checks"]), {"input", "pull"})
                self.assertFalse(any(args[:2] == ("docker", "run") for args in calls))

    def test_stale_local_digest_cannot_hide_a_changed_registry_tag(self):
        result, calls = self.run_qualification(registry_digest="sha256:" + "d" * 64)
        self.assertEqual((result["status"], result["stage"]), ("failed", "digest"))
        self.assertFalse(any(args[:2] == ("docker", "run") for args in calls))

    def test_wrong_platform_or_labels_stop_before_container_execution(self):
        cases = [DETAILS | {"Architecture": "amd64"}, DETAILS | {"Config": {"Labels": {}}}]
        for key in ("org.opencontainers.image.revision", "org.opencontainers.image.version"):
            details = copy.deepcopy(DETAILS)
            details["Config"]["Labels"][key] = "secret-token"
            cases.append(details)
        for details in cases:
            with self.subTest(details=details):
                result, calls = self.run_qualification(details=details)
                self.assertEqual((result["status"], result["stage"]), ("failed", "labels"))
                self.assertTrue(result["checks"]["digest"])
                self.assertFalse(any(args[:2] == ("docker", "run") for args in calls))

    def test_failed_commands_have_sanitized_reports_and_preserve_completed_checks(self):
        for stage in ("pull", "digest", "health"):
            with self.subTest(stage=stage):
                result, _ = self.run_qualification(failure=stage)
                self.assertEqual((result["status"], result["stage"]), ("failed", stage))
                self.assertEqual(result["reason"], stage + " failed")
                self.assertNotIn(stage, result["checks"])

    def test_failed_health_checks_always_remove_only_the_disposable_container(self):
        for state in ({'Running': False}, {'Running': True},
                      {'Running': True, 'Health': {'Status': 'unhealthy'}}):
            with self.subTest(state=state):
                result, calls = self.run_qualification(health_state=state)
                self.assertEqual((result['status'], result['stage']), ('failed', 'health'))
                self.assertIn(('docker', 'rm', '--force', '--volumes', 'f' * 64), calls)

    def test_health_timeout_cleans_up_and_fails_closed(self):
        with patch.object(QUALIFY.time, 'monotonic', side_effect=[0, 46]):
            result, calls = self.run_qualification(
                health_state={'Running': True, 'Health': {'Status': 'starting'}})
        self.assertEqual((result['status'], result['stage']), ('failed', 'health'))
        self.assertIn(('docker', 'rm', '--force', '--volumes', 'f' * 64), calls)

    def test_successful_health_check_cleans_up_the_disposable_container(self):
        result, calls = self.run_qualification()
        self.assertEqual(result['status'], 'passed')
        self.assertIn(('docker', 'rm', '--force', '--volumes', 'f' * 64), calls)

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
