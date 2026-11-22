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

// claudeProvider classifies with an Anthropic API key. Its key never leaves the server.
type claudeProvider interface {
	State(context.Context) (connected bool, err error)
	Connect(context.Context, string) ([]aitagprovider.Model, error)
	Disconnect(context.Context) error
	Models(context.Context) ([]aitagprovider.Model, error)
	Test(context.Context, string) error
	Classify(context.Context, string, aitagprovider.Article, []string, func(context.Context) error) ([]string, error)
}

type classifier interface {
	Models(context.Context) ([]aitagprovider.Model, error)
	Test(context.Context, string) error
	Classify(context.Context, string, aitagprovider.Article, []string, func(context.Context) error) ([]string, error)
}

type aiTagging struct {
	provider taggingProvider
	claude   claudeProvider
	wake     chan struct{}
	active   sync.Mutex
	cancel   context.CancelFunc
}

func (a *Server) registerAITagging(m *http.ServeMux) {
	a.aiTagging.provider = aitagprovider.New(a.Store, a.token)
	a.aiTagging.claude = aitagprovider.NewClaude(a.Store, a.token)
	a.aiTagging.wake = make(chan struct{}, 1)
	m.HandleFunc("GET /api/ai-tagging", a.taggingSettings)
	m.HandleFunc("POST /api/ai-tagging/connect", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/finish", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/connect-claude", a.taggingAction)
	m.HandleFunc("POST /api/ai-tagging/provider", a.taggingAction)
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
	var claudeConnected, claudeIssue bool
	if c := a.aiTagging.claude; c != nil {
		var claudeErr error
		claudeConnected, claudeErr = c.State(r.Context())
		claudeIssue = claudeErr != nil
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, map[string]any{
		"provider": state.Provider, "claude": map[string]bool{"connected": claudeConnected, "connectionIssue": claudeIssue},
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
	p, c := a.aiTagging.provider, a.aiTagging.claude
	if p == nil || c == nil {
		fail(w, 503, "AI tagging provider unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	state, e := a.Store.AITagStatus(ctx)
	if e != nil {
		handleError(w, e)
		return
	}
	provider := state.Provider
	// The selected provider answers model, test and enable requests.
	active := func() (classifier, bool, error) {
		if provider == "claude" {
			ok, err := c.State(ctx)
			return c, ok, err
		}
		ok, _, err := p.State(ctx)
		return p, ok, err
	}
	var err error
	if r.URL.Path == "/api/ai-tagging/connect" || r.URL.Path == "/api/ai-tagging/finish" {
		provider = "chatgpt"
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
		if err = p.Finish(ctx, body.Callback); err == nil && taggingStoreFailed(w, a.Store.SetAITagProvider(ctx, "chatgpt")) {
			return
		}
	case "/api/ai-tagging/connect-claude":
		var body struct {
			APIKey string `json:"apiKey"`
		}
		if !decode(w, r, &body, 4096) {
			return
		}
		provider = "claude"
		var models []aitagprovider.Model
		if models, err = c.Connect(ctx, body.APIKey); err == nil {
			if state.Provider != "claude" {
				a.aiTagging.stopActive()
			}
			if taggingStoreFailed(w, a.Store.SetAITagProvider(ctx, "claude")) || taggingStoreFailed(w, a.preselectClaudeModel(ctx, models)) {
				return
			}
		}
	case "/api/ai-tagging/provider":
		var body struct {
			Provider string `json:"provider"`
		}
		if !decode(w, r, &body, 1024) {
			return
		}
		if body.Provider != "chatgpt" && body.Provider != "claude" {
			fail(w, 400, "Choose ChatGPT or Claude")
			return
		}
		provider = body.Provider
		if provider == state.Provider {
			break
		}
		var connected bool
		if provider == "claude" {
			connected, e = c.State(ctx)
		} else {
			connected, _, e = p.State(ctx)
		}
		if e != nil || !connected {
			fail(w, 409, "Connect this provider first")
			return
		}
		if taggingStoreFailed(w, a.Store.SetAITagProvider(ctx, provider)) {
			return
		}
		a.aiTagging.stopActive()
		if provider == "claude" {
			// The owner can still pick a model when the catalog is unavailable.
			if models, listErr := c.Models(ctx); listErr == nil && taggingStoreFailed(w, a.preselectClaudeModel(ctx, models)) {
				return
			}
		}
	case "/api/ai-tagging/models":
		var models []aitagprovider.Model
		cl, _, _ := active()
		models, err = cl.Models(ctx)
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
		if body.Model != "" && state.Model == body.Model {
			break
		}
		cl, _, _ := active()
		models, e := cl.Models(ctx)
		if e != nil {
			providerFailure(w, e, provider)
			return
		}
		if !slices.ContainsFunc(models, func(m aitagprovider.Model) bool { return m.ID == body.Model && m.ID != "" }) {
			fail(w, 400, "Choose a model available "+providerAccount(provider))
			return
		}
		if taggingStoreFailed(w, a.Store.SetAITagModel(ctx, body.Model)) {
			return
		}
		a.aiTagging.stopActive()
	case "/api/ai-tagging/test", "/api/ai-tagging/enable":
		cl, connected, e := active()
		if e != nil || !connected || state.Model == "" {
			fail(w, 409, "Connect a provider and choose a model first")
			return
		}
		if r.URL.Path == "/api/ai-tagging/test" {
			err = cl.Test(ctx, state.Model)
		} else if taggingStoreFailed(w, a.Store.SetAITagEnabled(ctx, true)) {
			return
		}
	case "/api/ai-tagging/pause":
		if taggingStoreFailed(w, a.Store.SetAITagEnabled(ctx, false)) {
			return
		}
		a.aiTagging.stopActive()
	case "/api/ai-tagging/disconnect":
		var body struct {
			Provider string `json:"provider"`
		}
		if r.ContentLength != 0 && !decode(w, r, &body, 1024) {
			return
		}
		if body.Provider != "" {
			if body.Provider != "chatgpt" && body.Provider != "claude" {
				fail(w, 400, "Choose ChatGPT or Claude")
				return
			}
			provider = body.Provider
		}
		// Disconnecting a provider that is not selected leaves tagging running.
		if provider == state.Provider {
			if taggingStoreFailed(w, a.Store.SetAITagModel(ctx, "")) {
				return
			}
			a.aiTagging.stopActive()
		}
		if provider == "claude" {
			err = c.Disconnect(ctx)
		} else {
			err = p.Disconnect(ctx)
		}
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
		providerFailure(w, err, provider)
		return
	}
	a.aiTagging.notify()
	respond(w, 200, map[string]bool{"ok": true})
}

// preselectClaudeModel applies the default model when none is chosen.
func (a *Server) preselectClaudeModel(ctx context.Context, models []aitagprovider.Model) error {
	state, err := a.Store.AITagStatus(ctx)
	if err != nil || state.Model != "" || state.Provider != "claude" {
		return err
	}
	if slices.ContainsFunc(models, func(m aitagprovider.Model) bool { return m.ID == aitagprovider.DefaultClaudeModel }) {
		return a.Store.SetAITagModel(ctx, aitagprovider.DefaultClaudeModel)
	}
	return nil
}

func providerAccount(provider string) string {
	if provider == "claude" {
		return "for this API key"
	}
	return "on this ChatGPT plan"
}

func taggingStoreFailed(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrAITagDisabled), errors.Is(err, store.ErrAITagScanActive):
		fail(w, 409, err.Error())
	default:
		handleError(w, err)
	}
	return true
}

func providerFailure(w http.ResponseWriter, err error, provider string) {
	var quota *aitagprovider.QuotaError
	claude := provider == "claude"
	switch {
	case errors.As(err, &quota):
		if claude {
			fail(w, 429, "Your Anthropic API rate or spending limit has been reached")
		} else {
			fail(w, 429, "Your ChatGPT plan usage limit has been reached")
		}
	case errors.Is(err, aitagprovider.ErrInvalidKey):
		fail(w, 400, "Anthropic did not accept this API key")
	case errors.Is(err, aitagprovider.ErrReconnect) && claude:
		fail(w, 409, "Replace your Anthropic API key in settings")
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
