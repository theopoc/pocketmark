package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"pocketmark/internal/backup"
)

// Publish the private ZIP only after age authenticates the complete stream.
func decryptBackup(dir, input, output string) error {
	if input == "" || output == "" {
		return errors.New("supply -decrypt-backup FILE and -output ZIP")
	}
	secret, err := loadServerSecret(dir, false)
	if err != nil {
		return err
	}
	f, err := os.Open(input)
	if err != nil {
		return err
	}
	defer f.Close()
	plain, err := backup.DecryptArchive(f, secret)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(output), ".pocketmark-decrypt-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, plain)
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Link(tmp.Name(), output)
}
