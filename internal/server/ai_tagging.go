package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"pocketmark/internal/aitagging"
	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/store"
)

func (a *Server) registerAITagging(m *http.ServeMux) {
	a.tagging = aitagging.New(a.Store, aitagprovider.New(a.Store, a.token), aitagprovider.NewClaude(a.Store, a.token), a.observer)
	m.HandleFunc("GET /api/ai-tagging", a.taggingSettings)
	ok := map[string]bool{"ok": true}
	m.HandleFunc("POST /api/ai-tagging/connect", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			NewAccount bool `json:"newAccount"`
		}
		if r.ContentLength != 0 && !decode(w, r, &body, 1024) {
			return nil, nil
		}
		u, err := a.tagging.StartChatGPT(r.Context(), body.NewAccount)
		return map[string]string{"url": u}, err
	}))
	m.HandleFunc("POST /api/ai-tagging/finish", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			Callback string `json:"callback"`
		}
		if !decode(w, r, &body, 16*1024) {
			return nil, nil
		}
		return ok, a.tagging.FinishChatGPT(r.Context(), body.Callback)
	}))
	m.HandleFunc("POST /api/ai-tagging/connect-claude", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			APIKey string `json:"apiKey"`
		}
		if !decode(w, r, &body, 4096) {
			return nil, nil
		}
		return ok, a.tagging.ConnectClaude(r.Context(), body.APIKey)
	}))
	m.HandleFunc("POST /api/ai-tagging/provider", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			Provider string `json:"provider"`
		}
		if !decode(w, r, &body, 1024) {
			return nil, nil
		}
		return ok, a.tagging.SelectProvider(r.Context(), body.Provider)
	}))
	m.HandleFunc("POST /api/ai-tagging/models", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		models, err := a.tagging.Models(r.Context())
		return map[string]any{"models": models}, err
	}))
	m.HandleFunc("POST /api/ai-tagging/model", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			Model string `json:"model"`
		}
		if !decode(w, r, &body, 1024) {
			return nil, nil
		}
		return ok, a.tagging.SelectModel(r.Context(), body.Model)
	}))
	m.HandleFunc("POST /api/ai-tagging/test", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		return ok, a.tagging.Test(r.Context())
	}))
	m.HandleFunc("POST /api/ai-tagging/enable", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		return ok, a.tagging.Enable(r.Context())
	}))
	m.HandleFunc("POST /api/ai-tagging/pause", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		return ok, a.tagging.Pause(r.Context())
	}))
	m.HandleFunc("POST /api/ai-tagging/disconnect", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		var body struct {
			Provider string `json:"provider"`
		}
		if r.ContentLength != 0 && !decode(w, r, &body, 1024) {
			return nil, nil
		}
		return ok, a.tagging.Disconnect(r.Context(), body.Provider)
	}))
	m.HandleFunc("POST /api/ai-tagging/scan", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		return ok, a.tagging.Scan(r.Context())
	}))
	m.HandleFunc("POST /api/ai-tagging/resume", a.taggingAction(func(w http.ResponseWriter, r *http.Request) (any, error) {
		return ok, a.tagging.Resume(r.Context())
	}))
}

// AITagWorker classifies queued bookmarks until ctx ends.
func (a *Server) AITagWorker(ctx context.Context, captureEnabled bool) {
	a.tagging.Start(ctx, captureEnabled)
}

func (a *Server) taggingSettings(w http.ResponseWriter, r *http.Request) {
	state, err := a.tagging.Status(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, map[string]any{
		"provider": state.Provider, "claude": map[string]bool{"connected": state.ClaudeConnected, "connectionIssue": state.ClaudeIssue},
		"enabled": state.Enabled, "model": state.Model, "connected": state.Connected, "registered": state.Registered, "connectionIssue": state.ConnectionIssue,
		"eligible": state.Eligible, "hasTags": state.HasTags, "remaining": state.Remaining, "blocked": state.Blocked,
		"scan": map[string]any{"status": state.ScanStatus, "processed": state.ScanProcessed, "remaining": state.ScanRemaining, "reason": state.Blocked, "resumeAt": state.ResumeAt},
	})
}

// taggingAction runs one settings operation. A nil result with a nil error
// means the operation already responded, for instance to an invalid body.
func (a *Server) taggingAction(op func(http.ResponseWriter, *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		w.Header().Set("Cache-Control", "no-store")
		result, err := op(w, r.WithContext(ctx))
		switch {
		case err != nil:
			taggingFailure(w, err)
		case result != nil:
			respond(w, 200, result)
		}
	}
}

func taggingFailure(w http.ResponseWriter, err error) {
	var provider *aitagging.ProviderError
	var rule *aitagging.RuleError
	switch {
	case errors.As(err, &provider):
		providerFailure(w, provider.Err, provider.Provider)
	case errors.Is(err, aitagging.ErrBusy):
		fail(w, 409, "Another AI tagging settings request is in progress")
	case errors.As(err, &rule):
		switch {
		case errors.Is(rule, aitagging.ErrAlreadyConnected) && rule.Provider == aitagging.Claude:
			fail(w, 409, "Disconnect the saved API key before saving another")
		case errors.Is(rule, aitagging.ErrAlreadyConnected):
			fail(w, 409, "Disconnect the saved ChatGPT plan before starting a new connection")
		case errors.Is(rule, aitagging.ErrUnknownProvider):
			fail(w, 400, "Choose ChatGPT or Claude")
		case errors.Is(rule, aitagging.ErrNotConnected):
			fail(w, 409, "Connect this provider first")
		case errors.Is(rule, aitagging.ErrUnknownModel):
			fail(w, 400, "Choose a model available "+providerAccount(rule.Provider))
		default:
			fail(w, 409, "Connect a provider and choose a model first")
		}
	case errors.Is(err, store.ErrAITagDisabled), errors.Is(err, store.ErrAITagScanActive):
		fail(w, 409, err.Error())
	default:
		handleError(w, err)
	}
}

func providerAccount(provider string) string {
	if provider == aitagging.Claude {
		return "for this API key"
	}
	return "on this ChatGPT plan"
}

func providerFailure(w http.ResponseWriter, err error, provider string) {
	var quota *aitagprovider.QuotaError
	claude := provider == aitagging.Claude
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
