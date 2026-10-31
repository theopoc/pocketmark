#!/usr/bin/env python3
"""Summarize Go test JSON from make's mixed output without retaining raw logs."""
import json
from pathlib import Path
import sys


def timings(lines):
    packages, tests = [], []
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict) or item.get('Action') not in ('pass', 'fail'):
            continue
        if 'Elapsed' not in item or 'Package' not in item:
            continue
        row = (float(item['Elapsed']), item['Package'], item.get('Test', ''), item['Action'])
        (tests if row[2] else packages).append(row)
    return sorted(packages, reverse=True), sorted(tests, reverse=True)[:20]


def main():
    with Path(sys.argv[1]).open() as source:
        packages, tests = timings(source)
    for title, rows in (('Package execution times', packages), ('Slowest tests (including subtests)', tests)):
        print(f'\n## {title}\n\n| Seconds | Package / test | Result |\n| ---: | --- | --- |')
        for seconds, package, test, result in rows:
            name = (package + (' / ' + test if test else '')).replace('|', '&#124;').replace('<', '&lt;')
            print(f'| {seconds:.3f} | {name} | {result} |')
    print('\nPackage execution excludes compilation. Nested test durations overlap; do not sum them.')


if __name__ == '__main__':
    main()
