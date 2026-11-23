import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

import design_review_gate as gate


def run(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True)


def write(cwd, name, text):
    path = os.path.join(cwd, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as handle:
        handle.write(text)


class DesignReviewGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.realpath(self.tmp.name)
        run(self.repo, 'init', '-q', '-b', 'main')
        run(self.repo, 'config', 'user.email', 'test@example.invalid')
        run(self.repo, 'config', 'user.name', 'test')
        write(self.repo, 'frontend/src/app.css', 'a { color: red; }\n')
        write(self.repo, 'internal/store/store.go', 'package store\n')
        run(self.repo, 'add', '.')
        run(self.repo, 'commit', '-qm', 'init')
        run(self.repo, 'branch', 'base')
        self.patches = [mock.patch.dict(os.environ, {gate.SKIP_ENV: ''}), mock.patch.object(gate, 'BASES', ['base'])]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def hook(self, mode, **event):
        out = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(json.dumps({'cwd': self.repo, **event}))), redirect_stdout(out):
            self.assertEqual(gate.main(['gate', mode]), 0)
        return json.loads(out.getvalue()) if out.getvalue() else None

    def test_non_interface_changes_do_not_block(self):
        write(self.repo, 'internal/store/store.go', 'package store\n// changed\n')
        write(self.repo, 'frontend/test/app.test.js', 'test\n')
        write(self.repo, 'extension/popup.test.cjs', 'test\n')
        write(self.repo, 'internal/webui/bundle-helper.cjs', 'test\n')
        self.assertIsNone(self.hook('stop'))

    def test_interface_change_blocks_until_reviewed_and_again_after_corrections(self):
        write(self.repo, 'frontend/src/app.css', 'a { color: blue; }\n')
        self.assertEqual(self.hook('stop')['decision'], 'block')
        self.assertIsNone(self.hook('stop', stop_hook_active=True))

        self.hook('record', tool_input={'subagent_type': 'general-purpose'})
        self.assertEqual(self.hook('stop')['decision'], 'block')
        self.hook('record', tool_input={'subagent_type': gate.AGENT})
        self.assertIsNone(self.hook('stop'))

        write(self.repo, 'extension/popup.css', 'body {}\n')
        self.assertEqual(self.hook('stop')['decision'], 'block')

    def test_corrections_in_a_continued_turn_are_blocked_again(self):
        write(self.repo, 'frontend/src/app.css', 'a { color: blue; }\n')
        self.assertEqual(self.hook('stop')['decision'], 'block')
        self.hook('record', tool_input={'subagent_type': gate.AGENT})
        write(self.repo, 'frontend/src/app.css', 'a { color: var(--accent); }\n')
        self.assertEqual(self.hook('stop', stop_hook_active=True)['decision'], 'block')
        self.assertIsNone(self.hook('stop', stop_hook_active=True))

    def test_committed_changes_count_and_missing_base_blocks_once(self):
        write(self.repo, 'frontend/src/app.css', 'a { color: blue; }\n')
        run(self.repo, 'commit', '-qam', 'ui')
        self.assertEqual(self.hook('stop')['decision'], 'block')
        with mock.patch.object(gate, 'BASES', ['missing']):
            self.assertIn('base branch', self.hook('stop')['reason'])
            self.assertIsNone(self.hook('stop', stop_hook_active=True))

    def test_skip_variable_and_non_repository_never_block(self):
        write(self.repo, 'DESIGN.md', '# changed\n')
        with mock.patch.dict(os.environ, {gate.SKIP_ENV: '1'}):
            self.assertIsNone(self.hook('stop'))
        with tempfile.TemporaryDirectory() as outside:
            self.repo = outside
            self.assertIsNone(self.hook('stop'))


if __name__ == '__main__':
    unittest.main()
