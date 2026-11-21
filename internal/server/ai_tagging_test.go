package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/store"
)

type testTagProvider struct {
	connected    bool
	tested       bool
	quota        bool
	nextError    error
	articles     []aitagprovider.Article
	afterRefresh func()
}

// Model validation may have to wait for the provider. Another replica must
// not change the account between validation and saving the model.
type waitingModelProvider struct {
	testTagProvider
	started chan struct{}
	proceed chan struct{}
}

func (p *waitingModelProvider) Models(ctx context.Context) ([]aitagprovider.Model, error) {
	close(p.started)
	select {
	case <-p.proceed:
		return p.testTagProvider.Models(ctx)
	case <-ctx.Done():
		return nil, ctx.Err()
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
	p := &waitingModelProvider{started: make(chan struct{}), proceed: make(chan struct{})}
	first.aiTagging.provider = p
	second.aiTagging.provider = &testTagProvider{}
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
	requireStatus(t, rejected, 409)
	ctx := t.Context()
	if _, err := first.Store.Create(ctx, store.Link{URL: "https://example.org/tag", Tags: []string{"Machine Learning"}}); err != nil {
		t.Fatal(err)
	}
	if err := first.Store.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Store.Create(ctx, store.Link{URL: "https://example.org/pending", Title: "Waiting for refresh"}); err != nil {
		t.Fatal(err)
	}
	p.afterRefresh = func() {
		requireStatus(t, request(second, "POST", "/api/ai-tagging/pause", "", true, nil), 200)
	}
	if err := first.workAITag(ctx, false); err != nil || len(p.articles) != 0 {
		t.Fatalf("paused job sent article after token refresh: %v", err)
	}
	requireStatus(t, request(second, "POST", "/api/ai-tagging/disconnect", "", true, nil), 200)
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
func (p *testTagProvider) Models(context.Context) ([]aitagprovider.Model, error) {
	return []aitagprovider.Model{{ID: "fixture", Name: "Fixture model"}}, nil
}
func (p *testTagProvider) Test(context.Context, string) error { p.tested = true; return nil }
func (p *testTagProvider) Disconnect(context.Context) error   { p.connected = false; return nil }
func (p *testTagProvider) Classify(ctx context.Context, model string, article aitagprovider.Article, tags []string, beforeSend func(context.Context) error) ([]string, error) {
	if model != "fixture" || !slices.Contains(tags, "machine learning") {
		return nil, errors.New("unexpected classification request")
	}
	if p.afterRefresh != nil {
		p.afterRefresh()
	}
	if err := beforeSend(ctx); err != nil {
		return nil, err
	}
	if p.quota {
		return nil, &aitagprovider.QuotaError{}
	}
	if p.nextError != nil {
		err := p.nextError
		p.nextError = nil
		return nil, err
	}
	p.articles = append(p.articles, article)
	return []string{"machine learning"}, nil
}

func TestAITagSettingsCreationAndManualScan(t *testing.T) {
	ctx := context.Background()
	a := newTestServer(t, "", false)
	p := &testTagProvider{}
	a.aiTagging.provider = p
	post := func(action, body string, want int) {
		t.Helper()
		requireStatus(t, request(a, "POST", "/api/ai-tagging/"+action, body, true, nil), want)
	}
	link := func(body string) store.Link {
		t.Helper()
		w := request(a, "POST", "/api/links", body, true, nil)
		requireStatus(t, w, 201)
		var l store.Link
		if err := json.Unmarshal(w.Body.Bytes(), &l); err != nil {
			t.Fatal(err)
		}
		return l
	}
	tag := link(`{"url":"https://example.org/tag","tags":["Machine Learning","machine learning"]}`)
	if !slices.Equal(tag.Tags, []string{"machine learning"}) {
		t.Fatalf("canonical tags: %v", tag.Tags)
	}
	old := link(`{"url":"https://example.org/before","title":"A tutorial"}`)
	requireStatus(t, request(a, "GET", "/api/ai-tagging", "", false, nil), 401)
	post("enable", "", 409)
	post("connect", "", 200)
	post("finish", `{"callback":"sample return address"}`, 200)
	post("models", "", 200)
	post("model", `{"model":"unknown"}`, 400)
	post("model", `{"model":"fixture"}`, 200)
	post("test", "", 200)
	if !p.tested || len(p.articles) != 0 {
		t.Fatal("testing the connection used a bookmark")
	}
	post("enable", "", 200)
	fresh := link(`{"url":"https://example.org/new?private=abc","title":"New article","notes":"Owner notes"}`)
	if err := a.workAITag(ctx, false); err != nil {
		t.Fatal(err)
	}
	if len(p.articles) != 1 || p.articles[0] != (aitagprovider.Article{Title: "New article", Domain: "example.org"}) {
		t.Fatal("unexpected information sent for classification")
	}
	check := func(id int64, expected ...string) {
		t.Helper()
		l, err := a.Store.Get(ctx, id)
		if err != nil || !slices.Equal(l.Tags, expected) {
			t.Fatalf("bookmark %d tags %v, expected %v: %v", id, l.Tags, expected, err)
		}
	}
	check(fresh.ID, "machine learning")
	check(old.ID)
	post("scan", "", 200)
	p.quota = true
	if err := a.workAITag(ctx, false); err != nil {
		t.Fatal(err)
	}
	state, err := a.Store.AITagStatus(ctx)
	if err != nil || state.ScanStatus != "paused" || state.Blocked != "quota" || state.ScanRemaining != 1 {
		t.Fatal(state, err)
	}
	post("resume", "", 200)
	p.quota = false
	if err := a.workAITag(ctx, false); err != nil {
		t.Fatal(err)
	}
	check(old.ID, "machine learning")
	skipped := link(`{"url":"https://example.org/skipped","title":"Ambiguous article"}`)
	after := link(`{"url":"https://example.org/after","title":"Another tutorial"}`)
	p.nextError = aitagprovider.ErrModelOutput
	for range 2 {
		if err := a.workAITag(ctx, false); err != nil {
			t.Fatal(err)
		}
	}
	check(skipped.ID)
	check(after.ID, "machine learning")
	post("pause", "", 200)
	post("disconnect", "", 200)
	state, err = a.Store.AITagStatus(ctx)
	if err != nil || p.connected || state.Model != "" || state.Enabled {
		t.Fatal(state, err)
	}
}
