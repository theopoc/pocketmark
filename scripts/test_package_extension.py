"""Manual packages contain only the production allowlist, with the MV3 worker."""
import importlib.util
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("package_extension", Path(__file__).resolve().parents[1] / "extension/package.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)
ROOT = Path(__file__).resolve().parents[1]
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_release", ROOT / "scripts/verify_release.py")
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(VERIFY)


class PopupAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.names = set()

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == "script" and values.get("src"):
            self.names.add(values["src"])
        if tag == "link" and values.get("rel") == "stylesheet":
            self.names.add(values["href"])


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
                assets = PopupAssets()
                assets.feed(archive.read("popup.html").decode())
                self.assertTrue(assets.names <= set(archive.namelist()), "popup references unpackaged assets")
            with self.assertRaises(FileExistsError):
                PACKAGE.package(output)

    def test_manual_release_and_verification_allowlists_agree(self):
        entries = re.findall(r"^\s*- \{src: extension/([^,]+), dst: ([^}]+)\}",
                             (ROOT / ".goreleaser.yaml").read_text(), re.MULTILINE)
        self.assertEqual(len(entries), len(PACKAGE.FILES), "release archive has missing/duplicate entries")
        self.assertEqual(dict(entries), {name: name for name in PACKAGE.FILES})
        self.assertEqual(VERIFY.EXTENSION_FILES, set(PACKAGE.FILES))
