package main

import (
	"archive/zip"
	"bytes"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"

	"pocketmark/internal/backup"
)

func TestOfflineBackupRecoveryCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKETMARK_SERVER_SECRET", "")
	t.Setenv("POCKETMARK_TOKEN", "")
	t.Setenv("POCKETMARK_DATABASE_URL", "")
	const secret = "synthetic-original-server-secret"
	if err := os.WriteFile(filepath.Join(dir, "server-secret"), []byte(secret), 0600); err != nil {
		t.Fatal(err)
	}
	var plain bytes.Buffer
	z := zip.NewWriter(&plain)
	part, err := z.Create("pocketmark.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(part, "SELECT 'offline recovery fixture';"); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	var cipher bytes.Buffer
	encrypted, err := backup.EncryptArchive(&cipher, secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := encrypted.Write(plain.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := encrypted.Close(); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(dir, "backup.age")
	if err := os.WriteFile(input, cipher.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}

	// Exercise the documented CLI entry point with the network and DB absent.
	oldArgs, oldFlags := os.Args, flag.CommandLine
	t.Cleanup(func() { os.Args, flag.CommandLine = oldArgs, oldFlags })
	invoke := func(output string) error {
		flag.CommandLine = flag.NewFlagSet("pocketmark", flag.ContinueOnError)
		os.Args = []string{"pocketmark", "-data", dir, "-decrypt-backup", input, "-output", output}
		return run()
	}
	output := filepath.Join(dir, "recovered.zip")
	if err := invoke(output); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(got, plain.Bytes()) {
		t.Fatal("recovered ZIP differs", err)
	}
	info, err := os.Stat(output)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("recovered file is not private", err)
	}
	if err := os.WriteFile(output, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := invoke(output); err == nil {
		t.Fatal("overwrote existing output")
	}
	got, err = os.ReadFile(output)
	if err != nil || string(got) != "existing" {
		t.Fatal("existing file changed", err)
	}

	missingOutput := filepath.Join(dir, "failed.zip")
	t.Setenv("POCKETMARK_SERVER_SECRET", "a-different-synthetic-server-secret")
	if err := invoke(missingOutput); err == nil {
		t.Fatal("accepted wrong secret")
	}
	t.Setenv("POCKETMARK_SERVER_SECRET", "")
	last := cipher.Len() - 1
	cipher.Bytes()[last] ^= 1
	if err := os.WriteFile(input, cipher.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := invoke(missingOutput); err == nil {
		t.Fatal("accepted corrupted final chunk")
	}
	if _, err := os.Stat(missingOutput); !os.IsNotExist(err) {
		t.Fatal("published incomplete output", err)
	}
	leftover, err := filepath.Glob(filepath.Join(dir, ".pocketmark-decrypt-*"))
	if err != nil || len(leftover) != 0 {
		t.Fatal("left incomplete plaintext on disk", err)
	}
}
