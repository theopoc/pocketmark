"""Manual packages contain only the production allowlist, with the MV3 worker."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("package_extension", Path(__file__).resolve().parents[1] / "extension/package.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class ExtensionPackageTests(unittest.TestCase):
    def test_package_is_installable_and_excludes_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "extension.zip"
            PACKAGE.package(output)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), set(PACKAGE.FILES))
                manifest = json.loads(archive.read("manifest.json"))
                self.assertIn(manifest["background"]["service_worker"], archive.namelist())
                self.assertEqual(manifest["permissions"].count("debugger"), 1)
                self.assertIsNone(archive.testzip())
            with self.assertRaises(FileExistsError):
                PACKAGE.package(output)
