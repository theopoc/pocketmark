#!/usr/bin/env python3
"""Fail the SAST job on findings or missing/failed CodeQL analysis, without write permissions."""
import argparse
import json
from pathlib import Path


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
                findings.append(f'{path.name}: {result.get("ruleId", "unknown rule")}')
    if findings:
        raise ValueError('SAST findings require review and correction:\n' + '\n'.join(findings))
    print(f'CodeQL: {len(files)} reports, no findings.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    check(parser.parse_args().directory)
