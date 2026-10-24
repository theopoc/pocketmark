"""Extension selection must cover cumulative PR changes and deleted/renamed files."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("extension_changes", Path(__file__).with_name("extension_changes.py"))
CHANGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHANGES)


class ExtensionChangesTests(unittest.TestCase):
    def test_extension_and_test_tooling_are_selected(self):
        for path in ("extension/popup.js", "extension/background.test.cjs", "Makefile",
                     ".github/workflows/ci.yml", "scripts/extension_changes.py"):
            with self.subTest(path=path):
                self.assertTrue(CHANGES.affected([path]))
        self.assertFalse(CHANGES.affected(["docs/API.md", "internal/store/store.go", "e2e/browser.mjs"]))

    def test_pr_compares_to_merge_base_not_previous_push(self):
        with patch.object(CHANGES, "git", side_effect=["base", "extension/deleted.js\nREADME.md"]) as git:
            self.assertTrue(CHANGES.changed({"pull_request": {"base": {"sha": "target"}}}, "pull_request"))
            self.assertEqual(git.call_args_list[0].args, ("merge-base", "target", "HEAD"))
            self.assertEqual(git.call_args_list[1].args, ("diff", "--name-only", "--no-renames", "base", "HEAD"))

    def test_main_push_compares_all_commits_in_push(self):
        with patch.object(CHANGES, "git", return_value="internal/store/store.go") as git:
            self.assertFalse(CHANGES.changed({"before": "previous"}, "push"))
            git.assert_called_once_with("diff", "--name-only", "--no-renames", "previous", "HEAD")

    def test_manual_main_uses_last_commit_and_branch_uses_merge_base(self):
        for values, expected in ((["head", "head", "parent", "extension/popup.js"], True),
                                 (["base", "head", "docs/API.md"], False)):
            with self.subTest(values=values), patch.object(CHANGES, "git", side_effect=values):
                self.assertEqual(CHANGES.changed({}, "workflow_dispatch"), expected)
