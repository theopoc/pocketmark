"""Security scans must remain fail-closed, including incomplete SARIF."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from check_sarif import check, ROOT, REVIEWED_API_KEY_SOURCES


class SarifTests(unittest.TestCase):
    def test_incremental_analysis_cannot_pass_even_without_findings(self):
        for mode in ('diff-informed', 'overlay', 'overlay-base', 'unknown'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                report = {'version': '2.1.0', 'runs': [{
                    'tool': {'driver': {'name': 'CodeQL'}}, 'results': [],
                    'properties': {'incrementalMode': mode}}]}
                Path(directory, 'go.sarif').write_text(json.dumps(report))
                with self.assertRaisesRegex(ValueError, 'full analysis required'):
                    check(directory)

    def test_missing_failed_and_findings_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                check(directory)
            path = Path(directory, 'go.sarif')
            good = {'version': '2.1.0', 'runs': [{
                'tool': {'driver': {'name': 'CodeQL'}}, 'results': []}]}
            path.write_text(json.dumps(good))
            check(directory)
            reviewed = json.loads(json.dumps(good))
            reviewed['runs'][0]['results'] = [{
                'ruleId': 'go/weak-sensitive-data-hashing',
                'locations': [{'physicalLocation': {'artifactLocation': {'uri': 'internal/server/authorization.go'}}}],
                'partialFingerprints': {'primaryLocationLineHash': '961ba0bcbc447c16:1'},
            }]
            path.write_text(json.dumps(reviewed))
            check(directory)
            with tempfile.TemporaryDirectory() as source:
                for name in REVIEWED_API_KEY_SOURCES:
                    target = Path(source, name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((ROOT / name).read_bytes())
                with mock.patch('check_sarif.ROOT', Path(source)):
                    check(directory)
                    for name in REVIEWED_API_KEY_SOURCES:
                        target = Path(source, name)
                        original = target.read_bytes()
                        target.write_bytes(original + b'// changed context\n')
                        with self.subTest(source=name), self.assertRaises(ValueError):
                            check(directory)
                        target.unlink()
                        with self.assertRaises(ValueError):
                            check(directory)
                        target.write_bytes(original)
            for suppression in ([{'kind': 'inSource'}], [{'kind': 'external'}]):
                changed = json.loads(json.dumps(reviewed))
                changed['runs'][0]['results'][0]['suppressions'] = suppression
                path.write_text(json.dumps(changed))
                with self.subTest(suppression=suppression), self.assertRaises(ValueError):
                    check(directory)
            for field, value in (
                ('ruleId', 'go/sql-injection'),
                ('locations', [{'physicalLocation': {'artifactLocation': {'uri': 'elsewhere.go'}}}]),
                ('locations', []),
                ('partialFingerprints', {'primaryLocationLineHash': 'different:1'}),
                ('locations', [{'physicalLocation': {'artifactLocation': {'uri': 'internal/server/server.go'}}}]),
            ):
                changed = json.loads(json.dumps(reviewed))
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
