"""Reject tampered or unsafe release bundles before publication."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("verify_release", Path(__file__).with_name("verify_release.py"))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
COMMIT = "a" * 40


def fixture(root, wrong_machine=False, extra_member=False, missing_debugger=False):
    for arch, machine in VERIFY.ARCHES.items():
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        header[18:20] = (183 if wrong_machine else machine).to_bytes(2, "little")
        with tarfile.open(root / f"pocketmark-linux-{arch}.tar.gz", "w:gz") as archive:
            for name, content in {"pocketmark": bytes(header), "README.md": b"Install instructions"}.items():
                item = tarfile.TarInfo(name)
                item.mode, item.size = (0o755 if name == "pocketmark" else 0o644), len(content)
                archive.addfile(item, io.BytesIO(content))
            if extra_member:
                archive.addfile(tarfile.TarInfo("access-token"))
        (root / f"pocketmark-linux-{arch}.buildinfo.txt").write_text(f"vcs.revision={COMMIT}\nvcs.modified=false\n")
    with zipfile.ZipFile(root / "pocketmark-extension.zip", "w") as archive:
        for name in VERIFY.EXTENSION_FILES:
            content = json.dumps({"permissions": ["activeTab", "scripting", "storage"] + ([] if missing_debugger else ["debugger"]), "background": {"service_worker": "background.js"}}) if name == "manifest.json" else "synthetic"
            archive.writestr(name, content)
    (root / "SHA256SUMS").write_text("".join(f"{VERIFY.digest(root / name)}  {name}\n" for name in sorted(VERIFY.ASSETS)))


class ReleaseVerificationTests(unittest.TestCase):
    def test_only_approved_assets_are_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            (root / "local.env").write_text("synthetic neighbor")
            output = root / "verified"
            VERIFY.verify(root, COMMIT, output=output)
            self.assertEqual({x.name for x in output.iterdir()}, VERIFY.ASSETS | {"SHA256SUMS"})

    def test_invalid_bundle_is_rejected(self):
        for options in ({"wrong_machine": True}, {"extra_member": True}, {"missing_debugger": True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture(root, **options)
                with self.assertRaises(ValueError):
                    VERIFY.verify(root, COMMIT)

    def test_checksum_and_wrong_revision_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            with self.assertRaises(ValueError):
                VERIFY.verify(root, "b" * 40)
            (root / "pocketmark-extension.zip").write_bytes(b"tampered")
            with self.assertRaises(ValueError):
                VERIFY.verify(root, COMMIT)


if __name__ == "__main__":
    unittest.main()
