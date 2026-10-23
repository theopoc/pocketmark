"""Cover release semantics and untrusted PR metadata without running a shell."""
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("check_pr_title", Path(__file__).with_name("check_pr_title.py"))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class PullRequestTitleTests(unittest.TestCase):
    def test_release_and_maintenance_titles(self):
        for title in ("feat: add collections", "fix(api): reject invalid tokens", "feat!: change API",
                      "refactor(store)!: change schema", "chore(main): release 0.1.0",
                      "ci(deps): bump actions", "build(deps): bump Go", "revert: restore old behavior"):
            with self.subTest(title=title):
                POLICY.validate_title(title)

    def test_invalid_or_multiline_metadata_is_rejected(self):
        for title in (None, "", "Fix login", "Feature: add collections", "feat: ", "fix(): invalid",
                      "fix: title\nci: hidden", "fix: title\rhidden", "fix: title\n", "feat:no space"):
            with self.subTest(title=title), self.assertRaises(ValueError):
                POLICY.validate_title(title)

    def test_shell_metacharacters_remain_plain_metadata(self):
        POLICY.validate_title('fix: handle $(commands), `quotes`, and "data"')


if __name__ == "__main__":
    unittest.main()
