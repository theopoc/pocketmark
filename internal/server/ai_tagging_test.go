package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/aitagging"
	"pocketmark/internal/aitagprovider"
)

// AI tagging rules are covered by internal/aitagging. These tests check the
// HTTP mapping: routes, status codes, messages and the creation wakeup.

type testTagProvider struct {
	connected bool
	testErr   error
	started   chan struct{}
	proceed   chan struct{}
}

func (p *testTagProvider) State(context.Context) (bool, bool, error) {
	return p.connected, p.connected, nil
}
func (p *testTagProvider) Start(context.Context) (string, error) {
	return "https://auth.openai.com/", nil
}
func (p *testTagProvider) StartNew(ctx context.Context) (string, error) { return p.Start(ctx) }
func (p *testTagProvider) Finish(_ context.Context, callback string) error {
	if callback == "" {
		return aitagprovider.ErrCallback
	}
	p.connected = true
	return nil
}
func (p *testTagProvider) Models(ctx context.Context) ([]aitagprovider.Model, error) {
	if p.started != nil {
		close(p.started)
		select {
		case <-p.proceed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return []aitagprovider.Model{{ID: "fixture", Name: "Fixture model"}}, nil
}
func (p *testTagProvider) Test(context.Context, string) error { return p.testErr }
func (p *testTagProvider) Disconnect(context.Context) error   { p.connected = false; return nil }
func (p *testTagProvider) Classify(ctx context.Context, _ string, _ aitagprovider.Article, _ []string, beforeSend func(context.Context) error) ([]string, error) {
	if err := beforeSend(ctx); err != nil {
		return nil, err
	}
	return []string{"machine learning"}, nil
}

type testClaudeProvider struct {
	connected bool
	testErr   error
}

func (p *testClaudeProvider) State(context.Context) (bool, error) { return p.connected, nil }
func (p *testClaudeProvider) Connect(_ context.Context, key string) ([]aitagprovider.Model, error) {
	if key != "sk-ant-fixture-key" {
		return nil, aitagprovider.ErrInvalidKey
	}
	p.connected = true
	return p.Models(context.Background())
}
func (p *testClaudeProvider) Disconnect(context.Context) error { p.connected = false; return nil }
func (p *testClaudeProvider) Models(context.Context) ([]aitagprovider.Model, error) {
	return []aitagprovider.Model{{ID: aitagprovider.DefaultClaudeModel, Name: "Claude Haiku 5.5"}}, nil
}
func (p *testClaudeProvider) Test(context.Context, string) error { return p.testErr }
func (p *testClaudeProvider) Classify(context.Context, string, aitagprovider.Article, []string, func(context.Context) error) ([]string, error) {
	return nil, errors.New("unexpected classification request")
}

func requireFailure(t *testing.T, w *httptest.ResponseRecorder, status int, message string) {
	t.Helper()
	requireStatus(t, w, status)
	var body struct{ Error string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error != message {
		t.Fatalf("message %q, expected %q: %v", body.Error, message, err)
	}
}

func TestAITagSettingsSerializeAcrossServers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replica.db")
	replica := func() *testServer {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return wrapTestServer(t, New(s, testToken, "", false), path)
	}
	first, second := replica(), replica()
	p := &testTagProvider{started: make(chan struct{}), proceed: make(chan struct{})}
	first.tagging = aitagging.New(first.Store, p, &testClaudeProvider{})
	second.tagging = aitagging.New(second.Store, &testTagProvider{}, &testClaudeProvider{})
	finished := make(chan int, 1)
	go func() {
		finished <- request(first, "POST", "/api/ai-tagging/model", `{"model":"fixture"}`, true, nil).Code
	}()
	select {
	case <-p.started:
	case status := <-finished:
		t.Fatalf("model request ended before validation: %d", status)
	case <-time.After(10 * time.Second):
		close(p.proceed)
		t.Fatal("model validation did not start")
	}
	rejected := request(second, "POST", "/api/ai-tagging/disconnect", "", true, nil)
	close(p.proceed)
	if status := <-finished; status != 200 {
		t.Fatalf("select model: %d", status)
	}
	requireFailure(t, rejected, 409, "Another AI tagging settings request is in progress")
}

func TestAITagSettingsRoutesAndCreationWakeup(t *testing.T) {
	a := newTestServer(t, "", false)
	p := &testTagProvider{}
	a.tagging = aitagging.New(a.Store, p, &testClaudeProvider{})
	post := func(action, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		w := request(a, "POST", "/api/ai-tagging/"+action, body, true, nil)
		requireStatus(t, w, want)
		return w
	}
	requireStatus(t, request(a, "GET", "/api/ai-tagging", "", false, nil), 401)
	requireFailure(t, request(a, "POST", "/api/ai-tagging/enable", "", true, nil), 409, "Connect a provider and choose a model first")
	if w := post("connect", "", 200); !strings.Contains(w.Body.String(), `"url":"https://auth.openai.com/"`) {
		t.Fatalf("connect: %s", w.Body)
	}
	requireFailure(t, request(a, "POST", "/api/ai-tagging/finish", `{"callback":""}`, true, nil), 400, "The return address is invalid or expired. Start the connection again")
	post("finish", `{"callback":"sample return address"}`, 200)
	requireFailure(t, request(a, "POST", "/api/ai-tagging/connect", "", true, nil), 409, "Disconnect the saved ChatGPT plan before starting a new connection")
	requireFailure(t, request(a, "POST", "/api/ai-tagging/finish", `{"callback":"again"}`, true, nil), 409, "Disconnect the saved ChatGPT plan before starting a new connection")
	if w := post("models", "", 200); !strings.Contains(w.Body.String(), `"fixture"`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("models: %s", w.Body)
	}
	requireFailure(t, request(a, "POST", "/api/ai-tagging/model", `{"model":"unknown"}`, true, nil), 400, "Choose a model available on this ChatGPT plan")
	post("model", `{"model":"fixture"}`, 200)
	post("test", "", 200)
	post("enable", "", 200)
	post("scan", "", 200)
	post("resume", "", 200)

	// Creating an untagged bookmark wakes an idle worker before its next poll.
	ctx, stop := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); a.AITagWorker(ctx, false) }()
	defer func() { stop(); <-done }()
	time.Sleep(300 * time.Millisecond)
	w := request(a, "POST", "/api/links", `{"url":"https://example.org/new","title":"New article"}`, true, nil)
	requireStatus(t, w, 201)
	var created struct{ ID int64 }
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		l, err := a.Store.Get(t.Context(), created.ID)
		if err == nil && slices.Equal(l.Tags, []string{"machine learning"}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the new bookmark did not wake the worker: %v %v", l.Tags, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	post("pause", "", 200)
	post("disconnect", "", 200)
	requireFailure(t, request(a, "POST", "/api/ai-tagging/scan", "", true, nil), 409, "enable AI tagging first")
}

func TestAITagClaudeRoutes(t *testing.T) {
	a := newTestServer(t, "", false)
	a.tagging = aitagging.New(a.Store, &testTagProvider{}, &testClaudeProvider{})
	post := func(action, body string, want int) {
		t.Helper()
		requireStatus(t, request(a, "POST", "/api/ai-tagging/"+action, body, true, nil), want)
	}
	requireFailure(t, request(a, "POST", "/api/ai-tagging/connect-claude", `{"apiKey":"rejected"}`, true, nil), 400, "Anthropic did not accept this API key")
	post("connect-claude", `{"apiKey":"sk-ant-fixture-key"}`, 200)
	w := request(a, "GET", "/api/ai-tagging", "", true, nil)
	requireStatus(t, w, 200)
	var settings struct {
		Provider string
		Model    string
		Claude   struct{ Connected bool }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &settings); err != nil || settings.Provider != "claude" || settings.Model != aitagprovider.DefaultClaudeModel || !settings.Claude.Connected {
		t.Fatalf("settings: %s %v", w.Body, err)
	}
	if strings.Contains(w.Body.String(), "fixture-key") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("settings returned the API key or allowed caching")
	}
	requireFailure(t, request(a, "POST", "/api/ai-tagging/provider", `{"provider":"chatgpt"}`, true, nil), 409, "Connect this provider first")
	requireFailure(t, request(a, "POST", "/api/ai-tagging/model", `{"model":"unknown"}`, true, nil), 400, "Choose a model available for this API key")
	requireFailure(t, request(a, "POST", "/api/ai-tagging/connect-claude", `{"apiKey":"sk-ant-fixture-key"}`, true, nil), 409, "Disconnect the saved API key before saving another")
	requireFailure(t, request(a, "POST", "/api/ai-tagging/provider", `{"provider":"other"}`, true, nil), 400, "Choose ChatGPT or Claude")
	requireFailure(t, request(a, "POST", "/api/ai-tagging/disconnect", `{"provider":"other"}`, true, nil), 400, "Choose ChatGPT or Claude")
	post("disconnect", `{"provider":"claude"}`, 200)
}

func TestAITagProviderFailureMessages(t *testing.T) {
	for _, tt := range []struct {
		claude  bool
		err     error
		status  int
		message string
	}{
		{false, &aitagprovider.QuotaError{}, 429, "Your ChatGPT plan usage limit has been reached"},
		{true, &aitagprovider.QuotaError{}, 429, "Your Anthropic API rate or spending limit has been reached"},
		{false, aitagprovider.ErrReconnect, 409, "Reconnect your ChatGPT plan in settings"},
		{true, aitagprovider.ErrReconnect, 409, "Replace your Anthropic API key in settings"},
		{true, aitagprovider.ErrInvalidKey, 400, "Anthropic did not accept this API key"},
		{false, aitagprovider.ErrRevocation, 502, "Disconnected locally. Check connected apps in ChatGPT to revoke access"},
		{false, errors.New("network"), 502, "AI tagging request failed. Check the connection and try again"},
	} {
		a := newTestServer(t, "", false)
		chatgpt, claude := &testTagProvider{connected: true}, &testClaudeProvider{connected: true}
		a.tagging = aitagging.New(a.Store, chatgpt, claude)
		model := "fixture"
		if tt.claude {
			requireStatus(t, request(a, "POST", "/api/ai-tagging/provider", `{"provider":"claude"}`, true, nil), 200)
			claude.testErr = tt.err
			model = aitagprovider.DefaultClaudeModel
		} else {
			chatgpt.testErr = tt.err
		}
		requireStatus(t, request(a, "POST", "/api/ai-tagging/model", `{"model":"`+model+`"}`, true, nil), 200)
		requireFailure(t, request(a, "POST", "/api/ai-tagging/test", "", true, nil), tt.status, tt.message)
	}
}
