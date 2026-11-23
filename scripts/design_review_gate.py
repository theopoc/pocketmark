"""Claude Code hook: require a design review whenever interface files change.

`stop` blocks the end of a Claude turn while the interface diff against the
merge-base differs from the last diff reviewed by the `design-reviewer` agent.
`record` runs after an Agent tool call and stores the reviewed fingerprint when
that call launched `design-reviewer`. The fingerprint lives in the Git directory,
so nothing is written to the working tree.
"""
import hashlib
import json
import os
import subprocess
import sys

AGENT = 'design-reviewer'
PATHS = ['frontend', 'internal/webui', 'extension', 'DESIGN.md', 'docs/pocketmark-dark-preview.jpg']
EXCLUDE = [':(exclude,glob)**/*.test.cjs', ':(exclude)internal/webui/bundle-helper.cjs', ':(exclude)frontend/test',
           ':(exclude)frontend/package-lock.json']
BASES = ['origin/main', 'origin/HEAD', 'main']
SKIP_ENV = 'POCKETMARK_SKIP_DESIGN_REVIEW'
BLOCKED = 'pocketmark-design-review-blocked'


def git(cwd, *args, binary=False):
    out = subprocess.run(['git', *args], cwd=cwd, capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode().strip()


class MissingBase(Exception):
    pass


def base(cwd):
    for ref in BASES:
        try:
            return git(cwd, 'merge-base', 'HEAD', ref)
        except subprocess.CalledProcessError:
            continue
    raise MissingBase('none of ' + ', '.join(BASES) + ' resolves; fetch main to compare interface changes')


def fingerprint(cwd):
    """Hash of the interface diff against the merge-base, or '' when there is none."""
    spec = ['--', *PATHS, *EXCLUDE]
    digest = hashlib.sha256()
    diff = git(cwd, 'diff', '--binary', base(cwd), *spec, binary=True)
    digest.update(diff)
    untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z', *spec, binary=True)
    names = sorted(n for n in untracked.split(b'\0') if n)
    for name in names:
        digest.update(b'\0' + name + b'\0')
        with open(os.path.join(cwd, name.decode()), 'rb') as handle:
            digest.update(hashlib.sha256(handle.read()).digest())
    return digest.hexdigest() if diff or names else ''


def state_path(cwd, name='pocketmark-design-review'):
    return os.path.join(cwd, git(cwd, 'rev-parse', '--git-path', name))


def read_state(cwd, name='pocketmark-design-review'):
    try:
        with open(state_path(cwd, name)) as handle:
            return handle.read().strip()
    except OSError:
        return ''


def write_state(cwd, value, name='pocketmark-design-review'):
    with open(state_path(cwd, name), 'w') as handle:
        handle.write(value + '\n')


def stop(event, cwd):
    if os.environ.get(SKIP_ENV) == '1':
        return None
    try:
        current = fingerprint(cwd)
    except MissingBase as error:
        if event.get('stop_hook_active'):
            return None
        return {'decision': 'block', 'reason': f'Design review gate cannot find a base branch: {error}.'}
    if not current or current == read_state(cwd):
        return None
    # A turn continued by this hook may stop again only when the interface diff has
    # not changed since the last block; edits made after a review are blocked again.
    if event.get('stop_hook_active') and current == read_state(cwd, BLOCKED):
        return None
    write_state(cwd, current, BLOCKED)
    return {'decision': 'block', 'reason': (
        'Interface files changed since the last design review (frontend/, internal/webui/, '
        'extension/, DESIGN.md or the README preview). Before finishing, launch the '
        f'`{AGENT}` subagent with the user request, merge-base (`git merge-base HEAD origin/main`), '
        'complete diff, validation results and a disposable preview or before/after evidence. '
        'Apply actionable findings, re-review corrections, then report its verdict, findings '
        'and unverified coverage to the user.')}


def record(event, cwd):
    tool_input = event.get('tool_input') or {}
    if tool_input.get('subagent_type') == AGENT:
        try:
            write_state(cwd, fingerprint(cwd))
        except MissingBase:
            pass


def main(argv):
    event = json.load(sys.stdin)
    cwd = event.get('cwd') or os.getcwd()
    try:
        cwd = git(cwd, 'rev-parse', '--show-toplevel')
        if argv[1:] == ['stop']:
            decision = stop(event, cwd)
            if decision:
                print(json.dumps(decision))
        elif argv[1:] == ['record']:
            record(event, cwd)
        else:
            print('usage: design_review_gate.py stop|record', file=sys.stderr)
            return 2
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'design review gate skipped: {error}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
