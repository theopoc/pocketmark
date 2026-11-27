package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

func TestServerSecretPersistenceAndLegacyMigration(t *testing.T) {
	t.Setenv("POCKETMARK_SERVER_SECRET", "")
	t.Setenv("POCKETMARK_TOKEN", "")
	dir := t.TempDir()
	secret, err := loadServerSecret(dir, true)
	if err != nil || len(secret) != 64 {
		t.Fatalf("new secret: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "server-secret"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("secret permissions: %v %v", info, err)
	}
	again, err := loadServerSecret(dir, false)
	if err != nil || again != secret {
		t.Fatal("secret changed across restart", err)
	}
	legacy := t.TempDir()
	old := strings.Repeat("b", 64)
	if err := os.WriteFile(filepath.Join(legacy, "access-token"), []byte(old), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := loadServerSecret(legacy, false)
	if err != nil || got != old {
		t.Fatal("legacy secret changed", err)
	}
	missing := t.TempDir()
	if _, err := loadServerSecret(missing, false); err == nil {
		t.Fatal("missing secret silently replaced")
	}
	if _, err := loadServerSecret(missing, true); err != nil {
		t.Fatal(err)
	}
}

func TestServerSecretEnvironment(t *testing.T) {
	dir := t.TempDir()
	legacy := strings.Repeat("a", 32)
	current := strings.Repeat("b", 32)
	t.Setenv("POCKETMARK_TOKEN", legacy)
	t.Setenv("POCKETMARK_SERVER_SECRET", " ")
	if got, err := loadServerSecret(dir, false); err != nil || got != legacy {
		t.Fatal("legacy variable should supply the secret", err)
	}
	t.Setenv("POCKETMARK_SERVER_SECRET", current)
	if got, err := loadServerSecret(dir, true); err != nil || got != current {
		t.Fatal("preferred variable should take precedence", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "server-secret")); !os.IsNotExist(err) {
		t.Fatal("environment configuration should not create a secret file", err)
	}
	t.Setenv("POCKETMARK_SERVER_SECRET", "too-short")
	if _, err := loadServerSecret(dir, true); err == nil {
		t.Fatal("invalid preferred secret should fail even with a valid legacy variable")
	}
}

func TestResetAccountInputValidation(t *testing.T) {
	s, err := openTestStore(t, filepath.Join(t.TempDir(), "account.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, input := range []string{
		`{"username":"reader","password":"a good password","extra":true}`,
		`{"username":"reader","password":"a good password"} {}`,
		`{"username":"reader","password":"short"}`,
		strings.Repeat(" ", 4097),
	} {
		if err := resetAccountFromInput(s, strings.NewReader(input)); err == nil {
			t.Errorf("invalid input was accepted")
		}
	}
	if err := resetAccountFromInput(s, strings.NewReader(`{"username":"reader","password":"a good password"}`)); err != nil {
		t.Fatal(err)
	}
	account, err := s.Account(context.Background())
	if err != nil || account.Username != "reader" || account.Hash == "" {
		t.Fatalf("account not saved: %v", err)
	}
}

// The production worker must report an ordinary fetch failure even when saving
// that failure to SQLite succeeds. The loopback URL is rejected without network.
func TestWorkerReportsPersistedCaptureFailure(t *testing.T) {
	s, err := openTestStore(t, filepath.Join(t.TempDir(), "worker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, err := s.Create(context.Background(), store.Link{URL: "http://127.0.0.1/private-bookmark?secret=private-query"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := &captureLog{finished: make(chan []byte, 1)}
	o := observability.New(slog.New(slog.NewJSONHandler(log, nil)), nil)
	done := make(chan struct{})
	go func() { defer close(done); worker(ctx, s, o) }()
	select {
	case line := <-log.finished:
		if !bytes.Contains(line, []byte(`"outcome":"failed"`)) || bytes.Contains(line, []byte("private-")) {
			t.Errorf("unsafe/missing capture event: %s", line)
		}
	case <-time.After(3 * time.Second):
		t.Error("worker did not log capture failure")
	}
	cancel()
	<-done
	link, err := s.Get(context.Background(), id)
	if err != nil || link.Status != "failed" {
		t.Fatalf("capture state: %v %v", link, err)
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	if !strings.Contains(w.Body.String(), `pocketmark_capture_duration_seconds_count{outcome="failed"} 1`) {
		t.Fatal("missing worker failure metric")
	}
}

type captureLog struct{ finished chan []byte }

func (w *captureLog) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(`"event":"capture_finished"`)) {
		select {
		case w.finished <- bytes.Clone(p):
		default:
		}
	}
	return len(p), nil
}

var _ io.Writer = (*captureLog)(nil)

func TestForcedShutdownIsDiagnosable(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	}))
	defer srv.Close()
	defer close(release)
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, err := srv.Client().Get(srv.URL)
		if err == nil {
			response.Body.Close()
		}
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if !shutdownHTTP(ctx, srv.Config) {
		t.Fatal("active request was not forcibly closed")
	}
	<-done
	for _, want := range []string{`"event":"server_shutdown_failed"`, `"operation":"http.shutdown"`, `"error_code":"deadline_exceeded"`} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("missing shutdown diagnostic: %s", logs.String())
		}
	}
}

func TestCaptureWorkerSurvivesPanickedCapture(t *testing.T) {
	s, err := openTestStore(t, filepath.Join(t.TempDir(), "panic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bad, err := s.Create(ctx, store.Link{URL: "http://127.0.0.1/private-poison"})
	if err != nil {
		t.Fatal(err)
	}
	good, err := s.Create(ctx, store.Link{URL: "http://127.0.0.1/next"})
	if err != nil {
		t.Fatal(err)
	}
	log := &lockedLog{ready: make(chan struct{})}
	o := observability.New(slog.New(slog.NewJSONHandler(log, nil)), nil)
	fetch := func(_ context.Context, url string) (capture.Result, error) {
		if strings.Contains(url, "poison") {
			panic("private-panic-value " + url)
		}
		return capture.Result{Title: "Next"}, nil
	}
	done := make(chan struct{})
	go func() { defer close(done); captureWorker(ctx, s, o, fetch) }()
	select {
	case <-log.ready:
	case <-time.After(10 * time.Second):
		t.Error("worker did not capture the next link")
	}
	cancel()
	<-done
	output := log.String()
	if strings.Contains(output, "private-") {
		t.Fatalf("panic value or URL leaked: %s", output)
	}
	if n := strings.Count(output, `"event":"worker_panic"`); n != 1 {
		t.Fatalf("want one worker_panic record, got %d: %s", n, output)
	}
	if !strings.Contains(output, fmt.Sprintf(`"link_id":%d`, bad)) {
		t.Fatalf("worker_panic misses the link: %s", output)
	}
	link, err := s.Get(context.Background(), bad)
	if err != nil || link.Status != "failed" || !strings.Contains(link.Error, "internal error") {
		t.Fatalf("panicked link: %+v %v", link, err)
	}
	if link, err = s.Get(context.Background(), good); err != nil || link.Status != "ready" {
		t.Fatalf("next link: %+v %v", link, err)
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	if !strings.Contains(w.Body.String(), `pocketmark_worker_panics_total{worker="capture"} 1`) {
		t.Fatal("missing worker panic metric")
	}
}

// lockedLog collects worker output and signals the first successful capture.
type lockedLog struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	ready chan struct{}
	once  sync.Once
}

func (w *lockedLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if bytes.Contains(p, []byte(`"outcome":"ready"`)) {
		w.once.Do(func() { close(w.ready) })
	}
	return w.buf.Write(p)
}

func (w *lockedLog) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}
