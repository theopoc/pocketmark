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
            suppressed = json.loads(json.dumps(good))
            suppressed['runs'][0]['results'] = [{
                'ruleId': 'go/weak-sensitive-data-hashing',
                'locations': [{'physicalLocation': {'artifactLocation': {'uri': 'internal/server/server.go'}}}],
                'partialFingerprints': {'primaryLocationLineHash': 'd4926a6247ad80f2:1'},
                'suppressions': [{'kind': 'inSource'}],
            }]
            path.write_text(json.dumps(suppressed))
            check(directory)
            for suppression in ([], [{'kind': 'external'}], [{'kind': 'inSource'}, {'kind': 'external'}]):
                suppressed['runs'][0]['results'][0]['suppressions'] = suppression
                path.write_text(json.dumps(suppressed))
                with self.subTest(suppression=suppression), self.assertRaises(ValueError):
                    check(directory)
            for field, value in (
                ('ruleId', 'go/sql-injection'),
                ('locations', [{'physicalLocation': {'artifactLocation': {'uri': 'elsewhere.go'}}}]),
                ('locations', []),
                ('partialFingerprints', {'primaryLocationLineHash': 'different:1'}),
            ):
                changed = json.loads(json.dumps(suppressed))
                changed['runs'][0]['results'][0]['suppressions'] = [{'kind': 'inSource'}]
                changed['runs'][0]['results'][0][field] = value
                path.write_text(json.dumps(changed))
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
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
