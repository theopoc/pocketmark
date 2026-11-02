"""Keep every merge-blocking check independent and unconditional."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WorkflowGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        cls.jobs = dict(re.findall(r'^  ([a-z]+):\n(.*?)(?=^  [a-z]+:|\Z)',
                                   cls.workflow.split('\njobs:\n', 1)[1], re.M | re.S))

    def test_required_jobs_cannot_be_skipped_by_paths_or_dependencies(self):
        self.assertEqual(set(self.jobs), {'quality', 'security', 'sast', 'test', 'build', 'extension'})
        self.assertNotRegex(self.workflow, r'(?m)^    (?:if|needs):')
        self.assertNotRegex(self.workflow, r'(?m)^    paths(?:-ignore)?:')
        self.assertNotIn('continue-on-error:', self.workflow)
        for name, arches in (('sast', ('go', 'javascript-typescript')),
                             ('test', ('amd64', 'arm64')), ('build', ('amd64', 'arm64'))):
            for arch in arches:
                self.assertIn(arch, self.jobs[name])
            self.assertIn('fail-fast: false', self.jobs[name])

    def test_sast_remains_complete_and_blocking(self):
        sast = self.jobs['sast']
        self.assertIn("CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'", sast)
        self.assertIn('python3 scripts/check_sarif.py artifacts/codeql', sast)
        self.assertIn('GOFLAGS=-a make build', sast)

    def test_security_includes_all_dependency_inventories_and_embedded_bundle(self):
        security = self.jobs['security']
        self.assertIn('gitleaks/gitleaks-action@', security)
        self.assertIn('govulncheck@', security)
        for inventory in ('tools/security', 'tools/quality', 'e2e'):
            self.assertIn(f'npm audit --prefix {inventory} --audit-level=high', security)
        self.assertIn('python3 scripts/check_swagger_vendor.py', security)
        self.assertIn('retire --path internal/webui/static/api-docs/vendor --severity high', security)

    def test_browser_regressions_remain_in_tests_and_extension(self):
        for job in ('test', 'extension'):
            self.assertIn('npm ci --prefix e2e --ignore-scripts --no-audit --no-fund', self.jobs[job])
            self.assertIn('playwright install --with-deps chromium', self.jobs[job])
        self.assertIn('node e2e/selectors.mjs', self.jobs['test'])
        self.assertIn('node e2e/extension-selectors.mjs', self.jobs['extension'])


if __name__ == '__main__':
    unittest.main()
