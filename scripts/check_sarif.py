#!/usr/bin/env python3
"""Fail the SAST job on findings or missing/failed CodeQL analysis, without write permissions."""
import argparse
import json
from pathlib import Path

# Reviewed false positives, identified by rule, source file and CodeQL's line
# fingerprint. A new finding or a changed sink must be reviewed independently.
REVIEWED = {
    ('go/weak-sensitive-data-hashing', 'internal/server/authorization.go', '961ba0bcbc447c16:1'),
    ('go/weak-sensitive-data-hashing', 'internal/server/server.go', 'd4926a6247ad80f2:1'),
}


def reviewed_suppression(result):
    locations = result.get('locations', [])
    if result.get('suppressions') != [{'kind': 'inSource'}] or len(locations) != 1:
        return False
    uri = locations[0].get('physicalLocation', {}).get('artifactLocation', {}).get('uri')
    fingerprint = result.get('partialFingerprints', {}).get('primaryLocationLineHash')
    return (result.get('ruleId'), uri, fingerprint) in REVIEWED


def check(directory):
    files = sorted(Path(directory).glob('*.sarif'))
    if not files:
        raise ValueError('CodeQL produced no SARIF reports')
    findings = []
    for path in files:
        report = json.loads(path.read_text())
        runs = report.get('runs')
        if report.get('version') != '2.1.0' or not isinstance(runs, list) or not runs:
            raise ValueError(f'{path.name}: missing analysis runs')
        for run in runs:
            if run.get('tool', {}).get('driver', {}).get('name') != 'CodeQL':
                raise ValueError(f'{path.name}: unexpected analyzer')
            invocations = run.get('invocations', [])
            if any(invocation.get('executionSuccessful') is False or any(
                    notice.get('level') == 'error'
                    for notice in invocation.get('toolExecutionNotifications', []))
                   for invocation in invocations):
                raise ValueError(f'{path.name}: incomplete analysis')
            results = run.get('results')
            if not isinstance(results, list):
                raise ValueError(f'{path.name}: missing analysis results')
            for result in results:
                # CodeQL retains source-suppressed results in SARIF.
                if reviewed_suppression(result):
                    continue
                findings.append(f'{path.name}: {result.get("ruleId", "unknown rule")}')
    if findings:
        raise ValueError('SAST findings require review and correction:\n' + '\n'.join(findings))
    print(f'CodeQL: {len(files)} reports, no findings.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    check(parser.parse_args().directory)
