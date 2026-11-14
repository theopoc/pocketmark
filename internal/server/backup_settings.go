package server

import (
	"context"
	"database/sql"
	"errors"
	"filippo.io/age"
	"github.com/google/uuid"
	"io"
	"net/http"

	"pocketmark/internal/backup"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
	"time"
)

func (a *Server) registerBackups(m *http.ServeMux) {
	m.HandleFunc("GET /api/backups", a.backupSettings)
	m.HandleFunc("PUT /api/backups/settings", a.updateBackup)
	m.HandleFunc("POST /api/backups/test", a.testBackup)
	m.HandleFunc("POST /api/backups/preview", a.previewSchedule)
	m.HandleFunc("POST /api/backups/key", func(w http.ResponseWriter, r *http.Request) {
		k, e := age.GenerateX25519Identity()
		if e != nil {
			handleError(w, e)
			return
		}
		respond(w, 200, map[string]string{"recipient": k.Recipient().String(), "identity": k.String()})
	})
	m.HandleFunc("POST /api/backups/run", func(w http.ResponseWriter, r *http.Request) {
		id, e := a.Store.QueueBackup(r.Context(), "manual")
		if errors.Is(e, store.ErrBackupBusy) {
			fail(w, 409, "Configure backups first or wait for the active run.")
			return
		}
		if e != nil {
			handleError(w, e)
			return
		}
		observability.Logger(r.Context()).Info("backup_queued", "backup_id", id)
		respond(w, 202, map[string]string{"id": id})
	})
	m.HandleFunc("POST /api/backups/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if _, e := uuid.Parse(r.PathValue("id")); e != nil {
			fail(w, 400, "Invalid run ID")
			return
		}
		if e := a.Store.CancelBackup(r.Context(), r.PathValue("id")); e != nil {
			if errors.Is(e, sql.ErrNoRows) {
				fail(w, 409, "Run already finished")
				return
			}
			handleError(w, e)
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	})
	m.HandleFunc("POST /api/backups/library", a.restoreBackupLibrary)
}
func (a *Server) backupSettings(w http.ResponseWriter, r *http.Request) {
	c, s, next, e := a.Store.BackupConfig(r.Context())
	if e != nil {
		handleError(w, e)
		return
	}
	h, e := a.Store.History(r.Context())
	if e != nil {
		handleError(w, e)
		return
	}
	metrics, e := a.Store.BackupMetrics(r.Context())
	if e != nil {
		handleError(w, e)
		return
	}
	times, _ := c.Upcoming(time.Now())
	respond(w, 200, map[string]any{"settings": backup.Settings{Config: c, HasCredentials: len(s) > 0, Next: next, Upcoming: times}, "runs": h, "lastSuccess": metrics["last_success_timestamp_seconds"]})
}
func (a *Server) previewSchedule(w http.ResponseWriter, r *http.Request) {
	var c backup.Config
	if !decode(w, r, &c, 16384) {
		return
	}
	times, e := c.Upcoming(time.Now())
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	respond(w, 200, times)
}
func (a *Server) inputBackup(w http.ResponseWriter, r *http.Request, test bool) (backup.Settings, []byte, bool) {
	var c backup.Settings
	if !decode(w, r, &c, 16384) {
		return c, nil, false
	}
	e := c.Config.DestinationOK()
	if !test {
		e = c.Config.Validate()
	}
	if e != nil {
		fail(w, 400, e.Error())
		return c, nil, false
	}
	old, sealed, _, e := a.Store.BackupConfig(r.Context())
	if e != nil {
		handleError(w, e)
		return c, nil, false
	}
	if c.AccessKey != "" || c.SecretKey != "" {
		sealed, e = backup.Seal(a.token, c.Credentials, c.Binding())
	} else if c.Binding() != old.Binding() || len(sealed) == 0 {
		e = errors.New("Enter credentials for this destination")
	}
	if e != nil {
		fail(w, 400, e.Error())
		return c, nil, false
	}
	return c, sealed, true
}
func (a *Server) updateBackup(w http.ResponseWriter, r *http.Request) {
	c, s, ok := a.inputBackup(w, r, false)
	if !ok {
		return
	}
	if e := a.Store.SaveBackup(r.Context(), c.Config, s); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) testBackup(w http.ResponseWriter, r *http.Request) {
	c, s, ok := a.inputBackup(w, r, true)
	if !ok {
		return
	}
	k, e := backup.Open(a.token, s, c.Binding())
	if e != nil {
		handleError(w, e)
		return
	}
	remote, e := backup.NewRemote(c.Config, k)
	if e != nil {
		fail(w, 400, "Invalid S3 configuration")
		return
	}
	defer remote.Close()
	ctx, stop := context.WithTimeout(r.Context(), 30*time.Second)
	defer stop()
	op, e := remote.Probe(ctx)
	if e != nil {
		code, status, _ := backup.Diagnosis(e)
		observability.Logger(ctx).Warn("backup_probe_failed", "operation", op, "error_code", code, "http_status", status)
		respond(w, 502, map[string]string{"code": "backup_probe_failed", "error": "S3 connection test failed at " + op + " (" + code + ")."})
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) restoreBackupLibrary(w http.ResponseWriter, r *http.Request) {
	select {
	case a.imports <- struct{}{}:
		defer func() { <-a.imports }()
	default:
		fail(w, 409, "Import already running")
		return
	}
	deadline := time.Now().Add(4 * time.Hour)
	control := http.NewResponseController(w)
	_ = control.SetReadDeadline(deadline)
	_ = control.SetWriteDeadline(deadline)
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	f, e := a.Store.AnonymousFile(".restore-*.zip")
	if e != nil {
		handleError(w, e)
		return
	}

	defer f.Close()
	n, e := io.Copy(f, http.MaxBytesReader(w, r.Body, 64<<30))
	if e != nil {
		fail(w, 400, "Incomplete archive or archive exceeds 64 GiB")
		return
	}
	z, e := store.OpenLibraryZip(f, n)
	if e != nil {
		fail(w, 400, "Select a decrypted library ZIP")
		return
	}
	m, e := store.ReadManifest(z)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if r.URL.Query().Get("confirm") == "1" {
		if e = a.Store.RestoreLibrary(ctx, z, m); e != nil {
			if errors.Is(e, store.ErrLibraryNotEmpty) {
				fail(w, 409, e.Error())
			} else {
				observability.Error(r.Context(), "backup_restore_failed", e)
				fail(w, 400, "Restore failed. Library transaction rolled back.")
			}
			return
		}
	}
	respond(w, 200, m)
}
