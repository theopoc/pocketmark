package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"io"
	"net/http"

	"pocketmark/internal/backup"
	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
	"time"
)

func (a *Server) registerBackups(m *http.ServeMux) {
	m.HandleFunc("GET /api/backups", a.backupSettings)
	m.HandleFunc("PUT /api/backups/settings", a.updateBackup)
	m.HandleFunc("POST /api/backups/test", a.testBackup)
	m.HandleFunc("POST /api/backups/preview", a.previewSchedule)
	m.HandleFunc("POST /api/backups/telegram/test", a.testTelegram)
	m.HandleFunc("POST /api/backups/run", func(w http.ResponseWriter, r *http.Request) {
		state, err := a.backupState(r.Context())
		if err != nil {
			handleError(w, err)
			return
		}
		if err = state.ready(); err != nil {
			fail(w, 409, err.Error())
			return
		}
		id, e := a.Store.QueueBackup(r.Context(), "manual", state.revision)
		if errors.Is(e, store.ErrBackupChanged) {
			fail(w, 409, "Settings changed. Reload and try again.")
			return
		}
		if errors.Is(e, store.ErrBackupBusy) {
			fail(w, 409, "Configure remote backups first.")
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
	state, e := a.backupState(r.Context())
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
	times, _ := state.effective.Upcoming(time.Now())
	var setupError string
	if state.effective.Enabled {
		if err := state.ready(); err != nil {
			setupError = "Schedule paused until configuration is complete. " + err.Error()
		}
	}
	respond(w, 200, map[string]any{"settings": backup.Settings{SetupError: setupError, Revision: &state.revision, Config: state.effective, HasCredentials: state.keys.HasS3(), HasTelegramToken: state.keys.TelegramToken != "", Managed: a.backupEnv.Managed(), Next: state.next, Upcoming: times}, "runs": h, "lastSuccess": metrics["last_success_timestamp_seconds"]})
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

type backupState struct {
	draft, effective backup.Config
	saved, keys      backup.Credentials
	next             *time.Time
	revision         string
}

func (a *Server) backupState(ctx context.Context) (state backupState, err error) {
	var sealed []byte
	state.draft, sealed, state.next, state.revision, err = a.Store.BackupDraft(ctx)
	if err != nil {
		return
	}
	state.saved, err = backup.Open(a.token, sealed, state.draft.Binding())
	if err != nil {
		return
	}
	state.apply(a.backupEnv)
	return
}

func (s *backupState) apply(env backup.Environment) {
	s.effective, s.keys = s.draft, s.saved
	env.Apply(&s.effective, &s.keys)
	binding := s.saved.Destination
	if binding == "" {
		binding = s.draft.Binding()
	}
	if binding != s.effective.Binding() {
		s.keys.AccessKey, s.keys.SecretKey = "", ""
		env.Apply(&s.effective, &s.keys)
	}
}

func (s backupState) ready() error {
	if err := s.effective.Validate(); err != nil {
		return err
	}
	if !s.keys.HasS3() {
		return errors.New("Enter credentials for this destination")
	}
	if s.effective.TelegramChatID != "" && s.keys.TelegramToken == "" {
		return errors.New("Enter the Telegram bot token")
	}
	return nil
}

func (a *Server) saveBackupState(ctx context.Context, state backupState) error {
	draft, err := backup.Seal(a.token, state.saved, state.draft.Binding())
	if err != nil {
		return err
	}
	keys, err := backup.Seal(a.token, state.keys, state.effective.Binding())
	if err != nil {
		return err
	}
	return a.Store.SaveBackupSettings(ctx, state.draft, draft, state.effective, keys, state.revision)
}

// Resolve field-level overrides before the scheduler starts. Concurrent owner edits win.
func (a *Server) ConfigureBackups(ctx context.Context, env backup.Environment) error {
	a.backupEnv = env
	for ctx.Err() == nil {
		state, err := a.backupState(ctx)
		if err != nil {
			return err
		}
		if state.revision == "" && len(env.Managed()) == 0 {
			return nil
		}
		if state.effective.Enabled {
			if err = state.ready(); err != nil {
				// Keep the owner interface available to supply missing fields, for
				// example after recovering the account with a replacement secret.
				state.effective.Enabled = false
				observability.Logger(ctx).Warn("backup_schedule_incomplete", "reason", err.Error())
			}
		}
		err = a.saveBackupState(ctx, state)
		if !errors.Is(err, store.ErrBackupChanged) {
			return err
		}
	}
	return ctx.Err()
}

func (a *Server) inputBackup(w http.ResponseWriter, r *http.Request) (backupState, bool) {
	var input backup.Settings
	if !decode(w, r, &input, 16384) {
		return backupState{}, false
	}
	s, err := a.backupState(r.Context())
	if err != nil {
		handleError(w, err)
		return s, false
	}
	if r.Method == http.MethodPut && input.Revision != nil && *input.Revision != s.revision {
		fail(w, http.StatusConflict, "Settings changed. Reload before saving.")
		return s, false
	}
	old, saved := s.draft, s.saved
	s.draft = input.Config
	a.backupEnv.PreserveManaged(&s.draft, &s.saved, old, saved)
	s.apply(a.backupEnv)
	binding := saved.Destination
	if binding == "" {
		binding = old.Binding()
	}
	managed := a.backupEnv.Managed()
	newAccess := input.AccessKey != "" && !managed["AccessKey"]
	newSecret := input.SecretKey != "" && !managed["SecretKey"]
	if newAccess || newSecret {
		if binding != s.effective.Binding() {
			s.saved.AccessKey, s.saved.SecretKey = "", ""
		}
		if newAccess {
			s.saved.AccessKey = input.AccessKey
		}
		if newSecret {
			s.saved.SecretKey = input.SecretKey
		}
		s.saved.Destination = s.effective.Binding()
	}
	if input.ClearTelegram && !managed["TelegramChatID"] && !managed["TelegramToken"] {
		s.draft.TelegramChatID = ""
		s.saved.TelegramToken = ""
	} else if input.TelegramToken != "" && !managed["TelegramToken"] {
		s.saved.TelegramToken = input.TelegramToken
	}
	s.apply(a.backupEnv)
	return s, true
}

func (a *Server) updateBackup(w http.ResponseWriter, r *http.Request) {
	s, ok := a.inputBackup(w, r)
	if !ok {
		return
	}
	err := s.effective.ValidateDraft()
	if s.effective.Enabled {
		err = s.ready()
	}
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if e := a.saveBackupState(r.Context(), s); e != nil {
		if errors.Is(e, store.ErrBackupChanged) {
			fail(w, 409, "Settings changed. Reload and try again.")
			return
		}
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) testBackup(w http.ResponseWriter, r *http.Request) {
	s, ok := a.inputBackup(w, r)
	if !ok {
		return
	}
	remote, e := backup.NewRemote(s.effective, s.keys)
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
	n, e := io.Copy(f, inputReader{http.MaxBytesReader(w, r.Body, backup.MaxLibraryZIP)})
	if e != nil {
		handleError(w, fault.Wrap("backup.restore.receive", e))
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
				handleError(w, fault.Wrap("backup.restore.library", e))
			}
			return
		}
	}
	respond(w, 200, m)
}
