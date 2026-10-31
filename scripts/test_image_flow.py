"""Keep ordinary CI free of Docker, with separate build and test phases."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
CI = (ROOT / ".github/workflows/ci.yml").read_text()
CONTAINER = (ROOT / ".github/workflows/container-release.yml").read_text()


def job(workflow, name):
    return re.search(r"^  " + name + r":\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)[1]


class ImageFlowTests(unittest.TestCase):
    def test_docker_runs_only_for_a_validated_published_release(self):
        self.assertNotIn("docker", CI.lower())
        self.assertNotIn("packages: write", CI)
        self.assertFalse((ROOT / ".github/workflows/main-image.yml").exists())
        self.assertIn("docker/build-push-action", job(CONTAINER, "build"))
        self.assertIn("needs: prepare", job(CONTAINER, "build"))
        self.assertIn('scripts/container_release.py prepare --tag "$RELEASE_TAG"', job(CONTAINER, "prepare"))
        self.assertNotIn("  push:", CONTAINER)
        self.assertNotIn("  pull_request:", CONTAINER)

    def test_source_tests_and_builds_are_separate(self):
        tests, build = job(CI, "test"), job(CI, "build")
        self.assertIn("make test TEST_FLAGS=", tests)
        self.assertNotIn("make test-extension", tests)
        extension = job(CI, "extension")
        self.assertIn("make test-extension", extension)
        self.assertIn("test_package_extension.py", extension)
        self.assertNotIn("actions/setup-go", extension)
        self.assertNotIn("matrix:", extension)
        self.assertIn("python3 -m unittest", tests)
        self.assertNotIn("make build", tests)
        self.assertIn("make build", build)
        self.assertNotIn("make test", build)
        self.assertNotIn("extension_changes", CI)
        self.assertNotIn("workflow-tools", CI)

    def test_image_build_test_and_publication_are_separate(self):
        build, tests, publish = (job(CONTAINER, name) for name in ("build", "test", "publish"))
        self.assertNotIn("smoke_docker", build)
        self.assertNotIn("docker/build-push-action", tests)
        self.assertIn("needs: [prepare, build]", tests)
        self.assertIn('--version "$VERSION" --browser', tests)
        self.assertIn("needs: [prepare, test]", publish)
        self.assertIn("python3 scripts/qualify_image.py", job(CONTAINER, "verify"))

    def test_release_reuses_binaries_from_complete_main_run(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn("scripts/validated_ci.py", release)
        self.assertIn("run-id: ${{ needs.verify.outputs.run_id }}", release)
        self.assertNotIn("uses: ./.github/workflows/ci.yml", release)
