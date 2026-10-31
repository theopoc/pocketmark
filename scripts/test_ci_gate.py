"""Exercise the real selector and final gate, including absent dispatch jobs."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from ci_plan import select, require_results

ROOT = Path(__file__).resolve().parents[1]


def results(server=True, extension=True):
    return {name: {'result': state, 'outputs': {}} for name, state in {
        'plan': 'success', 'security': 'success',
        'quality': 'success' if server else 'skipped',
        'test': 'success' if server else 'skipped',
        'build': 'success' if server else 'skipped',
        'extension': 'success' if extension else 'skipped',
    }.items()} | {'plan': {'result': 'success', 'outputs': {
        'server': str(server).lower(), 'extension': str(extension).lower()}}}


class WorkflowGateTests(unittest.TestCase):
    def test_paths_fail_closed_and_main_dispatch_schedule_are_complete(self):
        for event in ('push', 'workflow_dispatch', 'schedule'):
            self.assertEqual(select(event, ['docs/CI.md']), (True, True))
        for paths, expected in [(['docs/CI.md'], (False, False)),
                                (['README.md'], (False, False)),
                                (['extension/popup.js'], (False, True)),
                                (['extension/README.md'], (False, True)),
                                (['internal/server/a.go'], (True, True)),
                                (['docs/x.md', 'internal/new'], (True, True)),
                                (['.github/workflows/extension.yml'], (True, True)),
                                (['.github/actions/go-cache/action.yml'], (True, True)),
                                (['Makefile'], (True, True)),
                                (['scripts/test_ci_gate.py'], (True, True)),
                                (['unknown'], (True, True)), ([], (True, True))]:
            with self.subTest(paths=paths):
                self.assertEqual(select('pull_request', paths), expected)

    def test_only_planned_skips_pass(self):
        for server, extension in ((False, False), (False, True), (True, True)):
            require_results(results(server, extension))
            for job in results():
                for state in ('failure', 'cancelled', 'neutral', None, 'pending'):
                    with self.subTest(server=server, extension=extension, job=job, state=state):
                        bad = results(server, extension)
                        bad[job]['result'] = state
                        with self.assertRaises(ValueError):
                            require_results(bad)
        for job in results():
            bad = results()
            bad[job]['result'] = 'skipped'
            with self.subTest(job=job), self.assertRaises(ValueError):
                require_results(bad)

    def test_missing_jobs_and_malformed_plan_never_pass(self):
        for job in results():
            bad = results()
            del bad[job]
            with self.subTest(job=job), self.assertRaises(ValueError):
                require_results(bad)
        for output in ({}, {'server': 'false'}, {'server': 'yes', 'extension': 'true'}):
            bad = results()
            bad['plan']['outputs'] = output
            with self.assertRaises(ValueError):
                require_results(bad)
        with self.assertRaises(ValueError):
            require_results({})

    def test_dispatch_gate_cli_rejects_build_still_running(self):
        bad = results()
        bad['build']['result'] = None
        for needs, expected in ((bad, 1), (results(), 0)):
            proc = subprocess.run(['python3', str(ROOT / 'scripts/ci_plan.py'), 'require'],
                                  env={**os.environ, 'RESULTS': json.dumps(needs)},
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, expected, proc.stderr)

    def test_workflow_dependency_contract(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertNotIn('paths-ignore:', workflow)
        self.assertIn('    name: CI passed\n', workflow)
        gate = workflow.split('\n  required:\n')[1]
        self.assertIn('if: always()', gate)
        self.assertIn('needs: [plan, quality, security, test, build, extension]', gate)
        self.assertIn('python3 scripts/ci_plan.py require', gate)
        self.assertFalse((ROOT / '.github/workflows/ci-required.yml').exists())
        self.assertFalse((ROOT / '.github/workflows/extension.yml').exists())
        release = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertNotIn('gh workflow run ci-required.yml', release)

    def test_git_diff_includes_both_sides_of_renames(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
            git('init', '-q')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Test')
            Path(directory, 'code.go').write_text('package test\n')
            git('add', '.')
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            git('mv', 'code.go', 'README.md')
            git('commit', '-qm', 'rename')
            head = git('rev-parse', 'HEAD')
            event = Path(directory, 'event.json')
            event.write_text(json.dumps({'pull_request': {'base': {'sha': base}, 'head': {'sha': head}}}))
            output = Path(directory, 'output')
            subprocess.run(['python3', str(ROOT / 'scripts/ci_plan.py'), 'select'], cwd=directory,
                           env={**os.environ, 'GITHUB_EVENT_NAME': 'pull_request',
                                'GITHUB_EVENT_PATH': str(event), 'GITHUB_OUTPUT': str(output)}, check=True)
            self.assertIn('server=true', output.read_text())


if __name__ == '__main__':
    unittest.main()
