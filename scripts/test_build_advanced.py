"""Packaging refreshes only opted-in production files and rejects symlinks."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BUILDER = Path(__file__).resolve().parents[1] / "extension" / "build_advanced.py"


class AdvancedPackagingTests(unittest.TestCase):
    def build(self, output, *options):
        return subprocess.run([sys.executable, str(BUILDER), *options, str(output)],
                              capture_output=True, text=True)

    def test_refresh_is_repeatable_and_keeps_neighbors(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "advanced"
            self.assertEqual(self.build(output).returncode, 0)
            (output / "neighbor.txt").write_text("synthetic local file")
            for _ in range(2):
                self.assertEqual(self.build(output, "--reuse").returncode, 0)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["permissions"].count("debugger"), 1)
            self.assertEqual((output / "neighbor.txt").read_text(), "synthetic local file")
            self.assertNotEqual(self.build(output).returncode, 0)

    def test_refresh_rejects_symlink_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("unchanged")
            output = root / "advanced"
            output.mkdir()
            (output / "manifest.json").symlink_to(target)
            self.assertNotEqual(self.build(output, "--reuse").returncode, 0)
            self.assertEqual(target.read_text(), "unchanged")
            alias = root / "alias"
            alias.symlink_to(output, target_is_directory=True)
            self.assertNotEqual(self.build(alias, "--reuse").returncode, 0)


if __name__ == "__main__":
    unittest.main()
