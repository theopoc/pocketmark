package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/observability"
	"pocketmark/internal/server"
	"pocketmark/internal/store"
)

func main() {
	if err := observability.ConfigureLogging(os.Stderr, os.Getenv("POCKETMARK_LOG_LEVEL")); err != nil {
		observability.ConfigureLogging(os.Stderr, "INFO")
		slog.Error("logging_configuration_failed", "error", err.Error())
		os.Exit(1)
	}
	if e := run(); e != nil {
		observability.Error(context.Background(), "process_failed", e)
		os.Exit(1)
	}
}
func run() error {
	addr := flag.String("listen", env("POCKETMARK_LISTEN", "127.0.0.1:8090"), "HTTP listen address")
	data := flag.String("data", env("POCKETMARK_DATA", "./data"), "data directory")
	noCapture := flag.Bool("no-capture", os.Getenv("POCKETMARK_CAPTURE") == "false", "disable background page capture")
	flag.Parse()
	rate, err := strconv.Atoi(env("POCKETMARK_RATE_LIMIT", "10"))
	if err != nil {
		return errors.New("POCKETMARK_RATE_LIMIT must be an integer")
	}
	burst, err := strconv.Atoi(env("POCKETMARK_RATE_BURST", "100"))
	if err != nil {
		return errors.New("POCKETMARK_RATE_BURST must be an integer")
	}
	traceConfig, err := observability.TraceConfigFromEnv()
	if err != nil {
		slog.Error("telemetry_configuration_failed", "error", err.Error())
		return err
	}
	// A soft Go heap budget, not an RSS cap; SQLite/native allocations are separate.
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(32 * 1024 * 1024)
	}
	debug.SetGCPercent(50)
	dir, e := filepath.Abs(*data)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	token := strings.TrimSpace(os.Getenv("POCKETMARK_TOKEN"))
	if token == "" {
		path := filepath.Join(dir, "access-token")
		raw, e := os.ReadFile(path)
		if errors.Is(e, os.ErrNotExist) {
			buf := make([]byte, 32)
			if _, e = rand.Read(buf); e != nil {
				return e
			}
			token = hex.EncodeToString(buf)
			f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if e != nil {
				return e
			}
			_, e = f.WriteString(token + "\n")
			closeErr := f.Close()
			if e != nil {
				return e
			}
			if closeErr != nil {
				return closeErr
			}
		} else if e != nil {
			return e
		} else {
			token = strings.TrimSpace(string(raw))
		}
	}
	if len(token) < 24 {
		return errors.New("access token must contain at least 24 characters")
	}
	origin := os.Getenv("POCKETMARK_ORIGIN")
	if e = server.ValidateOrigin(origin); e != nil {
		return e
	}
	s, e := store.Open(filepath.Join(dir, "pocketmark.db"))
	if e != nil {
		return e
	}
	defer s.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	observer := observability.New(slog.Default(), nil)
	shutdownTracing, e := observer.EnableTracing(ctx, traceConfig)
	if e != nil {
		return e
	}
	defer func() {
		flush, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := shutdownTracing(flush); err != nil {
			observability.Error(flush, "trace_shutdown_failed", err)
		}
	}()
	done := make(chan struct{})
	if !*noCapture {
		go func() { defer close(done); worker(ctx, s, observer) }()
	} else {
		close(done)
	}
	handler := server.New(s, token, origin, os.Getenv("POCKETMARK_SECURE_COOKIE") == "true" || strings.HasPrefix(origin, "https://"), observer)
	if e = handler.SetRateLimit(rate, burst); e != nil {
		return e
	}
	if e = handler.SetTrustedProxies(os.Getenv("POCKETMARK_TRUSTED_PROXIES")); e != nil {
		return e
	}
	srv := &http.Server{Addr: *addr, Handler: handler, ErrorLog: observability.HTTPErrorLog(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("server_started", "listen", *addr, "capture_enabled", !*noCapture, "otel_enabled", traceConfig.Enabled)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case e = <-errCh:
		stop()
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		srv.Close()
	}
	<-done
	slog.Info("server_stopped")
	if e != nil && !errors.Is(e, http.ErrServerClosed) {
		return fmt.Errorf("HTTP server: %w", e)
	}
	return nil
}
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func worker(ctx context.Context, s *store.Store, observer *observability.Observer) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		l, e := s.Next(ctx)
		if errors.Is(e, sql.ErrNoRows) {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}
		if e != nil {
			if ctx.Err() != nil {
				return
			}
			observer.QueueError(ctx, e)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}
		captureCtx, finish := observer.Capture(ctx, l.ID)
		result, fetchErr := capture.Fetch(captureCtx, l.URL)
		if ctx.Err() != nil {
			finish(fetchErr, nil)
			return
		} // processing jobs are recovered at the next start.
		e = s.Finish(captureCtx, l, result.Title, result.Description, result.Content, result.HTML, fetchErr)
		finish(fetchErr, e)
	}
}
