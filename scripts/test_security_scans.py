"""Security scans must remain fail-closed, including incomplete SARIF."""
import json
from pathlib import Path
import tempfile
import unittest

from check_sarif import check


class SarifTests(unittest.TestCase):
    def test_missing_failed_and_findings_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                check(directory)
            path = Path(directory, 'go.sarif')
            good = {'version': '2.1.0', 'runs': [{
                'tool': {'driver': {'name': 'CodeQL'}}, 'results': []}]}
            path.write_text(json.dumps(good))
            check(directory)
            for change in ({'results': [{}]}, {'results': None},
                           {'invocations': [{'executionSuccessful': False}]},
                           {'invocations': [{'toolExecutionNotifications': [{'level': 'error'}]}]}):
                bad = json.loads(json.dumps(good))
                bad['runs'][0].update(change)
                path.write_text(json.dumps(bad))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    check(directory)
            for bad in ({}, {'version': '2.1.0', 'runs': []}):
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    check(directory)
