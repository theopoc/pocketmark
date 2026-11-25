package aitagging_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"pocketmark/internal/aitagging"
	"pocketmark/internal/aitagprovider"
	"pocketmark/internal/pgtest"
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

type testClaudeProvider struct {
	connected bool
	articles  []aitagprovider.Article
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
	return []aitagprovider.Model{{ID: aitagprovider.DefaultClaudeModel, Name: "Claude Haiku 5.5"}, {ID: "claude-sonnet-5-5", Name: "Claude Sonnet 5.5"}}, nil
}
func (p *testClaudeProvider) Test(context.Context, string) error { return nil }
func (p *testClaudeProvider) Classify(_ context.Context, model string, article aitagprovider.Article, _ []string, beforeSend func(context.Context) error) ([]string, error) {
	if !p.connected || (model != aitagprovider.DefaultClaudeModel && model != "claude-sonnet-5-5") {
		return nil, errors.New("unexpected classification request")
	}
	if err := beforeSend(context.Background()); err != nil {
		return nil, err
	}
	p.articles = append(p.articles, article)
	return []string{"machine learning"}, nil
}

func openStore(t *testing.T, path string) *store.Store {
	t.Helper()
	s, err := store.Open(pgtest.URL(t, path), pgtest.Directory(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	return openStore(t, filepath.Join(t.TempDir(), "library.db"))
}

func create(t *testing.T, s *store.Store, l store.Link) int64 {
	t.Helper()
	id, err := s.Create(t.Context(), l)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func status(t *testing.T, s *store.Store) store.AITagStatus {
	t.Helper()
	st, err := s.AITagStatus(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func checkTags(t *testing.T, s *store.Store, id int64, expected ...string) {
	t.Helper()
	l, err := s.Get(t.Context(), id)
	if err != nil || !slices.Equal(l.Tags, expected) {
		t.Fatalf("bookmark %d tags %v, expected %v: %v", id, l.Tags, expected, err)
	}
}

func refusedWith(t *testing.T, err, rule error) {
	t.Helper()
	var r *aitagging.RuleError
	if !errors.As(err, &r) || !errors.Is(err, rule) {
		t.Fatalf("expected %v, got %v", rule, err)
	}
}

func providerFailed(t *testing.T, err, cause error) {
	t.Helper()
	var p *aitagging.ProviderError
	if !errors.As(err, &p) || !errors.Is(err, cause) {
		t.Fatalf("expected provider failure %v, got %v", cause, err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestSettingsSerializeAcrossInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replica.db")
	firstStore, secondStore := openStore(t, path), openStore(t, path)
	p := &waitingModelProvider{started: make(chan struct{}), proceed: make(chan struct{})}
	first := aitagging.New(firstStore, p, &testClaudeProvider{})
	second := aitagging.New(secondStore, &testTagProvider{}, &testClaudeProvider{})
	finished := make(chan error, 1)
	go func() { finished <- first.SelectModel(t.Context(), "fixture") }()
	select {
	case <-p.started:
	case err := <-finished:
		t.Fatalf("model request ended before validation: %v", err)
	case <-time.After(10 * time.Second):
		close(p.proceed)
		t.Fatal("model validation did not start")
	}
	rejected := second.Disconnect(t.Context(), "")
	close(p.proceed)
	if err := <-finished; err != nil {
		t.Fatalf("select model: %v", err)
	}
	if !errors.Is(rejected, aitagging.ErrBusy) {
		t.Fatalf("overlapping settings change: %v", rejected)
	}
	ctx := t.Context()
	create(t, firstStore, store.Link{URL: "https://example.org/tag", Tags: []string{"Machine Learning"}})
	must(t, firstStore.SetAITagEnabled(ctx, true))
	create(t, firstStore, store.Link{URL: "https://example.org/pending", Title: "Waiting for refresh"})
	p.afterRefresh = func() { must(t, second.Pause(ctx)) }
	if err := first.RunOnce(ctx); err != nil || len(p.articles) != 0 {
		t.Fatalf("paused job sent article after token refresh: %v", err)
	}
	must(t, second.Disconnect(ctx, ""))
}

func TestWorkerChecksRemainingVocabularyBeforeCreating(t *testing.T) {
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
			s := newStore(t)
			for group := range 8 {
				var names []string
				for ordinal := range 32 {
					names = append(names, fmt.Sprintf("catalog%03d", group*32+ordinal))
				}
				create(t, s, store.Link{URL: fmt.Sprintf("https://fixture.example/%d", group), Tags: names})
			}
			create(t, s, store.Link{URL: "https://fixture.example/rare", Tags: []string{"k8s"}})
			must(t, s.SetAITagModel(ctx, "fixture"))
			must(t, s.SetAITagEnabled(ctx, true))
			id := create(t, s, store.Link{URL: "https://example.org/article", Title: "Kubernetes deployment"})
			provider := &testTagProvider{}
			tagging := aitagging.New(s, provider, &testClaudeProvider{})
			provider.selection = func(names []string) ([]string, error) {
				if len(provider.vocabularies) == 1 {
					if len(names) != 256 || slices.Contains(names, "k8s") {
						t.Fatal("unexpected first page")
					}
					if tt.pause {
						must(t, s.SetAITagEnabled(ctx, false))
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
			must(t, tagging.RunOnce(ctx))
			link, err := s.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			state := status(t, s)
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

func TestSettingsCreationAndManualScan(t *testing.T) {
	ctx := t.Context()
	s := newStore(t)
	p := &testTagProvider{}
	tagging := aitagging.New(s, p, &testClaudeProvider{})
	old := create(t, s, store.Link{URL: "https://example.org/before", Title: "A tutorial"})
	refusedWith(t, tagging.Enable(ctx), aitagging.ErrNoModel)
	if u, err := tagging.StartChatGPT(ctx, false); err != nil || u == "" {
		t.Fatal(u, err)
	}
	must(t, tagging.FinishChatGPT(ctx, "sample return address"))
	if _, err := tagging.Models(ctx); err != nil {
		t.Fatal(err)
	}
	refusedWith(t, tagging.SelectModel(ctx, "unknown"), aitagging.ErrUnknownModel)
	must(t, tagging.SelectModel(ctx, "fixture"))
	must(t, tagging.Test(ctx))
	if !p.tested || len(p.articles) != 0 {
		t.Fatal("testing the connection used a bookmark")
	}
	must(t, tagging.Enable(ctx))
	fresh := create(t, s, store.Link{URL: "https://example.org/new?private=abc", Title: "New article", Notes: "Owner notes"})
	must(t, tagging.RunOnce(ctx))
	if len(p.articles) != 1 || p.articles[0] != (aitagprovider.Article{Title: "New article", Domain: "example.org"}) {
		t.Fatal("unexpected information sent for classification")
	}
	checkTags(t, s, fresh, "machine learning")
	if len(p.vocabularies[0]) != 0 {
		t.Fatalf("expected an empty vocabulary for the first classification: %v", p.vocabularies[0])
	}
	checkTags(t, s, old)
	must(t, tagging.Scan(ctx))
	p.quota = true
	must(t, tagging.RunOnce(ctx))
	if state := status(t, s); state.ScanStatus != "paused" || state.Blocked != "quota" || state.ScanRemaining != 1 {
		t.Fatal(state)
	}
	must(t, tagging.Resume(ctx))
	p.quota = false
	must(t, tagging.RunOnce(ctx))
	checkTags(t, s, old, "machine learning")
	if len(p.vocabularies) != 2 || !slices.Equal(p.vocabularies[1], []string{"machine learning"}) {
		t.Fatalf("the scan did not receive the tag created for the new bookmark: %v", p.vocabularies)
	}
	tag := create(t, s, store.Link{URL: "https://example.org/tag", Tags: []string{"Machine Learning", "machine learning"}})
	checkTags(t, s, tag, "machine learning")
	skipped := create(t, s, store.Link{URL: "https://example.org/skipped", Title: "Ambiguous article"})
	after := create(t, s, store.Link{URL: "https://example.org/after", Title: "Another tutorial"})
	p.nextError = aitagprovider.ErrModelOutput
	for range 2 {
		must(t, tagging.RunOnce(ctx))
	}
	checkTags(t, s, skipped)
	checkTags(t, s, after, "machine learning")
	if err := tagging.RunOnce(ctx); !errors.Is(err, aitagging.ErrIdle) {
		t.Fatalf("empty queue: %v", err)
	}
	must(t, tagging.Pause(ctx))
	must(t, tagging.Disconnect(ctx, ""))
	if state := status(t, s); p.connected || state.Model != "" || state.Enabled {
		t.Fatal(state)
	}
}

func TestClaudeProviderSelectionAndWorker(t *testing.T) {
	ctx := t.Context()
	s := newStore(t)
	chatgpt, claude := &testTagProvider{}, &testClaudeProvider{}
	tagging := aitagging.New(s, chatgpt, claude)
	providerFailed(t, tagging.ConnectClaude(ctx, "rejected"), aitagprovider.ErrInvalidKey)
	if st := status(t, s); st.Provider != "chatgpt" || st.Model != "" {
		t.Fatalf("a rejected key changed settings: %+v", st)
	}
	must(t, tagging.ConnectClaude(ctx, "sk-ant-fixture-key"))
	if st := status(t, s); st.Provider != "claude" || st.Model != aitagprovider.DefaultClaudeModel {
		t.Fatalf("Haiku 5.5 was not preselected: %+v", st)
	}
	if st, err := tagging.Status(ctx); err != nil || st.Provider != "claude" || !st.ClaudeConnected {
		t.Fatalf("settings: %+v %v", st, err)
	}
	refusedWith(t, tagging.SelectProvider(ctx, "chatgpt"), aitagging.ErrNotConnected)
	refusedWith(t, tagging.SelectModel(ctx, "unknown"), aitagging.ErrUnknownModel)
	must(t, tagging.SelectModel(ctx, "claude-sonnet-5-5"))
	must(t, tagging.SelectModel(ctx, "claude-haiku-5-5"))
	must(t, tagging.Test(ctx))
	must(t, tagging.Enable(ctx))
	id := create(t, s, store.Link{URL: "https://example.org/claude", Title: "Neural networks"})
	must(t, tagging.RunOnce(ctx))
	if got, err := s.Get(ctx, id); err != nil || !slices.Equal(got.Tags, []string{"machine learning"}) || len(claude.articles) != 1 || len(chatgpt.articles) != 0 {
		t.Fatalf("Claude did not classify the bookmark: %v %v", got.Tags, err)
	}
	// A rejected ChatGPT return address must not disturb the running Claude setup.
	providerFailed(t, tagging.FinishChatGPT(ctx, ""), aitagprovider.ErrCallback)
	if st := status(t, s); st.Provider != "claude" || st.Model != aitagprovider.DefaultClaudeModel || !st.Enabled {
		t.Fatalf("a failed ChatGPT connection changed Claude settings: %+v", st)
	}
	refusedWith(t, tagging.ConnectClaude(ctx, "sk-ant-fixture-key"), aitagging.ErrAlreadyConnected)
	// Linking ChatGPT switches provider and pauses until a model is chosen again.
	if _, err := tagging.StartChatGPT(ctx, false); err != nil {
		t.Fatal(err)
	}
	must(t, tagging.FinishChatGPT(ctx, "sample return address"))
	if st := status(t, s); st.Provider != "chatgpt" || st.Model != "" || st.Enabled {
		t.Fatalf("ChatGPT connection kept the Claude model: %+v", st)
	}
	must(t, tagging.SelectProvider(ctx, "claude"))
	if st := status(t, s); st.Provider != "claude" || st.Model != aitagprovider.DefaultClaudeModel || st.Enabled {
		t.Fatalf("switching back: %+v", st)
	}
	must(t, tagging.Disconnect(ctx, "chatgpt"))
	if st := status(t, s); st.Model != aitagprovider.DefaultClaudeModel || chatgpt.connected {
		t.Fatalf("disconnecting the idle provider changed the active one: %+v", st)
	}
	must(t, tagging.Disconnect(ctx, "claude"))
	if st := status(t, s); st.Model != "" || claude.connected {
		t.Fatalf("disconnecting Claude kept the model: %+v", st)
	}
	refusedWith(t, tagging.SelectProvider(ctx, "other"), aitagging.ErrUnknownProvider)
}
