package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	vocabularies [][]string
	afterRefresh func()
	selection    func([]string) ([]string, error)
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
	if model != "fixture" {
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
	p.vocabularies = append(p.vocabularies, slices.Clone(tags))
	if p.selection != nil {
		return p.selection(tags)
	}
	return []string{"machine learning"}, nil
}

func TestAITagWorkerChecksRemainingVocabularyBeforeCreating(t *testing.T) {
	for _, tt := range []struct {
		name, lastSelection, wantTag string
		quota, pause, exact          bool
	}{
		{name: "reuse late synonym", lastSelection: "k8s", wantTag: "k8s"},
		{name: "reuse exact fallback from a later page", exact: true, wantTag: "k8s"},
		{name: "use first fallback after all pages", lastSelection: "technology", wantTag: "kubernetes"},
		{name: "later quota preserves pending work", quota: true},
		{name: "pause prevents next dispatch", pause: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx := t.Context()
			a := newTestServer(t, "", false)
			create := func(l store.Link) int64 {
				t.Helper()
				id, err := a.Store.Create(ctx, l)
				if err != nil {
					t.Fatal(err)
				}
				return id
			}
			for group := range 8 {
				var names []string
				for ordinal := range 32 {
					names = append(names, fmt.Sprintf("catalog%03d", group*32+ordinal))
				}
				create(store.Link{URL: fmt.Sprintf("https://fixture.example/%d", group), Tags: names})
			}
			create(store.Link{URL: "https://fixture.example/rare", Tags: []string{"k8s"}})
			if err := a.Store.SetAITagModel(ctx, "fixture"); err != nil {
				t.Fatal(err)
			}
			if err := a.Store.SetAITagEnabled(ctx, true); err != nil {
				t.Fatal(err)
			}
			id := create(store.Link{URL: "https://example.org/article", Title: "Kubernetes deployment"})
			provider := &testTagProvider{}
			a.aiTagging.provider = provider
			provider.selection = func(names []string) ([]string, error) {
				if len(provider.vocabularies) == 1 {
					if len(names) != 256 || slices.Contains(names, "k8s") {
						t.Fatal("unexpected first page")
					}
					if tt.pause {
						if err := a.Store.SetAITagEnabled(ctx, false); err != nil {
							t.Fatal(err)
						}
					}
					if tt.exact {
						return []string{"k8s", "kubernetes"}, nil
					}
					return []string{"kubernetes"}, nil
				}
				if !slices.Equal(names, []string{"k8s"}) {
					t.Fatalf("remaining candidates: %v", names)
				}
				if tt.quota {
					return nil, &aitagprovider.QuotaError{}
				}
				return []string{tt.lastSelection}, nil
			}
			if err := a.workAITag(ctx, false); err != nil {
				t.Fatal(err)
			}
			link, err := a.Store.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			state, err := a.Store.AITagStatus(ctx)
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case tt.pause:
				if len(link.Tags) != 0 || len(provider.articles) != 1 || state.Enabled || state.Remaining != 1 {
					t.Fatalf("paused classification: %v, %d dispatches, %+v", link.Tags, len(provider.articles), state)
				}
			case tt.quota:
				if len(link.Tags) != 0 || state.Blocked != "quota" || state.Remaining != 1 {
					t.Fatalf("interrupted classification: %v, %+v", link.Tags, state)
				}
			default:
				wantCalls := 2
				if tt.exact {
					wantCalls = 1
				}
				if !slices.Equal(link.Tags, []string{tt.wantTag}) || len(provider.articles) != wantCalls || state.Remaining != 0 {
					t.Fatalf("completed classification: %v, %d dispatches, %+v", link.Tags, len(provider.articles), state)
				}
			}
		})
	}
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
	if len(p.vocabularies[0]) != 0 {
		t.Fatalf("expected an empty vocabulary for the first classification: %v", p.vocabularies[0])
	}
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
	if len(p.vocabularies) != 2 || !slices.Equal(p.vocabularies[1], []string{"machine learning"}) {
		t.Fatalf("the scan did not receive the tag created for the new bookmark: %v", p.vocabularies)
	}
	tag := link(`{"url":"https://example.org/tag","tags":["Machine Learning","machine learning"]}`)
	check(tag.ID, "machine learning")
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
