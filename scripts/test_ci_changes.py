"""Exercise CI selection against real Git ranges, without network or API limits."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('ci_changes', Path(__file__).with_name('ci_changes.py'))
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)


class DocumentationTests(unittest.TestCase):
    def test_only_repository_documentation_is_exempt(self):
        for path in ('README.md', 'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', 'PRODUCT.md',
                     'docs/CI.md', 'docs/security-audit/validation.json', 'docs/preview.png',
                     '.github/pull_request_template.md'):
            with self.subTest(path=path):
                self.assertTrue(CI.documentation(path))
        for path in ('CHANGELOG.md', 'docs/RELEASE_INSTALL.md', 'extension/README.md',
                     'internal/webui/static/api-docs/vendor/README.md',
                     'internal/webui/static/api-docs/openapi.json', 'go.mod', 'go.sum',
                     'Makefile', 'Dockerfile', 'version.txt', '.release-please-manifest.json',
                     '.goreleaser.yaml', '.github/workflows/ci.yml', '.github/dependabot.yml',
                     'scripts/ci_changes.py', 'docs/tool.py', 'new-component/README.md', 'unknown'):
            with self.subTest(path=path):
                self.assertFalse(CI.documentation(path))


class ChangeRangeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(directory.name)
        self.git('init', '--quiet')
        self.git('config', 'user.name', 'CI regression')
        self.git('config', 'user.email', 'ci@example.invalid')
        self.write('README.md', 'initial documentation\n')
        self.write('main.go', 'package main\n')
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', *args], stderr=subprocess.PIPE, text=True).strip()

    def write(self, path, content):
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self):
        self.git('add', '--all')
        self.git('commit', '--quiet', '-m', 'test fixture')
        return self.git('rev-parse', 'HEAD')

    def selected(self, base, head, event='pull_request'):
        payload = {'pull_request': {'base': {'sha': base}, 'head': {'sha': head}}} if event == 'pull_request' else {
            'before': base, 'after': head}
        return CI.check_scope(event, payload) == 'full'

    def test_documentation_only_pr_and_push_are_lightweight(self):
        self.write('README.md', 'updated documentation\n')
        head = self.commit()
        for event in ('pull_request', 'push'):
            with self.subTest(event=event):
                self.assertFalse(self.selected(self.base, head, event))

    def test_code_in_an_earlier_commit_requires_full_suite(self):
        self.write('main.go', 'package main\n// changed\n')
        self.commit()
        self.write('README.md', 'documentation in the latest commit\n')
        head = self.commit()
        for event in ('pull_request', 'push'):
            with self.subTest(event=event):
                self.assertTrue(self.selected(self.base, head, event))

    def test_pr_uses_merge_base_when_main_advances(self):
        self.write('README.md', 'PR documentation\n')
        head = self.commit()
        self.git('checkout', '--quiet', '--detach', self.base)
        self.write('main.go', 'package main\n// changed on main only\n')
        advanced_main = self.commit()
        self.assertFalse(self.selected(advanced_main, head))

    def test_renaming_code_to_documentation_still_requires_full_suite(self):
        Path('docs').mkdir()
        self.git('mv', 'main.go', 'docs/removed-code.md')
        self.assertTrue(self.selected(self.base, self.commit()))

    def test_renaming_documentation_to_code_requires_full_suite(self):
        self.git('mv', 'README.md', 'new.go')
        self.assertTrue(self.selected(self.base, self.commit()))

    def test_deletions_are_classified(self):
        Path('README.md').unlink()
        self.assertFalse(self.selected(self.base, self.commit()))
        Path('main.go').unlink()
        self.assertTrue(self.selected(self.base, self.commit()))

    def test_large_diff_and_unusual_names_cannot_hide_code(self):
        for index in range(350):
            self.write(f'docs/{index}.md', 'documentation\n')
        self.write('docs/line\nbreak.md', 'documentation\n')
        self.assertFalse(self.selected(self.base, self.commit()))
        self.write('z-source\nmain.go', 'code outside documentation\n')
        self.assertTrue(self.selected(self.base, self.commit()))

    def test_missing_empty_or_unavailable_ranges_require_full_suite(self):
        for base, head in ((self.base, self.base), ('', self.base), ('0' * 40, self.base),
                           ('a' * 40, self.base), ('--bad-option', self.base)):
            with self.subTest(base=base, head=head):
                self.assertTrue(self.selected(base, head))
        self.assertEqual(CI.check_scope('push', {}), 'full')
        self.assertEqual(CI.check_scope('pull_request', {}), 'full')

    def test_manual_scheduled_and_unknown_events_require_full_suite(self):
        for event in ('workflow_dispatch', 'schedule', 'unknown'):
            with self.subTest(event=event):
                self.assertEqual(CI.check_scope(event, {}), 'full')

    def test_extension_changes_run_only_extension_checks(self):
        self.write('extension/popup.js', '// extension source\n')
        self.write('extension/README.md', 'Packaged extension documentation\n')
        head = self.commit()
        for event, payload in (
            ('push', {'before': self.base, 'after': head}),
            ('pull_request', {'pull_request': {'base': {'sha': self.base}, 'head': {'sha': head}}}),
        ):
            with self.subTest(event=event):
                self.assertEqual(CI.check_scope(event, payload), 'extension')
        self.write('README.md', 'Updated project documentation\n')
        head = self.commit()
        self.assertEqual(CI.check_scope('push', {'before': self.base, 'after': head}), 'extension')
        self.write('main.go', 'package main\n// server compatibility change\n')
        self.assertTrue(self.selected(self.base, self.commit()))

    def test_cli_emits_the_expected_workflow_outputs_for_each_scope(self):
        for path, expected in (
            ('README.md', 'full=false\nextension=false\n'),
            ('extension/popup.js', 'full=false\nextension=true\n'),
            ('main.go', 'full=true\nextension=true\n'),
        ):
            self.write(path, 'Updated fixture\n')
            head = self.commit()
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                payload, output = Path(directory) / 'event.json', Path(directory) / 'output'
                payload.write_text(json.dumps({'before': self.base, 'after': head}))
                result = subprocess.run([sys.executable, SPEC.origin], capture_output=True, text=True,
                                        env={**os.environ, 'GITHUB_EVENT_NAME': 'push',
                                             'GITHUB_EVENT_PATH': str(payload), 'GITHUB_OUTPUT': str(output)},
                                        timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_text(), expected)


if __name__ == '__main__':
    unittest.main()
