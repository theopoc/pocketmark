package backup

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestScheduleClockTransitions(t *testing.T) {
	for _, tc := range []struct {
		name, zone, cron, after string
		want                    [3]string
	}{
		{"Paris skips 02:30 in spring", "Europe/Paris", "30 2 * * *", "2026-03-28T22:00:00Z",
			[3]string{"2026-03-29T01:00:00Z", "2026-03-30T00:30:00Z", "2026-03-31T00:30:00Z"}},
		{"gap matches coalesce with 03:00", "Europe/Paris", "*/15 * * * *", "2026-03-29T00:46:00Z",
			[3]string{"2026-03-29T01:00:00Z", "2026-03-29T01:15:00Z", "2026-03-29T01:30:00Z"}},
		{"Paris first autumn occurrence", "Europe/Paris", "30 2 * * *", "2026-10-24T22:00:00Z",
			[3]string{"2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z", "2026-10-27T01:30:00Z"}},
		{"resume during repeated hour", "Europe/Paris", "*/15 * * * *", "2026-10-25T01:00:00Z",
			[3]string{"2026-10-25T02:00:00Z", "2026-10-25T02:15:00Z", "2026-10-25T02:30:00Z"}},
		{"half-hour gap", "Australia/Lord_Howe", "10 2 * * *", "2026-10-03T15:00:00Z",
			[3]string{"2026-10-03T15:30:00Z", "2026-10-04T15:10:00Z", "2026-10-05T15:10:00Z"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			after, err := time.Parse(time.RFC3339, tc.after)
			if err != nil {
				t.Fatal(err)
			}
			cfg := Config{Zone: tc.zone, Cron: tc.cron}
			occurrences, err := cfg.Upcoming(after)
			if err != nil {
				t.Fatal(err)
			}
			if len(occurrences) != len(tc.want) {
				t.Fatalf("got %d occurrences", len(occurrences))
			}
			for i, due := range occurrences {
				if got := due.UTC().Format(time.RFC3339); got != tc.want[i] {
					t.Errorf("occurrence %d = %s, want %s", i, got, tc.want[i])
				}
			}
		})
	}
}

func TestBackupSettingsValidation(t *testing.T) {
	c := Default()
	if c.Enabled || c.Zone != "" || c.RetentionDays != 7 || c.WindowMinutes != 120 || c.Cron != "0 3 * * *" {
		t.Fatalf("unexpected defaults %+v", c)
	}
	c.Endpoint, c.Bucket = "https://storage.example", "pocketmark-backups"
	if err := c.Validate(); err != nil {
		t.Fatal("manual backup while paused", err)
	}
	c.Enabled = true
	if err := c.Validate(); err == nil {
		t.Error("enabled without a time zone")
	}
	c.Zone = "UTC"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, expr := range []string{"@daily", "TZ=UTC 1 2 * * *", "0 0 0 * * *", "0 0 31 2 *"} {
		c.Cron = expr
		if _, err := c.Upcoming(time.Now()); err == nil {
			t.Errorf("accepted %q", expr)
		}
	}
	c.Endpoint = "http://garage.internal:3900"
	if c.DestinationOK() == nil {
		t.Error("accepted plaintext HTTP by default")
	}
	c.AllowHTTP = true
	if err := c.DestinationOK(); err != nil {
		t.Fatal(err)
	}
}

func TestPausedBackupDraftValidatesOnlySuppliedFields(t *testing.T) {
	for _, c := range []Config{{}, Default(), {Zone: "Europe/Paris"}, {Cron: "15 5 * * *"}, {Endpoint: "https://backup.example"}, {Bucket: "pm-backups"}, {TelegramChatID: "-42"}} {
		if err := c.ValidateDraft(); err != nil {
			t.Fatalf("cannot save incomplete draft %+v: %v", c, err)
		}
		if err := c.Validate(); err == nil {
			t.Fatal("incomplete draft ready for execution")
		}
		c.Enabled = true
		if err := c.ValidateDraft(); err == nil {
			t.Fatal("activated incomplete draft")
		}
	}
	for _, c := range []Config{{WindowMinutes: -1}, {RetentionDays: -1}, {Mode: "any"}, {Endpoint: "http://s3.example"}, {Bucket: "BAD BUCKET"}, {Region: "bad/region"}, {Prefix: "../parent"}, {Zone: "Local"}, {Cron: "bad cron"}, {TelegramChatID: "unknown"}} {
		if err := c.ValidateDraft(); err == nil {
			t.Errorf("accepted invalid draft %+v", c)
		}
	}
}

func TestEnvironmentOverlayAndDraft(t *testing.T) {
	raw := map[string]string{
		"ENABLED": "false", "CRON": "12 17 * * *", "TIMEZONE": "Europe/Paris", "WINDOW": "90m", "RETENTION_DAYS": "9",
		"S3_ENDPOINT": "https://s3.example", "S3_REGION": "garage", "S3_BUCKET": "pm-prod", "S3_PREFIX": "copies",
		"S3_ACCESS_KEY_ID": "environment-id", "S3_SECRET_ACCESS_KEY": "environment-secret", "S3_ALLOW_HTTP": "false",
		"TELEGRAM_BOT_TOKEN": "environment-token", "TELEGRAM_CHAT_ID": "-239",
	}
	env, err := ReadEnvironment(func(k string) string { return raw[strings.TrimPrefix(k, "POCKETMARK_BACKUP_")] })
	if err != nil {
		t.Fatal(err)
	}
	stored := Default()
	stored.Enabled, stored.AllowHTTP = true, true
	storedSecrets := Credentials{AccessKey: "stored-id", SecretKey: "stored-secret", TelegramToken: "stored-token", Destination: "stored-binding"}
	effective, secrets := stored, storedSecrets
	env.Apply(&effective, &secrets)
	want := Config{Cron: "12 17 * * *", Zone: "Europe/Paris", WindowMinutes: 90, RetentionDays: 9, Region: "garage", Bucket: "pm-prod", Prefix: "copies", Endpoint: "https://s3.example", TelegramChatID: "-239", Mode: "full", Text: true, Files: true, Archives: true}
	wantSecrets := Credentials{AccessKey: "environment-id", SecretKey: "environment-secret", TelegramToken: "environment-token", Destination: "stored-binding"}
	if effective != want || secrets != wantSecrets {
		t.Error("environment did not override stored settings")
	}
	managed := env.Managed()
	expectedFields := strings.Fields("Enabled Cron Zone WindowMinutes RetentionDays Region Bucket Prefix Endpoint AllowHTTP AccessKey SecretKey TelegramToken TelegramChatID")
	if len(managed) != len(expectedFields) {
		t.Errorf("got %d managed fields", len(managed))
	}
	for _, f := range expectedFields {
		if !managed[f] {
			t.Errorf("missing managed field %q", f)
		}
	}
	b, err := json.Marshal(env)
	if err != nil || string(b) != "{}" {
		t.Error("environment values exposed by JSON serialization")
	}
	effective.Mode = "library"
	env.PreserveManaged(&effective, &secrets, stored, storedSecrets)
	stored.Mode = "library"
	if effective != stored || secrets != storedSecrets {
		t.Error("restoring locked fields lost a saved field")
	}
	delete(raw, "S3_SECRET_ACCESS_KEY")
	raw["S3_ACCESS_KEY_ID"] = ""
	env, err = ReadEnvironment(func(k string) string { return raw[strings.TrimPrefix(k, "POCKETMARK_BACKUP_")] })
	if err != nil {
		t.Fatal(err)
	}
	env.Apply(&effective, &secrets)
	if env.Managed()["AccessKey"] || env.Managed()["SecretKey"] || secrets.AccessKey != storedSecrets.AccessKey || secrets.SecretKey != storedSecrets.SecretKey {
		t.Error("unset/empty environment variables masked stored secrets")
	}
}

func TestRejectInvalidBackupEnvironment(t *testing.T) {
	for _, tc := range [][2]string{{"WINDOW", "0s"}, {"WINDOW", "-1h"}, {"WINDOW", "30s"}, {"WINDOW", "20000000000h"}, {"ENABLED", "nonboolean"}, {"RETENTION_DAYS", "0"}, {"RETENTION_DAYS", "40000000000"}} {
		key := "POCKETMARK_BACKUP_" + tc[0]
		_, err := ReadEnvironment(func(k string) string {
			if k == key {
				return tc[1]
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("%s accepted invalid value or omitted field name", key)
		}
	}
}

func TestDraftSecretRoundTrip(t *testing.T) {
	c := Default()
	c.Endpoint, c.Bucket = "https://storage.example", "pm-backups"
	const secret = "synthetic-private-server-secret"
	for _, original := range []Credentials{{}, {AccessKey: "new-id"}, {TelegramToken: "bot-token"}, {AccessKey: "id", SecretKey: "s3-secret", TelegramToken: "bot-token", Destination: c.Binding()}} {
		blob, err := Seal(secret, original, c.Binding())
		if err != nil {
			t.Fatal(err)
		}
		opened, err := Open(secret, blob, c.Binding())
		if err != nil || opened != original {
			t.Fatal("cannot recover saved draft")
		}
		if len(blob) > 0 {
			if bytes.Contains(blob, []byte("bot-token")) {
				t.Error("secret stored in the clear")
			}
			if _, err := Open(secret, blob, "different-destination"); err == nil {
				t.Error("accepted wrong destination")
			}
			if _, err := Open("rotated-server-secret", blob, c.Binding()); err == nil {
				t.Error("accepted wrong server secret")
			}
		}
	}
}
