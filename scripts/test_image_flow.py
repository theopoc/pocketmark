"""Keep promotion separate from builds and browser tests attached to actual images."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ImageFlowTests(unittest.TestCase):
    def test_version_publication_never_builds_an_image(self):
        release = (ROOT / ".github/workflows/container-release.yml").read_text()
        self.assertNotIn("docker/build-push-action", release)
        self.assertNotIn("docker build ", release)
        self.assertIn("scripts/container_release.py promote", release)
        self.assertIn('--version "sha-$REVISION"', release)

    def test_pr_and_final_main_images_run_browser_tests(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        main = (ROOT / ".github/workflows/main-image.yml").read_text()
        self.assertIn("--image pocketmark:ci --browser", ci)
        self.assertIn('docker pull --platform "linux/$ARCH" "$IMAGE@$DIGEST"', main)
        self.assertIn('--version "$VERSION" --browser', main)
        self.assertIn("needs: [prepare, build]", main)
        self.assertIn('echo "tag=sha-$REVISION"', main)

    def test_release_downloads_binaries_from_complete_main_run(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn("scripts/validated_ci.py", release)
        self.assertIn("run-id: ${{ needs.verify.outputs.run_id }}", release)
        self.assertNotIn("uses: ./.github/workflows/ci.yml", release)
