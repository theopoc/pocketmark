# Derive the remote backup encryption key from the server secret

The owner wants one secret to keep offline for full-instance recovery. Before uploading a full or custom backup, Pocketmark encrypts the archive with a key derived from the active server secret specifically for backup encryption, with a derivation context distinct from other uses of that secret. Archive recovery requires the encrypted object and the original server secret. Settings require no additional backup key.

## Recovery and rotation

Keep the server secret separately from the remote objects. Each archive requires the secret value in use when Pocketmark created it. If that value changes, keep the old value for as long as its archives are needed. An archived copy remains readable by anyone who obtains both the object and its corresponding server secret. An independent offline key would isolate historical backups from disclosure of the server secret at the cost of a second recovery secret.

Full and custom backups exclude the server secret, S3 credentials and Telegram bot token. The owner supplies those credentials again when configuring a restored installation.

The remote backup feature must ship with an owner-facing recovery guide usable after total loss of the host. It must show how to retrieve the object from S3 or Garage, decrypt it offline with the original secret, identify the backup format, restore it into an empty destination and check the result. For a full backup, the decrypted ZIP feeds the [existing database restore procedure](../GUIDE.md#restore-a-full-zip-after-losing-the-server). The guide must include the exact decryption command exercised by the recovery test.
