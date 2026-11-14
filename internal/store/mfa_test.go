package store

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"pocketmark/internal/pgtest"
	"testing"
	"time"
)

// A live migration preserves MFA, browser sessions and original binary bytes.
func TestSQLiteMigrationPreservesIdentityAndFilesAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "migrated")
	pgtest.Migrate(t, path, `
INSERT INTO account VALUES (1,'owner','salt','hash');
UPDATE mfa SET secret=X'00FF',generation=7,last_counter=123;
INSERT INTO mfa_recovery VALUES('saved-code');
INSERT INTO sessions(id,hash,expires_at,last_used_at,idle_minutes) VALUES(5,'session',4102444800,123,0);
INSERT INTO links(id,url,archive,tags,status,created_at,updated_at)
VALUES(9,'https://example.test/archive',X'00FF235C','["kept"]','processing','2025-01-02T03:04:05Z','2025-01-02T03:04:05Z');
INSERT INTO assets VALUES(12,9,'original.pdf','application/pdf','pdf',6,'2025-01-02T03:04:05Z');
INSERT INTO asset_chunks VALUES(12,0,X'250050'),(12,1,X'4446FF');
INSERT INTO dav_ids(id,kind,local_id) VALUES(31,'bookmark',9);
UPDATE sqlite_sequence SET seq=73 WHERE name='dav_ids';`)
	ctx := context.Background()
	for range 2 {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		factor, err := s.MFA(ctx)
		if err != nil || factor.Generation != 7 || !bytes.Equal(factor.Secret, []byte{0, 255}) {
			t.Fatalf("factor: %v", err)
		}
		if !sessionUsable(t, s, ctx, "session") {
			t.Fatal("migrated session revoked")
		}
		link, err := s.Get(ctx, 9)
		if err != nil || link.Status != "pending" || len(link.Tags) != 1 || link.Tags[0] != "kept" {
			t.Fatalf("migrated bookmark: %+v %v", link, err)
		}
		archive, err := s.Archive(ctx, 9)
		if err != nil || !bytes.Equal(archive, []byte{0, 255, 35, 92}) {
			t.Fatalf("archive: %x %v", archive, err)
		}
		var pdf bytes.Buffer
		if err = s.WriteAsset(ctx, 12, &pdf); err != nil || !bytes.Equal(pdf.Bytes(), []byte{37, 0, 80, 68, 70, 255}) {
			t.Fatalf("file: %x %v", pdf.Bytes(), err)
		}
		var seq int64
		if err = s.db.QueryRow("SELECT last_value FROM dav_ids_id_seq").Scan(&seq); err != nil || seq != 73 {
			t.Fatalf("DAV sequence: %d %v", seq, err)
		}
		if err = s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMFANativeBackupInvalidatesCodesOnlyOnRestore(t *testing.T) {
	ctx := context.Background()
	s, err := openTestStore(t, filepath.Join(t.TempDir(), "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.SaveAccount(ctx, Account{Username: "owner", Salt: "salt", Hash: "hash"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE mfa SET secret=decode('0102','hex') WHERE id=1; INSERT INTO mfa_recovery(hash) VALUES('saved-code')"); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateMFAChallenge(ctx, "before", MFAChallenge{Kind: "verify", Salt: "salt"}); err != nil {
		t.Fatal(err)
	}
	f, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 1 {
		t.Fatal("backup changed live recovery codes", err)
	}
	minimumCounter := time.Now().Unix()/30 + 1
	restored, err := restoreTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 0 {
		t.Fatal("restored recovery codes were not invalidated", err)
	}
	state, err := restored.MFA(ctx)
	if err != nil || len(state.Secret) != 2 {
		t.Fatal("restore removed the encrypted factor", err)
	}
	if err = restored.db.QueryRow("SELECT count(*) FROM mfa_challenges").Scan(&count); err != nil || count != 0 {
		t.Fatal("pending challenges survived restore", err)
	}
	if err = restored.CreateMFAChallenge(ctx, "after", MFAChallenge{Kind: "verify", Salt: "salt", Generation: state.Generation}); err != nil {
		t.Fatal(err)
	}
	var restoredCounter int64
	if err = restored.db.QueryRow("SELECT last_counter FROM mfa WHERE id=1").Scan(&restoredCounter); err != nil || restoredCounter < minimumCounter {
		t.Fatal("restore did not invalidate the current TOTP window", err)
	}
	if err = restored.SignInMFA(ctx, "after", "salt", state.Generation, restoredCounter, "", "replayed-session", time.Now().Add(time.Hour), ""); err == nil {
		t.Fatal("restore accepted a TOTP counter from the invalidated window")
	}
	if err = restored.SignInMFA(ctx, "after", "salt", state.Generation, restoredCounter+1, "", "fresh-session", time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal("later TOTP counter rejected after restore", err)
	}
	if _, err = restored.db.Exec("INSERT INTO mfa_recovery(hash) VALUES('new-code')"); err != nil {
		t.Fatal(err)
	}
	if err = restored.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err = openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 1 {
		t.Fatal("ordinary restart removed newly generated codes", err)
	}
}
