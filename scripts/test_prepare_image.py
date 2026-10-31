"""Reject substituted/dirty/wrong-platform binaries before constructing an image."""
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from prepare_image import prepare

REVISION = 'a' * 40
INFO = '\n'.join(['file: go1.26.10', '\tbuild\tvcs.revision=' + REVISION,
                  '\tbuild\tvcs.modified=false', '\tbuild\tGOOS=linux', '\tbuild\tGOARCH=amd64',
                  '\tbuild\tCGO_ENABLED=1', '\tbuild\t-tags=sqlite_fts5,sqlite_omit_load_extension', ''])


class PrepareImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / 'input'
        self.inputs.mkdir()
        self.binary = self.inputs / 'pocketmark'
        header = bytearray(120)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, 62)
        struct.pack_into('<Q', header, 32, 64)
        struct.pack_into('<HH', header, 54, 56, 1)
        struct.pack_into('<I', header, 64, 1)
        self.binary.write_bytes(header)
        self.metadata = self.inputs / 'pocketmark-linux-amd64.buildinfo.txt'
        self.metadata.write_text(INFO)
        self.recipe = self.root / 'Dockerfile.release'
        self.recipe.write_text('FROM scratch\nCOPY pocketmark /pocketmark\n')
        self.output = self.root / 'context'

    def stage(self, info=INFO):
        with patch('prepare_image.subprocess.check_output', return_value=info):
            prepare(self.inputs, 'amd64', REVISION, self.output, self.recipe)

    def test_staged_executable_is_byte_identical_and_context_is_minimal(self):
        self.stage()
        self.assertEqual(self.binary.read_bytes(), (self.output / 'pocketmark').read_bytes())
        self.assertEqual({p.name for p in self.output.iterdir()}, {'pocketmark', 'Dockerfile'})
        self.assertEqual((self.output / 'pocketmark').stat().st_mode & 0o777, 0o755)

    def test_rejects_metadata_not_extracted_from_the_binary(self):
        with self.assertRaises(ValueError):
            self.stage(INFO.replace(REVISION, 'b' * 40))

    def test_rejects_dirty_wrong_revision_and_missing_tags(self):
        for info in (INFO.replace('modified=false', 'modified=true'), INFO.replace(REVISION, 'b' * 40),
                     INFO.replace('sqlite_fts5,sqlite_omit_load_extension', 'sqlite_fts5'),
                     INFO.replace('CGO_ENABLED=1', 'CGO_ENABLED=0')):
            self.metadata.write_text(info)
            with self.subTest(info=info), self.assertRaises(ValueError):
                self.stage(info)
        self.assertFalse(self.output.exists())

    def test_rejects_wrong_architecture_and_dynamic_loader(self):
        original = self.binary.read_bytes()
        for offset, value in ((18, 183), (64, 3)):
            data = bytearray(original)
            struct.pack_into('<H', data, offset, value)
            self.binary.write_bytes(data)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                self.stage()

    def test_rejects_extra_files_and_symlinks(self):
        extra = self.inputs / 'private.db'
        extra.touch()
        with self.assertRaises(ValueError):
            self.stage()
        extra.unlink()
        self.binary.unlink()
        self.binary.symlink_to(self.recipe)
        with self.assertRaises(ValueError):
            self.stage()
