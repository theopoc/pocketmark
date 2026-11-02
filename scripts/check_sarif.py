#!/usr/bin/env python3
"""Fail the SAST job on findings or missing/failed CodeQL analysis, without write permissions."""
import argparse
import hashlib
import json
from pathlib import Path

# BasicAuth carries a random 256-bit API key, not a human password. SHA256 is
# appropriate for this verifier and preserves existing keys. Bind the exception
# to the exact finding AND the reviewed generation/authentication code. Changes
# to either source require review again; no rule-wide suppression is allowed.
ROOT = Path(__file__).resolve().parents[1]
REVIEWED_API_KEY_SOURCES = {
    'internal/server/authorization.go': '8ed287ba729aebc34319b209a6aa0a8570e23ef5a59fc0ea87a5287ce1f23499',
    'internal/server/account.go': '71e876e100888caf09575182ef721bae1288197e5a0c9c860ea61d2844c83822',
}


def reviewed_api_key_finding(result):
    locations = result.get('locations', [])
    if result.get('suppressions') or len(locations) != 1:
        return False
    uri = locations[0].get('physicalLocation', {}).get('artifactLocation', {}).get('uri')
    fingerprint = result.get('partialFingerprints', {}).get('primaryLocationLineHash')
    if (result.get('ruleId'), uri, fingerprint) != (
            'go/weak-sensitive-data-hashing', 'internal/server/authorization.go', '961ba0bcbc447c16:1'):
        return False
    try:
        return all(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest
                   for path, digest in REVIEWED_API_KEY_SOURCES.items())
    except OSError:
        return False


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
            if run.get('properties', {}).get('incrementalMode') is not None:
                raise ValueError(f'{path.name}: full analysis required')
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
                if reviewed_api_key_finding(result):
                    continue
                findings.append(f'{path.name}: {result.get("ruleId", "unknown rule")}')
    if findings:
        raise ValueError('SAST findings require review and correction:\n' + '\n'.join(findings))
    print(f'CodeQL: {len(files)} reports, no findings.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    check(parser.parse_args().directory)
