"""Run the pinned third-party gate against a synthetic GitHub Checks API."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/ci-required.yml').read_text()
ACTION_SHA = re.search(r'uses: wechuli/allcheckspassed@([0-9a-f]{40})', WORKFLOW)[1]
ACTION_INPUTS = dict(re.findall(r'^          (\w+): [\'"]([^\'"\n]+)[\'"]$',
                              WORKFLOW.split('uses: wechuli/allcheckspassed@', 1)[1], re.M))
HEAD = 'a' * 40


def check(name, conclusion='success', *, identifier=1, status='completed', suite=10):
    return {'id': identifier, 'name': name, 'status': status, 'conclusion': conclusion,
            'started_at': '2026-01-01T00:00:00Z', 'completed_at': None,
            'details_url': f'https://example.invalid/checks/{identifier}',
            'check_suite': {'id': suite},
            'app': {'id': 15368, 'slug': 'github-actions', 'name': 'GitHub Actions'}}


class ChecksAPI(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.paths.append(self.path)
        path = urlsplit(self.path).path
        status = 200
        if self.server.fail_api:
            status, response = 403, {'message': 'Synthetic API failure'}
        elif path == f'/repos/owner/repo/commits/{HEAD}/check-runs':
            batch = self.server.batches[0]
            if len(self.server.batches) > 1:
                self.server.batches.pop(0)
            response = {'total_count': len(batch), 'check_runs': batch}
        elif path == '/repos/owner/repo/check-runs/900':
            response = self.server.own_check
        elif path == '/repos/owner/repo/actions/runs':
            response = {'total_count': len(self.server.runs), 'workflow_runs': self.server.runs}
        else:
            status, response = 404, {'message': 'Unexpected API route'}
        body = json.dumps(response).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class WorkflowGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bundle = os.environ.get('ALLCHECKSPASSED_PATH')
        if not bundle:
            raise RuntimeError('Set ALLCHECKSPASSED_PATH to the pinned action dist/index.js (see docs/CI.md)')
        cls.bundle = Path(bundle).resolve()
        revision = subprocess.check_output(['git', '-C', str(cls.bundle.parent.parent),
                                            'rev-parse', 'HEAD'], text=True).strip()
        if revision != ACTION_SHA:
            raise RuntimeError('Gate regressions must use the workflow-pinned action revision')
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), ChecksAPI)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def run_gate(self, checks, *, later=None, runs=None, fail_api=False):
        own = check('CI passed', None, identifier=900, status='in_progress', suite=90)
        self.server.own_check = own
        self.server.paths = []
        self.server.fail_api = fail_api
        self.server.batches = [[own, *checks]]
        if later is not None:
            self.server.batches.append([own, *later])
        self.server.runs = runs if runs is not None else [
            {'id': 90, 'workflow_id': 9, 'check_suite_id': 90},
            {'id': 10, 'workflow_id': 1, 'check_suite_id': 10},
        ]
        # Actions normally supplies action.yml defaults. Reproduce them here;
        # policy inputs come directly from our workflow, never a copied gate.
        inputs = {'token': 'synthetic-token', 'checks_include': '-1', 'checks_exclude': '-1',
                  'treat_skipped_as_passed': 'true', 'treat_neutral_as_passed': 'true',
                  'include_status_commits': 'false', 'poll': 'false', 'delay': '0',
                  'polling_interval': '0', 'retries': '2', 'fail_fast': 'true', 'fail_step': 'true',
                  'fail_on_missing_checks': 'false', 'verbose': 'false', 'show_job_summary': 'true',
                  'ignore_superseded_runs': 'false', 'check_run_id': '900'}
        inputs.update(ACTION_INPUTS)
        inputs.update(delay='0', polling_interval='0', retries='2',
                      poll='true' if later is not None else 'false')
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / 'event.json'
            event.write_text(json.dumps({'pull_request': {'head': {'sha': HEAD}}}))
            (Path(directory) / 'summary.md').touch()
            env = {**os.environ, **{f'INPUT_{key.upper()}': value for key, value in inputs.items()},
                   'GITHUB_API_URL': f'http://127.0.0.1:{self.server.server_port}',
                   'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_EVENT_NAME': 'pull_request',
                   'GITHUB_EVENT_PATH': str(event), 'GITHUB_SHA': 'b' * 40,
                   'GITHUB_JOB': 'required',
                   'GITHUB_WORKFLOW_REF': 'owner/repo/.github/workflows/ci-required.yml@refs/pull/1/merge',
                   'GITHUB_STEP_SUMMARY': str(Path(directory) / 'summary.md')}
            result = subprocess.run(['node', str(self.bundle)], env=env, capture_output=True,
                                    text=True, timeout=15)
        return result

    def test_required_workflow_has_no_path_filter_and_preserves_required_name(self):
        triggers = WORKFLOW.split('\njobs:\n', 1)[0]
        self.assertIn('  pull_request:\n', triggers)
        self.assertNotRegex(triggers, r'(?m)^\s+paths(?:-ignore)?:')
        self.assertIn('    name: CI passed\n', WORKFLOW)
        source = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn(f'ref: {ACTION_SHA}', source)
        self.assertNotIn('    name: CI passed\n', source)

    def test_documentation_needs_no_server_or_extension_checks(self):
        result = self.run_gate([check('auto-merge', 'skipped')])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(f'/commits/{HEAD}/check-runs' in path for path in self.server.paths))
        self.assertFalse(any('b' * 40 in path for path in self.server.paths))

    def test_extension_only_success_passes_without_server_checks(self):
        result = self.run_gate([check('Extension')])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mixed_pr_cannot_hide_extension_failure(self):
        server = [check(name, identifier=index + 1) for index, name in enumerate(
            ('Quality', 'Secrets and reachable Go vulnerabilities', 'Tests (amd64)',
             'Tests (arm64)', 'Build (amd64)', 'Build (arm64)'))]
        result = self.run_gate([*server, check('Extension', 'failure', identifier=20)])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Some checks have failed or timed out', result.stdout)

    def test_any_triggered_failure_skip_neutral_or_cancellation_blocks_merge(self):
        for name in ('Extension', 'Tests (amd64)', 'Build (arm64)'):
            for conclusion in ('failure', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required'):
                with self.subTest(name=name, conclusion=conclusion):
                    result = self.run_gate([check(name, conclusion)])
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('Some checks have failed or timed out', result.stdout)

    def test_pending_checks_cannot_pass_and_are_polled_until_success(self):
        for status in ('queued', 'in_progress', 'waiting', 'pending'):
            with self.subTest(status=status):
                result = self.run_gate([check('Extension', None, status=status)])
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Some checks have failed or timed out', result.stdout)
        result = self.run_gate([check('Extension', None, status='queued')], later=[check('Extension')])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sum('/check-runs' in urlsplit(path).path and '/commits/' in path
                             for path in self.server.paths), 2)

    def test_superseded_run_is_ignored_but_latest_failure_is_not(self):
        old = check('Tests (${{ matrix.arch }})', 'cancelled', identifier=2, suite=9)
        runs = [{'id': 9, 'workflow_id': 1, 'check_suite_id': 9},
                {'id': 10, 'workflow_id': 1, 'check_suite_id': 10}]
        result = self.run_gate([old, check('Tests (amd64)')], runs=runs)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = self.run_gate([old, check('Tests (amd64)', 'failure')], runs=runs)
        self.assertNotEqual(result.returncode, 0)

    def test_api_failure_blocks_merge(self):
        result = self.run_gate([], fail_api=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
