"""First-run setup must keep credentials paired with the Compose database."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prepare_compose_env import main


class PrepareComposeEnvTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(directory.name)
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        self.docker = self.enterContext(patch("prepare_compose_env.subprocess.check_output"))
        self.config = b'{"volumes":{"pocketmark-postgres":{"name":"custom-db"}}}'

    def test_existing_volume_requires_original_password(self):
        self.docker.side_effect = [self.config, "custom-db\n"]
        with self.assertRaisesRegex(SystemExit, "original POCKETMARK_DB_PASSWORD"):
            main()
        self.assertFalse(Path(".env").exists())

    def test_new_volume_gets_one_private_password(self):
        self.docker.side_effect = [self.config, "custom-db-other\n"]
        main()
        env_file = Path(".env")
        password = env_file.read_bytes()
        self.assertRegex(password, rb"^POCKETMARK_DB_PASSWORD=[0-9a-f]{64}\n$")
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
        main()
        self.assertEqual(env_file.read_bytes(), password)
