package main

import (
	"bytes"
	"path/filepath"
	"testing"

	"pocketmark/internal/backup"
	"pocketmark/internal/server"
	"pocketmark/internal/store"
)

func TestResetMFARecoversBackupConfigurationOnRestart(t *testing.T) {
	const current = "synthetic-current-server-secret"
	const lost = "synthetic-lost-server-secret"
	for _, test := range []struct{ name, draftKey, effectiveKey string }{
		{"same secret", current, current},
		{"new secret", lost, lost},
		{"unreadable draft", lost, current},
		{"unreadable effective", current, lost},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			path := filepath.Join(t.TempDir(), "restart")
			s, err := openTestStore(t, path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			cfg := backup.Default()
			cfg.Enabled, cfg.Zone, cfg.Endpoint, cfg.Bucket = true, "UTC", "https://s3.example", "backups"
			cfg.TelegramChatID = "123"
			keys := backup.Credentials{AccessKey: "fixture-access", SecretKey: "fixture-key", TelegramToken: "fixture-token"}
			draft, err := backup.Seal(test.draftKey, keys, cfg.Binding())
			if err != nil {
				t.Fatal(err)
			}
			effective, err := backup.Seal(test.effectiveKey, keys, cfg.Binding())
			if err != nil {
				t.Fatal(err)
			}
			if err = s.SaveBackupSettings(ctx, cfg, draft, cfg, effective); err != nil {
				t.Fatal(err)
			}
			id, err := s.QueueBackup(ctx, "manual")
			if err != nil {
				t.Fatal(err)
			}
			if err = s.WorkBackup(ctx, func(j store.BackupJob) error {
				if err := j.RecordObject(ctx, "verified-copy", ""); err != nil {
					return err
				}
				_, err := j.Finish(ctx, "succeeded", 0, nil)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			paused, err := s.ResetMFAWithBackupRecovery(ctx, current)
			wantPause := test.draftKey != current || test.effectiveKey != current
			if err != nil || paused != wantPause {
				t.Fatalf("paused=%v, error=%v", paused, err)
			}
			s.Close()
			restarted, err := openTestStore(t, path)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			saved, secret, next, err := restarted.BackupConfig(ctx)
			if err != nil || saved.Enabled == wantPause || (next == nil) != wantPause || saved.Endpoint != cfg.Endpoint || saved.TelegramChatID != cfg.TelegramChatID {
				t.Fatalf("configuration after restart: enabled=%v, next=%v, error=%v", saved.Enabled, next, err)
			}
			if test.draftKey == current && !bytes.Equal(secret, draft) || test.draftKey != current && len(secret) != 0 {
				t.Fatal("incorrect draft credential recovery")
			}
			history, err := restarted.History(ctx)
			if err != nil || len(history) != 1 || history[0].ID != id || history[0].Status != "succeeded" || history[0].Removed {
				t.Fatal("lost verified backup", err)
			}
			_, err = restarted.QueueBackup(ctx, "manual")
			if err != nil {
				t.Fatal(err)
			}
			if err = restarted.WorkBackup(ctx, func(j store.BackupJob) error {
				if test.effectiveKey == current && !bytes.Equal(j.Secret, effective) || test.effectiveKey != current && len(j.Secret) != 0 {
					t.Fatal("incorrect effective credential recovery")
				}
				_, err := j.Finish(ctx, "cancelled", 0, nil)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err = server.New(restarted, current, "", false, nil).ConfigureBackups(ctx, backup.Environment{}); err != nil {
				t.Fatal("server cannot restart after the local reset", err)
			}
		})
	}
}
