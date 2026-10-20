"""Check release contents, executable permissions and architecture mistakes."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package_release.py"))
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PackagingTests(unittest.TestCase):
    def test_extension_packages_are_allowlisted_and_permissions_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            PACKAGE.extensions(output)
            for advanced in (False, True):
                suffix = "-advanced" if advanced else ""
                with zipfile.ZipFile(output / f"pocketmark-extension{suffix}.zip") as archive:
                    self.assertEqual(set(archive.namelist()), set(PACKAGE.EXTENSION_FILES))
                    self.assertNotIn("popup.test.cjs", archive.namelist())
                    manifest = json.loads(archive.read("manifest.json"))
                    self.assertEqual("debugger" in manifest["permissions"], advanced)
                    self.assertIsNone(archive.testzip())

    def test_native_archive_excludes_neighbor_data_and_retains_execute_bit(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            binary = output / "pocketmark"
            header = bytearray(64)
            header[:6] = b"\x7fELF\x02\x01"
            header[18:20] = (183).to_bytes(2, "little")
            binary.write_bytes(header)
            (output / "access-token").write_text("synthetic-neighbor-file")
            PACKAGE.linux(output, "arm64", binary)
            with tarfile.open(output / "pocketmark-linux-arm64.tar.gz") as archive:
                self.assertEqual(set(archive.getnames()), {"pocketmark", "README.md"})
                self.assertEqual(archive.getmember("pocketmark").mode, 0o755)
                self.assertEqual(archive.extractfile("pocketmark").read(), header)
            with self.assertRaises(ValueError):
                PACKAGE.linux(output, "amd64", binary)
            self.assertFalse((output / "pocketmark-linux-amd64.tar.gz").exists())

    def test_symlink_binary_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            target = output / "source"
            target.write_bytes(b"not a release input")
            link = output / "pocketmark"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                PACKAGE.linux(output, "amd64", link)


if __name__ == "__main__":
    unittest.main()
