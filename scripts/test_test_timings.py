import json
import unittest
from test_timings import timings


class TimingsTests(unittest.TestCase):
    def test_mixed_make_output_and_failed_tests_remain_visible(self):
        packages, tests = timings(['go test -json ./...', 'TAP version 13',
                                  json.dumps({'Action': 'pass', 'Package': 'p', 'Elapsed': 4}),
                                  json.dumps({'Action': 'fail', 'Package': 'p', 'Test': 'TestSlow', 'Elapsed': 3}),
                                  json.dumps({'Action': 'output', 'Package': 'p', 'Output': 'message'})])
        self.assertEqual(packages, [(4., 'p', '', 'pass')])
        self.assertEqual(tests, [(3., 'p', 'TestSlow', 'fail')])
