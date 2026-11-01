#!/usr/bin/env python3
"""Select PR work and require exactly its completed jobs; never poll the Checks API."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def select(event, paths):
    # Main must retain a complete release build at every revision. Dispatch and
    # schedule also always exercise the full suite, including bot release PRs.
    if event != 'pull_request' or not paths:
        return True, True
    extension = False
    for path in paths:
        if path.startswith('extension/'):
            extension = True
        elif path.startswith('docs/') or (path.endswith('.md') and '/' not in path):
            continue
        else:
            # Unknown paths, tooling and embedded assets require all checks.
            return True, True
    return False, extension


def require_results(needs):
    expected = {'plan', 'security', 'sast', 'sca', 'quality', 'test', 'build', 'extension'}
    if set(needs) != expected or needs['plan'].get('result') != 'success':
        raise ValueError('Missing or unsuccessful CI plan/jobs')
    outputs = needs['plan'].get('outputs', {})
    if any(outputs.get(key) not in ('true', 'false') for key in ('server', 'extension')):
        raise ValueError('Missing or invalid CI selection')
    for name in expected:
        selected = (name in ('plan', 'security') or
                    (name in ('sast', 'sca') and 'true' in outputs.values()) or
                    outputs['extension' if name == 'extension' else 'server'] == 'true')
        required = 'success' if selected else 'skipped'
        if needs[name].get('result') != required:
            raise ValueError(f'{name}: expected {required}, got {needs[name].get("result")}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('select', 'require'))
    args = parser.parse_args()
    if args.command == 'require':
        require_results(json.loads(os.environ['RESULTS']))
        print('Every selected CI job succeeded.')
        return
    event = os.environ['GITHUB_EVENT_NAME']
    paths = []
    if event == 'pull_request':
        pr = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())['pull_request']
        base, head = pr['base']['sha'], pr['head']['sha']
        if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (base, head)):
            raise ValueError('Invalid PR revision')
        # Disable rename detection so moving executable code into a docs path
        # cannot hide the deleted source. NUL delimiters preserve unusual names.
        changed = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z',
                                           f'{base}...{head}', '--'], timeout=60)
        paths = changed.decode('utf-8', errors='surrogateescape').rstrip('\0').split('\0') if changed else []
    server, extension = select(event, paths)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'server={str(server).lower()}\nextension={str(extension).lower()}\n')
    print(f'Selected server={server}, extension={extension}; secrets always checked.')


if __name__ == '__main__':
    main()
