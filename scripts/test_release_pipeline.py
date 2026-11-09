"""Execute release source selection and registry guards without network access."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()
REVISION = 'a' * 40
DIGESTS = {'amd64': 'sha256:' + 'b' * 64, 'arm64': 'sha256:' + 'c' * 64}
INDEX = {'schemaVersion': 2, 'digest': 'sha256:' + 'd' * 64,
         'manifests': [{'platform': {'os': 'linux', 'architecture': arch}, 'digest': digest}
                       for arch, digest in DIGESTS.items()]}


def job(name, workflow=WORKFLOW):
    return re.search(r'^  ' + name + r':\n(.*?)(?=^  [\w-]+:|\Z)', workflow, re.M | re.S)[1]


def script(name, step, workflow=WORKFLOW):
    block = job(name, workflow).split(step, 1)[1].split('        run: |\n', 1)[1]
    return textwrap.dedent(re.split(r'\n(?=      - |  [\w-]+:)', block, maxsplit=1)[0])


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'tools'
        self.bin.mkdir()
        self.env = os.environ | {'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                                 'GITHUB_REPOSITORY': 'Example/Pocketmark',
                                 'GITHUB_OUTPUT': str(self.root / 'output'),
                                 'REVISION': REVISION, 'GH_TOKEN': 'synthetic',
                                 'EVENT': 'pull_request', 'MERGE_SHA': REVISION,
                                 'PR_NUMBER': '42', 'PUBLISH': 'true', 'REQUESTED_TAG': ''}
        (self.root / 'version.txt').write_text('1.2.3\n')

    def tool(self, name, source):
        path = self.bin / name
        path.write_text('#!' + shutil.which('python3') + '\n' + textwrap.dedent(source))
        path.chmod(0o755)

    def execute(self, source, **env):
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', source], cwd=self.root,
                              env=self.env | env, capture_output=True, text=True, timeout=10)

    def outputs(self):
        path = self.root / 'output'
        return dict(line.split('=', 1) for line in path.read_text().splitlines()) if path.exists() else {}

    def select(self, **env):
        self.tool('git', """
            import os, sys
            if sys.argv[1] == 'rev-parse': print(os.environ['REVISION'])
            elif sys.argv[1:3] == ['merge-base', '--is-ancestor']: sys.exit(0)
            else: sys.exit(99)
        """)
        return self.execute(script('source', '- id: source'), **env)

    def test_merged_release_uses_event_sha_without_api_lookup(self):
        result = self.select()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outputs(), {'revision': REVISION, 'tag': 'v1.2.3',
                                         'pr': '42', 'publish': 'true', 'image': 'ghcr.io/example/pocketmark'})

    def test_checkout_must_match_native_merge_sha(self):
        result = self.select(MERGE_SHA='e' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.outputs(), {})

    def test_manual_verification_does_not_publish(self):
        result = self.select(EVENT='workflow_dispatch', PUBLISH='false')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outputs()['publish'], 'false')
        self.assertEqual(self.outputs()['tag'], '')

    def test_manual_publication_requires_matching_stable_tag(self):
        for tag in ('', 'main', 'v01.2.3', 'v1.2.3-rc1', 'v1.2.4', 'v1.2.3\ninjected=true'):
            with self.subTest(tag=tag):
                result = self.select(EVENT='workflow_dispatch', REQUESTED_TAG=tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.outputs(), {})
        result = self.select(EVENT='workflow_dispatch', REQUESTED_TAG='v1.2.3')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_please_is_scoped_to_the_tested_pr(self):
        self.tool('git', 'import sys; sys.exit(1)')
        self.tool('gh', '''
            import json, sys
            from pathlib import Path
            with Path('commands').open('a') as out: out.write(json.dumps(sys.argv[1:]) + '\\n')
        ''')
        self.tool('npx', '''
            import json, sys
            from pathlib import Path
            Path('release-please-args').write_text(json.dumps(sys.argv[1:]))
        ''')
        result = self.execute(script('tag', '- name: Create only'), RELEASE_TAG='v1.2.3', PR_NUMBER='42')
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.root / 'release-please-args').read_text())
        self.assertIn('github-release', args)
        self.assertEqual(args[args.index('--label') + 1], 'autorelease: pending,tested:' + REVISION)
        commands = [json.loads(line) for line in (self.root / 'commands').read_text().splitlines()]
        self.assertIn(['pr', 'edit', '42', '--add-label', 'tested:' + REVISION], commands)
        self.assertFalse(any(command[:2] == ['release', 'create'] for command in commands))

    def test_tag_cannot_bypass_checks_and_publication_joins_both_branches(self):
        self.assertIn('needs: [source, checks]', job('tag'))
        self.assertNotIn('if: always()', job('tag'))
        self.assertIn('needs: [source, images, github]', job('index'))
        self.assertNotIn('if: always()', job('index'))

    def test_ci_gate_rejects_failed_cancelled_and_skipped_validations(self):
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        command = job('gate', ci).split('        run: ', 1)[1].strip()
        for status in ('success', 'failure', 'cancelled', 'skipped'):
            with self.subTest(status=status):
                result = self.execute(command, RESULTS=json.dumps({
                    'quality': {'result': 'success'}, 'test': {'result': status}}))
                self.assertEqual(result.returncode == 0, status == 'success')

    def test_tag_sha_must_match_the_tested_revision_before_any_build(self):
        self.tool('git', '''
            import os, sys
            if sys.argv[1] == 'rev-parse': print(os.environ['TAG_REVISION'])
            elif sys.argv[1] != 'fetch': sys.exit(99)
        ''')
        self.tool('gh', '''
            import os, sys
            if sys.argv[1:3] == ['auth', 'setup-git']: sys.exit(0)
            if os.environ.get('RELEASE_ERROR'):
                print(os.environ['RELEASE_ERROR'], file=sys.stderr)
                sys.exit(1)
            print(os.environ['RELEASE_STATE'])
        ''')
        release = {'tagName': 'v1.2.3', 'isDraft': False, 'isPrerelease': False}
        source = script('tag', '- name: Verify the tested tag')
        result = self.execute(source, RELEASE_TAG='v1.2.3', TAG_REVISION='e' * 40,
                              RELEASE_STATE=json.dumps(release))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.outputs(), {})
        result = self.execute(source, RELEASE_TAG='v1.2.3', TAG_REVISION=REVISION,
                              RELEASE_STATE=json.dumps(release))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outputs()['published'], 'true')
        for error, expected in [('release not found', 0), ('HTTP 403: Forbidden', 1),
                                ('HTTP 404: repository not found', 1), ('TLS handshake timeout', 1)]:
            with self.subTest(error=error):
                (self.root / 'output').unlink(missing_ok=True)
                result = self.execute(source, RELEASE_TAG='v1.2.3', TAG_REVISION=REVISION,
                                      RELEASE_ERROR=error)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(self.outputs(), {'published': 'false'} if expected == 0 else {})

    def publish_index(self, index=None, error=''):
        (self.root / 'index-fixture.json').write_text(json.dumps(INDEX if index is None else index))
        digests = self.root / 'digests'
        digests.mkdir(exist_ok=True)
        for arch, digest in DIGESTS.items():
            (digests / arch).write_text(digest + '\n')
        self.tool('docker', '''
            import os, sys
            from pathlib import Path
            if sys.argv[1:4] == ['buildx', 'imagetools', 'inspect']:
                if os.environ['INSPECT_ERROR'] and not Path('created').exists():
                    print(os.environ['INSPECT_ERROR'], file=sys.stderr)
                    sys.exit(1)
                print(Path('index-fixture.json').read_text())
            elif sys.argv[1:4] == ['buildx', 'imagetools', 'create']:
                Path('created').touch()
            else: sys.exit(99)
        ''')
        return self.execute(script('index', '- id: publish'), INSPECT_ERROR=error,
                            IMAGE='ghcr.io/example/pocketmark', RELEASE_TAG='v1.2.3')

    def test_missing_index_is_created_from_tested_digests(self):
        result = self.publish_index(error='manifest unknown')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'created').exists())
        self.assertEqual(self.outputs()['digest'], INDEX['digest'])

    def test_matching_existing_index_is_never_replaced(self):
        result = self.publish_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'created').exists())

    def test_registry_auth_and_network_errors_never_allow_creation(self):
        for error in ('failed to authorize: 404 not found', 'unauthorized', 'TLS handshake timeout'):
            with self.subTest(error=error):
                result = self.publish_index(error=error)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'created').exists())

    def test_different_or_incomplete_existing_indexes_are_rejected(self):
        for manifests in (INDEX['manifests'][:1], INDEX['manifests'] * 2,
                          [INDEX['manifests'][0]] * 2,
                          [INDEX['manifests'][0], INDEX['manifests'][1] | {'digest': 'sha256:' + 'e' * 64}]):
            with self.subTest(manifests=manifests):
                result = self.publish_index(INDEX | {'manifests': manifests})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'created').exists())


if __name__ == '__main__':
    unittest.main()
