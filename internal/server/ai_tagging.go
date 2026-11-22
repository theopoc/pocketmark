package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/store"
)

type taggingProvider interface {
	State(context.Context) (connected, registered bool, err error)
	Start(context.Context) (string, error)
	StartNew(context.Context) (string, error)
	Finish(context.Context, string) error
	Models(context.Context) ([]aitagprovider.Model, error)
	Test(context.Context, string) error
	Classify(context.Context, string, aitagprovider.Article, []string, func(context.Context) error) ([]string, error)
	Disconnect(context.Context) error
}

type aiTagging struct {
	provider taggingProvider
	wake     chan struct{}
	active   sync.Mutex
	cancel   context.CancelFunc
}

func (a *Server) registerAITagging(m *http.ServeMux) {
	a.aiTagging.provider = aitagprovider.New(a.Store, a.token)
	a.aiTagging.wake = make(chan struct{}, 1)
	m.HandleFunc("GET /api/ai-tagging", a.taggingSettings)
	m.HandleFunc("POST /api/ai-tagging/connect", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/finish", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/models", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/model", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/test", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/enable", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/pause", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/disconnect", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/scan", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/resume", a.taggingAction)
}

func (a *Server) taggingSettings(w http.ResponseWriter, r *http.Request) {
	state, err := a.Store.AITagStatus(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	var connected, registered bool
	connectionIssue := false
	if p := a.aiTagging.provider; p != nil {
		connected, registered, err = p.State(r.Context())
		connectionIssue = err != nil
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, map[string]any{
		"enabled": state.Enabled, "model": state.Model, "connected": connected, "registered": registered, "connectionIssue": connectionIssue,
		"eligible": state.Eligible, "hasTags": state.HasTags, "remaining": state.Remaining, "blocked": state.Blocked,
		"scan": map[string]any{"status": state.ScanStatus, "processed": state.ScanProcessed, "remaining": state.ScanRemaining, "reason": state.Blocked, "resumeAt": state.ResumeAt},
	})
}

func (a *Server) taggingAction(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	ran, err := a.Store.TryAITagSettings(ctx, func() {
		a.applyTaggingAction(w, r.WithContext(ctx))
	})
	if err != nil {
		handleError(w, err)
	} else if !ran {
		fail(w, 409, "Another AI tagging settings request is in progress")
	}
}

func (a *Server) applyTaggingAction(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := a.aiTagging.provider
	if p == nil {
		fail(w, 503, "ChatGPT plan connection unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var err error
	if r.URL.Path == "/api/ai-tagging/connect" || r.URL.Path == "/api/ai-tagging/finish" {
		if connected, _, readErr := p.State(ctx); connected || readErr != nil {
			fail(w, 409, "Disconnect the saved ChatGPT plan before starting a new connection")
			return
		}
	}
	switch r.URL.Path {
	case "/api/ai-tagging/connect":
		var body struct {
			NewAccount bool `json:"newAccount"`
		}
		if r.ContentLength != 0 && !decode(w, r, &body, 1024) {
			return
		}
		var u string
		if body.NewAccount {
			u, err = p.StartNew(ctx)
		} else {
			u, err = p.Start(ctx)
		}
		if err == nil {
			respond(w, 200, map[string]string{"url": u})
			return
		}
	case "/api/ai-tagging/finish":
		var body struct {
			Callback string `json:"callback"`
		}
		if !decode(w, r, &body, 16*1024) {
			return
		}
		// Clear activation before installing a session that could belong to a different account.
		if taggingStoreFailed(w, a.Store.SetAITagModel(ctx, "")) {
			return
		}
		a.aiTagging.stopActive()
		err = p.Finish(ctx, body.Callback)
	case "/api/ai-tagging/models":
		var models []aitagprovider.Model
		models, err = p.Models(ctx)
		if err == nil {
			respond(w, 200, map[string]any{"models": models})
			return
		}
	case "/api/ai-tagging/model":
		var body struct {
			Model string `json:"model"`
		}
		if !decode(w, r, &body, 1024) {
			return
		}
		state, e := a.Store.AITagStatus(ctx)
		if e != nil {
			handleError(w, e)
			return
		}
		if body.Model != "" && state.Model == body.Model {
			break
		}
		models, e := p.Models(ctx)
		if e != nil {
			providerFailure(w, e)
			return
		}
		if !slices.ContainsFunc(models, func(m aitagprovider.Model) bool { return m.ID == body.Model && m.ID != "" }) {
			fail(w, 400, "Choose a model available on this ChatGPT plan")
			return
		}
		if taggingStoreFailed(w, a.Store.SetAITagModel(ctx, body.Model)) {
			return
		}
		a.aiTagging.stopActive()
	case "/api/ai-tagging/test", "/api/ai-tagging/enable":
		state, e := a.Store.AITagStatus(ctx)
		if e != nil {
			handleError(w, e)
			return
		}
		connected, _, e := p.State(ctx)
		if e != nil || !connected || state.Model == "" {
			fail(w, 409, "Connect a ChatGPT plan and choose a model first")
			return
		}
		if r.URL.Path == "/api/ai-tagging/test" {
			err = p.Test(ctx, state.Model)
		} else if taggingStoreFailed(w, a.Store.SetAITagEnabled(ctx, true)) {
			return
		}
	case "/api/ai-tagging/pause":
		if taggingStoreFailed(w, a.Store.SetAITagEnabled(ctx, false)) {
			return
		}
		a.aiTagging.stopActive()
	case "/api/ai-tagging/disconnect":
		if taggingStoreFailed(w, a.Store.SetAITagModel(ctx, "")) {
			return
		}
		a.aiTagging.stopActive()
		err = p.Disconnect(ctx)
	case "/api/ai-tagging/scan":
		if taggingStoreFailed(w, a.Store.StartAITagScan(ctx)) {
			return
		}
	case "/api/ai-tagging/resume":
		if taggingStoreFailed(w, a.Store.ResumeAITagging(ctx)) {
			return
		}
	}
	if err != nil {
		providerFailure(w, err)
		return
	}
	a.aiTagging.notify()
	respond(w, 200, map[string]bool{"ok": true})
}

func taggingStoreFailed(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrAITagDisabled), errors.Is(err, store.ErrAITagScanActive), errors.Is(err, store.ErrAITagNoTags):
		fail(w, 409, err.Error())
	default:
		handleError(w, err)
	}
	return true
}

func providerFailure(w http.ResponseWriter, err error) {
	var quota *aitagprovider.QuotaError
	switch {
	case errors.As(err, &quota):
		fail(w, 429, "Your ChatGPT plan usage limit has been reached")
	case errors.Is(err, aitagprovider.ErrReconnect):
		fail(w, 409, "Reconnect your ChatGPT plan in settings")
	case errors.Is(err, aitagprovider.ErrCallback):
		fail(w, 400, "The return address is invalid or expired. Start the connection again")
	case errors.Is(err, aitagprovider.ErrRevocation):
		fail(w, 502, "Disconnected locally. Check connected apps in ChatGPT to revoke access")
	default:
		fail(w, 502, "AI tagging request failed. Check the connection and try again")
	}
}
