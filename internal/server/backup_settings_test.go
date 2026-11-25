package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/backup"
	"pocketmark/internal/fault"
	"pocketmark/internal/store"
)

type telegramRoundTrip func(*http.Request) (*http.Response, error)

func (f telegramRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestBackupOverridesAndDestinationBinding(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	c := backup.Default()
	c.Endpoint, c.Bucket, c.Zone = "https://first.example", "one-bucket", "Europe/Paris"
	save := func(s backup.Settings, want int) {
		t.Helper()
		b, e := json.Marshal(s)
		if e != nil {
			t.Fatal(e)
		}
		requireStatus(t, request(a, "PUT", "/api/backups/settings", string(b), true, nil), want)
	}
	save(backup.Settings{Config: c, Credentials: backup.Credentials{AccessKey: "first-access", SecretKey: "first-secret"}}, 200)
	env, e := backup.ReadEnvironment(func(k string) string {
		return map[string]string{"POCKETMARK_BACKUP_S3_ENDPOINT": "https://second.example", "POCKETMARK_BACKUP_S3_ACCESS_KEY_ID": "external-access", "POCKETMARK_BACKUP_S3_SECRET_ACCESS_KEY": "external-secret", "POCKETMARK_BACKUP_ENABLED": "false"}[k]
	})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.ConfigureBackups(ctx, env); e != nil {
		t.Fatal(e)
	}
	w := request(a, "GET", "/api/backups", "", true, nil)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), "external-secret") || strings.Contains(w.Body.String(), "first-access") {
		t.Fatal("credentials in response")
	}
	c.Endpoint, c.RetentionDays, c.Enabled = "https://third.example", 8, true
	save(backup.Settings{Config: c, Credentials: backup.Credentials{AccessKey: "ignored", SecretKey: "ignored"}}, 200)
	s, e := a.backupState(ctx)
	if e != nil || s.effective.Endpoint != "https://second.example" || s.effective.Enabled || s.keys.AccessKey != "external-access" {
		t.Fatal("field override lost", e)
	}
	if e = a.ConfigureBackups(ctx, backup.Environment{}); e != nil {
		t.Fatal(e)
	}
	s, e = a.backupState(ctx)
	if e != nil || s.effective.RetentionDays != 8 || s.effective.Endpoint != "https://first.example" || s.keys.SecretKey != "first-secret" || s.effective.Enabled {
		t.Fatal("saved value lost", e)
	}
	c = s.effective
	c.Endpoint = "https://third.example"
	save(backup.Settings{Config: c}, 200)
	requireStatus(t, request(a, "POST", "/api/backups/run", "", true, nil), 409)
	save(backup.Settings{Config: c, Credentials: backup.Credentials{AccessKey: "replacement"}}, 200)
	requireStatus(t, request(a, "POST", "/api/backups/run", "", true, nil), 409)
	save(backup.Settings{Config: c, Credentials: backup.Credentials{AccessKey: "replacement", SecretKey: "replacement-secret"}}, 200)
}

func TestTelegramDispatchOnceAndSeparately(t *testing.T) {
	ctx := context.Background()
	a := newTestServer(t, "", false)
	c := backup.Default()
	c.TelegramChatID = "-123"
	c.Bucket = "example-bucket"
	c.Endpoint = "https://backup.example"
	key := "123:test-bot"
	sealed, err := backup.Seal(a.token, backup.Credentials{AccessKey: "test", SecretKey: "test", TelegramToken: key}, c.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Store.SaveBackup(ctx, c, sealed); err != nil {
		t.Fatal(err)
	}
	var reject bool
	count := 0
	a.telegramTransport = telegramRoundTrip(func(req *http.Request) (*http.Response, error) {
		count++
		if req.URL.Host != "api.telegram.org" || req.URL.Path != "/bot"+key+"/sendMessage" {
			t.Fatal("unexpected Telegram address")
		}
		var p map[string]string
		if json.NewDecoder(req.Body).Decode(&p) != nil || p["chat_id"] != "-123" || !strings.Contains(p["text"], "Stage: upload") || !strings.Contains(p["text"], "Last successful backup: none") {
			t.Fatal("bad message")
		}
		if reject {
			return nil, errors.New("private transport error")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: http.Header{}}, nil
	})
	for i, want := range []string{"sent", "failed"} {
		reject = i == 1
		id, err := a.Store.QueueBackup(ctx, "manual")
		if err != nil {
			t.Fatal(err)
		}
		err = a.Store.WorkBackup(ctx, func(j store.BackupJob) error {
			if err := j.Progress(ctx, "upload", 0, 1024, map[string]int64{}); err != nil {
				return err
			}
			_, err := j.Finish(ctx, "failed", 0, map[string]any{"error_code": "AccessDenied"})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err = a.dispatchBackupNotification(ctx); err != nil {
				t.Fatal(err)
			}
		}
		var status, delivery string
		if err = a.db.QueryRow("SELECT status,notification FROM backup_runs WHERE id=$1", id).Scan(&status, &delivery); err != nil || status != "failed" || delivery != want || count != i+1 {
			t.Fatal(status, delivery, count, err)
		}
	}
}

func TestTelegramFailureHidesBotToken(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := sendBackupTelegram(ctx, telegramRoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("private URL and token") }), "123:example", "42", "test")
	if err == nil || err.Error() != "Telegram connection failed" {
		t.Fatal("transport information escaped")
	}
}

func TestStaleBackupFormCannotReplaceSavedSettings(t *testing.T) {
	a := newTestServer(t, "", false)
	c := backup.Default()
	first := ""
	apply := func(rev *string, want int) {
		b, e := json.Marshal(backup.Settings{Config: c, Revision: rev})
		if e != nil {
			t.Fatal(e)
		}
		requireStatus(t, request(a, "PUT", "/api/backups/settings", string(b), true, nil), want)
	}
	apply(&first, 200)
	w := request(a, "GET", "/api/backups", "", true, nil)
	var state struct{ Settings backup.Settings }
	if json.Unmarshal(w.Body.Bytes(), &state) != nil || state.Settings.Revision == nil {
		t.Fatal("Missing revision")
	}
	c.RetentionDays = 14
	apply(state.Settings.Revision, 200)
	c.RetentionDays = 2
	apply(state.Settings.Revision, 409)
}

func TestIncompleteEnabledBackupEnvironmentLeavesSettingsAvailable(t *testing.T) {
	a := newTestServer(t, "", false)
	env, err := backup.ReadEnvironment(func(k string) string {
		if k == "POCKETMARK_BACKUP_ENABLED" {
			return "true"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.ConfigureBackups(t.Context(), env); err != nil {
		t.Fatal(err)
	}
	w := request(a, "GET", "/api/backups", "", true, nil)
	requireStatus(t, w, 200)
	var state struct{ Settings backup.Settings }
	if json.Unmarshal(w.Body.Bytes(), &state) != nil || state.Settings.SetupError == "" || state.Settings.Next != nil || !state.Settings.Managed["Enabled"] {
		t.Fatal("missing suspended schedule state")
	}
	state.Settings.Endpoint, state.Settings.Zone, state.Settings.Bucket = "https://backup.example", "UTC", "restored-bucket"
	state.Settings.AccessKey, state.Settings.SecretKey = "test", "test"
	b, err := json.Marshal(state.Settings)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "PUT", "/api/backups/settings", string(b), true, nil), 200)
	state = struct{ Settings backup.Settings }{}
	w = request(a, "GET", "/api/backups", "", true, nil)
	if json.Unmarshal(w.Body.Bytes(), &state) != nil || state.Settings.Next == nil || state.Settings.SetupError != "" {
		t.Fatal("schedule did not resume")
	}
}

func TestTelegramRejectionsExplainTheFix(t *testing.T) {
	for status, code := range map[int]string{
		http.StatusBadRequest:          "telegram_chat_rejected",
		http.StatusUnauthorized:        "telegram_token_rejected",
		http.StatusForbidden:           "telegram_chat_forbidden",
		http.StatusNotFound:            "telegram_token_rejected",
		http.StatusInternalServerError: "telegram_rejected",
	} {
		err := sendBackupTelegram(context.Background(), telegramRoundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"ok":false}`))}, nil
		}), "123:example", "42", "test")
		var app *fault.Error
		if !errors.As(err, &app) || app.Code != code || strings.Contains(err.Error(), "123:example") {
			t.Fatalf("HTTP %d: %v", status, err)
		}
	}
}
