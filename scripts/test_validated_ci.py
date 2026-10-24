"""Release must use the full successful main run at the exact source revision."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("validated_ci", Path(__file__).with_name("validated_ci.py"))
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)
REVISION = "a" * 40
RUN = {"id": 7, "head_sha": REVISION, "event": "push", "head_branch": "main",
       "path": ".github/workflows/ci.yml", "head_repository": {"full_name": "owner/repo"},
       "status": "completed", "conclusion": "success", "html_url": "https://example.invalid/run/7"}


class ValidatedCITests(unittest.TestCase):
    def test_missing_or_expired_binaries_block_publication(self):
        artifacts = [{"name": name, "expired": False} for name in ("linux-amd64", "linux-arm64")]
        CI.require_artifacts(artifacts)
        for index in range(len(artifacts)):
            with self.subTest(index=index), self.assertRaises(ValueError):
                CI.require_artifacts(artifacts[:index] + artifacts[index + 1:])
            with self.subTest(expired=index), self.assertRaises(ValueError):
                CI.require_artifacts([artifact | {"expired": True} if i == index else artifact
                                      for i, artifact in enumerate(artifacts)])

    def test_only_success_at_exact_main_source_is_accepted(self):
        self.assertEqual(CI.successful_run([RUN], REVISION, "owner/repo"), 7)
        for change in ({"head_sha": "b" * 40}, {"event": "pull_request"}, {"head_branch": "feature"},
                       {"path": ".github/workflows/other.yml"}, {"head_repository": {"full_name": "fork/repo"}},
                       {"status": "in_progress"}):
            with self.subTest(change=change):
                self.assertIsNone(CI.successful_run([RUN | change], REVISION, "owner/repo"))

    def test_later_failure_or_pending_run_cannot_reuse_earlier_success(self):
        for conclusion in ("failure", "cancelled", "skipped", None):
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError):
                CI.successful_run([RUN, RUN | {"id": 8, "conclusion": conclusion}], REVISION, "owner/repo")
        self.assertIsNone(CI.successful_run([RUN, RUN | {"id": 8, "status": "queued"}], REVISION, "owner/repo"))
