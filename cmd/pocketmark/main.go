package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/server"
	"pocketmark/internal/store"
)

func main() {
	if e := run(); e != nil {
		log.Fatal(e)
	}
}
func run() error {
	addr := flag.String("listen", env("POCKETMARK_LISTEN", "127.0.0.1:8090"), "HTTP listen address")
	data := flag.String("data", env("POCKETMARK_DATA", "./data"), "data directory")
	noCapture := flag.Bool("no-capture", os.Getenv("POCKETMARK_CAPTURE") == "false", "disable background page capture")
	flag.Parse()
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
		log.Printf("Access token file: %s", path)
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
	done := make(chan struct{})
	if !*noCapture {
		go func() { defer close(done); worker(ctx, s) }()
	} else {
		close(done)
	}
	handler := server.New(s, token, origin, os.Getenv("POCKETMARK_SECURE_COOKIE") == "true" || strings.HasPrefix(origin, "https://"))
	srv := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("Pocketmark listening at http://%s (data: %s)", *addr, dir)
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
func worker(ctx context.Context, s *store.Store) {
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
			log.Printf("capture queue: %v", e)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}
		result, fetchErr := capture.Fetch(ctx, l.URL)
		if ctx.Err() != nil {
			return
		} // processing jobs are recovered at the next start.
		if e = s.Finish(ctx, l, result.Title, result.Description, result.Content, result.HTML, fetchErr); e != nil {
			log.Printf("save capture %d: %v", l.ID, e)
		}
	}
}
