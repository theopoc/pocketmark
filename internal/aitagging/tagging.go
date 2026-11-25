// Package aitagging owns AI tagging: the owner's settings for the selected AI
// tagging provider and the worker that classifies queued bookmarks.
package aitagging

import (
	"context"
	"errors"
	"slices"
	"sync"

	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/store"
)

// AI tagging providers.
const (
	ChatGPT = "chatgpt"
	Claude  = "claude"
)

// Classifier is the seam the worker and the settings use to talk to the
// selected AI tagging provider.
type Classifier interface {
	Models(ctx context.Context) ([]aitagprovider.Model, error)
	Test(ctx context.Context, model string) error
	// Classify calls beforeSend immediately before dispatching article data.
	Classify(ctx context.Context, model string, article aitagprovider.Article, tags []string, beforeSend func(context.Context) error) ([]string, error)
}

// ChatGPTPlan is a ChatGPT plan connected through OAuth.
type ChatGPTPlan interface {
	Classifier
	State(ctx context.Context) (connected, registered bool, err error)
	Start(ctx context.Context) (string, error)
	StartNew(ctx context.Context) (string, error)
	Finish(ctx context.Context, callback string) error
	Disconnect(ctx context.Context) error
}

// ClaudeKey is an Anthropic API key. The key never leaves the server.
type ClaudeKey interface {
	Classifier
	State(ctx context.Context) (connected bool, err error)
	Connect(ctx context.Context, apiKey string) ([]aitagprovider.Model, error)
	Disconnect(ctx context.Context) error
}

// Settings rules that refused an operation.
var (
	ErrBusy             = errors.New("another AI tagging settings request is in progress")
	ErrAlreadyConnected = errors.New("disconnect the saved provider before connecting another")
	ErrUnknownProvider  = errors.New("unknown AI tagging provider")
	ErrNotConnected     = errors.New("connect this provider first")
	ErrUnknownModel     = errors.New("model not available for this provider")
	ErrNoModel          = errors.New("connect a provider and choose a model first")
)

// RuleError reports which provider a refused settings operation concerned.
type RuleError struct {
	Err      error
	Provider string
}

func (e *RuleError) Error() string { return e.Provider + ": " + e.Err.Error() }
func (e *RuleError) Unwrap() error { return e.Err }

// ProviderError is a failure reported by the AI tagging provider itself.
type ProviderError struct {
	Err      error
	Provider string
}

func (e *ProviderError) Error() string { return e.Provider + ": " + e.Err.Error() }
func (e *ProviderError) Unwrap() error { return e.Err }

func refused(err error, provider string) error { return &RuleError{err, provider} }
func failed(err error, provider string) error {
	if err == nil {
		return nil
	}
	return &ProviderError{err, provider}
}

// Tagging is the AI tagging module. Settings operations are serialized across
// replicas; any change that could invalidate a running classification cancels
// it before returning.
type Tagging struct {
	store   *store.Store
	chatgpt ChatGPTPlan
	claude  ClaudeKey
	wake    chan struct{}
	active  sync.Mutex
	cancel  context.CancelFunc
}

// New builds the module. Both providers are required.
func New(s *store.Store, chatgpt ChatGPTPlan, claude ClaudeKey) *Tagging {
	if s == nil || chatgpt == nil || claude == nil {
		panic("aitagging: store and both providers are required")
	}
	return &Tagging{store: s, chatgpt: chatgpt, claude: claude, wake: make(chan struct{}, 1)}
}

// Status is what the owner sees in AI tagging settings.
type Status struct {
	store.AITagStatus
	// ChatGPT plan connection.
	Connected, Registered, ConnectionIssue bool
	ClaudeConnected, ClaudeIssue           bool
}

func (t *Tagging) Status(ctx context.Context) (Status, error) {
	state, err := t.store.AITagStatus(ctx)
	if err != nil {
		return Status{}, err
	}
	s := Status{AITagStatus: state}
	var e error
	s.Connected, s.Registered, e = t.chatgpt.State(ctx)
	s.ConnectionIssue = e != nil
	s.ClaudeConnected, e = t.claude.State(ctx)
	s.ClaudeIssue = e != nil
	return s, nil
}

// settings runs op under the settings lock with the current state. A
// successful op wakes the worker when notify is set.
func (t *Tagging) settings(ctx context.Context, notify bool, op func(store.AITagStatus) error) error {
	var err error
	ran, lockErr := t.store.TryAITagSettings(ctx, func() {
		state, e := t.store.AITagStatus(ctx)
		if e != nil {
			err = e
			return
		}
		err = op(state)
	})
	switch {
	case lockErr != nil:
		return lockErr
	case !ran:
		return ErrBusy
	case err == nil && notify:
		t.Notify()
	}
	return err
}

func (t *Tagging) classifier(provider string) Classifier {
	if provider == Claude {
		return t.claude
	}
	return t.chatgpt
}

func (t *Tagging) connected(ctx context.Context, provider string) (bool, error) {
	if provider == Claude {
		return t.claude.State(ctx)
	}
	ok, _, err := t.chatgpt.State(ctx)
	return ok, err
}

func validProvider(provider string) bool { return provider == ChatGPT || provider == Claude }

// StartChatGPT returns the OAuth address that links a ChatGPT plan.
func (t *Tagging) StartChatGPT(ctx context.Context, newAccount bool) (string, error) {
	var u string
	err := t.settings(ctx, false, func(store.AITagStatus) error {
		if connected, readErr := t.connected(ctx, ChatGPT); connected || readErr != nil {
			return refused(ErrAlreadyConnected, ChatGPT)
		}
		var err error
		if newAccount {
			u, err = t.chatgpt.StartNew(ctx)
		} else {
			u, err = t.chatgpt.Start(ctx)
		}
		return failed(err, ChatGPT)
	})
	return u, err
}

// FinishChatGPT installs the ChatGPT plan returned to callback and selects it.
func (t *Tagging) FinishChatGPT(ctx context.Context, callback string) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if connected, readErr := t.connected(ctx, ChatGPT); connected || readErr != nil {
			return refused(ErrAlreadyConnected, ChatGPT)
		}
		// Clear activation before installing a session that could belong to a different account.
		// A failed attempt must not disturb Claude tagging, which does not use that session.
		if state.Provider == ChatGPT {
			if err := t.store.SetAITagModel(ctx, ""); err != nil {
				return err
			}
			t.stopActive()
		}
		if err := t.chatgpt.Finish(ctx, callback); err != nil {
			return failed(err, ChatGPT)
		}
		// Switching providers clears the model and the leases.
		if err := t.store.SetAITagProvider(ctx, ChatGPT); err != nil {
			return err
		}
		t.stopActive()
		return nil
	})
}

// ConnectClaude saves an Anthropic API key and selects Claude.
func (t *Tagging) ConnectClaude(ctx context.Context, apiKey string) error {
	return t.settings(ctx, true, func(store.AITagStatus) error {
		if connected, readErr := t.connected(ctx, Claude); connected || readErr != nil {
			return refused(ErrAlreadyConnected, Claude)
		}
		models, err := t.claude.Connect(ctx, apiKey)
		if err != nil {
			return failed(err, Claude)
		}
		if err = t.store.SetAITagProvider(ctx, Claude); err != nil {
			return err
		}
		if err = t.preselectClaudeModel(ctx, models); err != nil {
			return err
		}
		t.stopActive()
		return nil
	})
}

// SelectProvider switches to another connected provider. A change clears the
// model and pauses AI tagging.
func (t *Tagging) SelectProvider(ctx context.Context, provider string) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if !validProvider(provider) {
			return refused(ErrUnknownProvider, provider)
		}
		if provider == state.Provider {
			return nil
		}
		if connected, err := t.connected(ctx, provider); err != nil || !connected {
			return refused(ErrNotConnected, provider)
		}
		if err := t.store.SetAITagProvider(ctx, provider); err != nil {
			return err
		}
		t.stopActive()
		if provider == Claude {
			// The owner can still pick a model when the catalog is unavailable.
			if models, listErr := t.claude.Models(ctx); listErr == nil {
				return t.preselectClaudeModel(ctx, models)
			}
		}
		return nil
	})
}

// preselectClaudeModel applies the default model when none is chosen.
func (t *Tagging) preselectClaudeModel(ctx context.Context, models []aitagprovider.Model) error {
	state, err := t.store.AITagStatus(ctx)
	if err != nil || state.Model != "" || state.Provider != Claude {
		return err
	}
	if slices.ContainsFunc(models, func(m aitagprovider.Model) bool { return m.ID == aitagprovider.DefaultClaudeModel }) {
		return t.store.SetAITagModel(ctx, aitagprovider.DefaultClaudeModel)
	}
	return nil
}

// Models lists the models of the selected provider.
func (t *Tagging) Models(ctx context.Context) ([]aitagprovider.Model, error) {
	var models []aitagprovider.Model
	err := t.settings(ctx, false, func(state store.AITagStatus) error {
		var err error
		models, err = t.classifier(state.Provider).Models(ctx)
		return failed(err, state.Provider)
	})
	return models, err
}

// SelectModel chooses one of the selected provider's models.
func (t *Tagging) SelectModel(ctx context.Context, model string) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if model != "" && state.Model == model {
			return nil
		}
		models, err := t.classifier(state.Provider).Models(ctx)
		if err != nil {
			return failed(err, state.Provider)
		}
		if !slices.ContainsFunc(models, func(m aitagprovider.Model) bool { return m.ID == model && m.ID != "" }) {
			return refused(ErrUnknownModel, state.Provider)
		}
		if err = t.store.SetAITagModel(ctx, model); err != nil {
			return err
		}
		t.stopActive()
		return nil
	})
}

// ready checks that the selected provider is connected and has a model.
func (t *Tagging) ready(ctx context.Context, state store.AITagStatus) error {
	if connected, err := t.connected(ctx, state.Provider); err != nil || !connected || state.Model == "" {
		return refused(ErrNoModel, state.Provider)
	}
	return nil
}

// Test classifies a fictional example with the selected model.
func (t *Tagging) Test(ctx context.Context) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if err := t.ready(ctx, state); err != nil {
			return err
		}
		return failed(t.classifier(state.Provider).Test(ctx, state.Model), state.Provider)
	})
}

// Enable turns on automatic tagging of new untagged bookmarks.
func (t *Tagging) Enable(ctx context.Context) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if err := t.ready(ctx, state); err != nil {
			return err
		}
		return t.store.SetAITagEnabled(ctx, true)
	})
}

// Pause stops tagging while keeping the provider connected.
func (t *Tagging) Pause(ctx context.Context) error {
	return t.settings(ctx, true, func(store.AITagStatus) error {
		if err := t.store.SetAITagEnabled(ctx, false); err != nil {
			return err
		}
		t.stopActive()
		return nil
	})
}

// Disconnect removes a provider's credentials; an empty provider means the
// selected one. Disconnecting a provider that is not selected leaves tagging
// running.
func (t *Tagging) Disconnect(ctx context.Context, provider string) error {
	return t.settings(ctx, true, func(state store.AITagStatus) error {
		if provider == "" {
			provider = state.Provider
		} else if !validProvider(provider) {
			return refused(ErrUnknownProvider, provider)
		}
		if provider == state.Provider {
			if err := t.store.SetAITagModel(ctx, ""); err != nil {
				return err
			}
			t.stopActive()
		}
		if provider == Claude {
			return failed(t.claude.Disconnect(ctx), Claude)
		}
		return failed(t.chatgpt.Disconnect(ctx), ChatGPT)
	})
}

// Scan queues every untagged website bookmark.
func (t *Tagging) Scan(ctx context.Context) error {
	return t.settings(ctx, true, func(store.AITagStatus) error { return t.store.StartAITagScan(ctx) })
}

// Resume continues after a provider limit or connection problem.
func (t *Tagging) Resume(ctx context.Context) error {
	return t.settings(ctx, true, func(store.AITagStatus) error { return t.store.ResumeAITagging(ctx) })
}
