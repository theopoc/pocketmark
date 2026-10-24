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
        self.assertEqual(set(NEEDS), jobs - {'required', 'main-image'})
        self.assertIn('    if: always()\n', GATE)
        self.assertIn('    name: CI passed\n', GATE)
        publication = JOBS.split('\n  main-image:\n', 1)[1]
        self.assertIn('    needs: required\n', publication)
        self.assertIn("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", publication)

    def run_gate(self, results):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / 'summary.md'
            result = subprocess.run([sys.executable, '-c', SCRIPT], capture_output=True, text=True,
                                    env={**os.environ, 'RESULTS': json.dumps(results),
                                         'GITHUB_STEP_SUMMARY': str(summary)}, timeout=10)
            return result, summary.read_text()

    def test_only_complete_success_passes(self):
        result, summary = self.run_gate({name: {'result': 'success'} for name in NEEDS})
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in NEEDS:
            self.assertIn(f'| {name} | success |', summary)

    def test_any_failure_skip_or_cancellation_blocks_merge(self):
        for name in NEEDS:
            for status in ('failure', 'skipped', 'cancelled', 'neutral', 'unknown'):
                results = {job: {'result': 'success'} for job in NEEDS}
                results[name]['result'] = status
                with self.subTest(job=name, status=status):
                    result, summary = self.run_gate(results)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)
                    self.assertIn(f'| {name} | {status} |', summary)

    def test_missing_results_fail_closed(self):
        result, _ = self.run_gate({})
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
