"""Exercise the actual workflow gate, including omitted prerequisites and skips."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


WORKFLOW = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
JOBS = WORKFLOW.split('\njobs:\n', 1)[1]
GATE = JOBS.split('\n  required:\n', 1)[1]
SCRIPT = textwrap.dedent(GATE.split("python3 - <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
NEEDS = [name.strip() for name in re.search(r'^    needs: \[([^\]]+)\]$', GATE, re.M)[1].split(',')]


class WorkflowGateTests(unittest.TestCase):
    def test_every_prerequisite_is_required_and_gate_always_runs(self):
        jobs = set(re.findall(r'^  ([\w-]+):$', JOBS, re.M))
        self.assertEqual(set(NEEDS), jobs - {'required'})
        self.assertIn('    if: always()\n', GATE)
        self.assertIn('    name: CI passed\n', GATE)

    def run_gate(self, results):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / 'summary.md'
            result = subprocess.run([sys.executable, '-c', SCRIPT], capture_output=True, text=True,
                                    env={**os.environ, 'RESULTS': json.dumps(results),
                                         'GITHUB_STEP_SUMMARY': str(summary)}, timeout=10)
            return result, summary.read_text() if summary.exists() else ''

    def results(self, full='true', extension='true'):
        results = {name: {'result': 'success'} for name in NEEDS}
        results['changes']['outputs'] = {'full': full, 'extension': extension}
        return results

    def test_only_complete_success_passes(self):
        result, summary = self.run_gate(self.results())
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in NEEDS:
            self.assertIn(f'| {name} | success |', summary)

    def test_any_failure_skip_or_cancellation_blocks_merge(self):
        for name in NEEDS:
            for status in ('failure', 'skipped', 'cancelled', 'neutral', 'unknown'):
                results = self.results()
                results[name]['result'] = status
                with self.subTest(job=name, status=status):
                    result, summary = self.run_gate(results)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)
                    self.assertIn(f'| {name} | {status} |', summary)

    def test_missing_results_fail_closed(self):
        for name in NEEDS:
            results = self.results()
            del results[name]
            with self.subTest(missing=name):
                result, _ = self.run_gate(results)
                self.assertNotEqual(result.returncode, 0)
        result, _ = self.run_gate({})
        self.assertNotEqual(result.returncode, 0)

    def test_documentation_accepts_only_deliberate_skips(self):
        results = self.results('false', 'false')
        for name in ('quality', 'test', 'build', 'extension'):
            results[name]['result'] = 'skipped'
        result, summary = self.run_gate(results)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('intentionally omitted', summary)
        for name in NEEDS:
            for status in ('failure', 'cancelled', 'neutral', 'unknown', 'skipped'):
                if name in ('quality', 'test', 'build', 'extension') and status == 'skipped':
                    continue
                changed = {job: dict(value) for job, value in results.items()}
                changed[name]['result'] = status
                with self.subTest(job=name, status=status):
                    result, _ = self.run_gate(changed)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)

    def test_missing_or_unknown_selection_blocks_merge(self):
        for full in (None, '', 'unknown', True, False):
            with self.subTest(full=full):
                result, _ = self.run_gate(self.results(full))
                self.assertNotEqual(result.returncode, 0)
        results = self.results()
        del results['changes']['outputs']
        result, _ = self.run_gate(results)
        self.assertNotEqual(result.returncode, 0)

    def test_extension_only_requires_extension_success(self):
        results = self.results('false', 'true')
        for name in ('quality', 'test', 'build'):
            results[name]['result'] = 'skipped'
        result, _ = self.run_gate(results)
        self.assertEqual(result.returncode, 0, result.stderr)
        for status in ('skipped', 'failure', 'cancelled'):
            results['extension']['result'] = status
            with self.subTest(status=status):
                result, _ = self.run_gate(results)
                self.assertNotEqual(result.returncode, 0)
        for full, extension in (('true', 'false'), ('false', ''), ('true', None)):
            with self.subTest(full=full, extension=extension):
                result, _ = self.run_gate(self.results(full, extension))
                self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
