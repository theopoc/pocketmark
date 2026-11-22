package aitagprovider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type keyBackend struct {
	mu       sync.Mutex
	envelope []byte
}

func (b *keyBackend) ReadAIClaudeKey(context.Context) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.envelope), nil
}

func (b *keyBackend) WriteAIClaudeKey(_ context.Context, envelope []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.envelope = slices.Clone(envelope)
	return nil
}

const testKey = "sk-ant-fixture-key-0001"

func claudeClient(t *testing.T, handler mockTransport) (*Claude, *keyBackend) {
	t.Helper()
	backend := &keyBackend{}
	c := NewClaude(backend, "fictional-test-server-secret-32-bytes")
	c.http.Transport = handler
	return c, backend
}

func catalog() string {
	return jsonText(map[string]any{"data": []map[string]any{
		{"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "capabilities": map[string]any{"effort": map[string]bool{"supported": true}, "structured_outputs": map[string]bool{"supported": true}}},
		{"id": "claude-sonnet-5-5", "capabilities": map[string]any{"effort": map[string]bool{"supported": true}, "structured_outputs": map[string]bool{"supported": true}}},
		{"id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5", "capabilities": map[string]any{"effort": map[string]bool{"supported": false}, "structured_outputs": map[string]bool{"supported": true}}},
		{"id": "not-claude"},
	}})
}

func message(stop string, blocks ...map[string]string) string {
	content := make([]map[string]string, 0, len(blocks))
	content = append(content, blocks...)
	return jsonText(map[string]any{"stop_reason": stop, "content": content})
}

func TestClaudeConnectListsUsableModelsAndSealsKey(t *testing.T) {
	c, backend := claudeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" || r.URL.String() != claudeEndpoint+"/models?limit=1000" || r.Header.Get("x-api-key") != testKey || r.Header.Get("anthropic-version") != claudeVersion {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		return reply(200, catalog()), nil
	})
	if connected, err := c.State(t.Context()); connected || err != nil {
		t.Fatalf("fresh state: %v %v", connected, err)
	}
	models, err := c.Connect(t.Context(), " "+testKey+"\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []Model{{"claude-haiku-5-5", "Claude Haiku 5.5"}, {"claude-sonnet-5-5", "claude-sonnet-5-5"}}
	if !slices.Equal(models, want) {
		t.Fatalf("models: %v", models)
	}
	if bytes.Contains(backend.envelope, []byte("fixture-key")) {
		t.Fatal("API key is stored in plain text")
	}
	if connected, err := c.State(t.Context()); !connected || err != nil {
		t.Fatalf("state after connect: %v %v", connected, err)
	}
	// A different server secret cannot open the key.
	other := NewClaude(backend, "another-fictional-server-secret-32")
	if connected, err := other.State(t.Context()); connected || !errors.Is(err, ErrUnreadable) {
		t.Fatalf("foreign secret opened the key: %v %v", connected, err)
	}
	if err = c.Disconnect(t.Context()); err != nil || len(backend.envelope) != 0 {
		t.Fatalf("disconnect: %v", err)
	}
}

func TestClaudeConnectRejectsBadKeys(t *testing.T) {
	c, backend := claudeClient(t, func(*http.Request) (*http.Response, error) {
		return reply(401, `{"type":"error","error":{"type":"authentication_error"}}`), nil
	})
	for _, key := range []string{"", "short", "has space inside-key", strings.Repeat("k", 513), "clé-avec-accent-0001"} {
		if _, err := c.Connect(t.Context(), key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("%q: %v", key, err)
		}
	}
	if _, err := c.Connect(t.Context(), testKey); !errors.Is(err, ErrInvalidKey) || len(backend.envelope) != 0 {
		t.Fatalf("rejected key was saved: %v", err)
	}
}

func TestClaudeClassify(t *testing.T) {
	c, _ := claudeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/models" {
			return reply(200, catalog()), nil
		}
		if r.Method != "POST" || r.URL.String() != claudeEndpoint+"/messages" || r.Header.Get("x-api-key") != testKey || r.Header.Get("anthropic-version") != claudeVersion {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		var body struct {
			Model, System string
			MaxTokens     int `json:"max_tokens"`
			Messages      []struct{ Role, Content string }
			OutputConfig  struct {
				Effort string
				Format struct {
					Type   string
					Schema map[string]any
				}
			} `json:"output_config"`
			Temperature, Thinking any
			Stream                any
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "claude-haiku-5-5" || body.OutputConfig.Effort != "low" || body.OutputConfig.Format.Type != "json_schema" || body.OutputConfig.Format.Schema["type"] != "object" {
			t.Errorf("unexpected settings: %+v", body)
		}
		if body.Temperature != nil || body.Thinking != nil || body.Stream != nil || body.System != taggingInstructions || body.MaxTokens < 1024 {
			t.Errorf("unexpected parameters: %+v", body)
		}
		if len(body.Messages) != 1 || body.Messages[0].Role != "user" || strings.Contains(body.Messages[0].Content, "private-value") || !strings.Contains(body.Messages[0].Content, `"tags":["machine learning"]`) {
			t.Errorf("unexpected message: %+v", body.Messages)
		}
		return reply(200, message("end_turn", map[string]string{"type": "thinking", "thinking": ""}, map[string]string{"type": "text", "text": englishTags("machine learning", "unneeded")})), nil
	})
	if _, err := c.Connect(t.Context(), testKey); err != nil {
		t.Fatal(err)
	}
	sent := 0
	article := Article{Title: "A tutorial", Domain: "example.invalid", Description: "https://example.invalid/guide?key=private-value and some words"}
	tags, err := c.Classify(t.Context(), "claude-haiku-5-5", article, []string{"machine learning"}, func(context.Context) error { sent++; return nil })
	if err != nil || !slices.Equal(tags, []string{"machine learning"}) || sent != 1 {
		t.Fatalf("tags %v after %d guarded sends: %v", tags, sent, err)
	}
	// Nothing public to classify never reaches the provider.
	if tags, err = c.Classify(t.Context(), "claude-haiku-5-5", Article{Domain: "example.invalid"}, nil, nil); err != nil || len(tags) != 0 {
		t.Fatalf("empty article: %v %v", tags, err)
	}
	if _, err = c.Classify(t.Context(), "claude-haiku-5-5", Article{Title: "x", Domain: "a/b"}, nil, nil); !errors.Is(err, ErrArticleInput) {
		t.Fatalf("domain path accepted: %v", err)
	}
	stale := errors.New("stale")
	if _, err = c.Classify(t.Context(), "claude-haiku-5-5", article, nil, func(context.Context) error { return stale }); !errors.Is(err, stale) {
		t.Fatalf("guard ignored: %v", err)
	}
}

func TestClaudeClassifyFailures(t *testing.T) {
	text := map[string]string{"type": "text", "text": englishTags("astronomy")}
	for _, tt := range []struct {
		name   string
		status int
		header string
		body   string
		check  func(error) bool
	}{
		{"revoked key", 401, "", `{}`, func(err error) bool { return errors.Is(err, ErrReconnect) }},
		{"permission", 403, "", `{}`, func(err error) bool { return errors.Is(err, ErrReconnect) }},
		{"rate limit", 429, "30", `{}`, func(err error) bool {
			var q *QuotaError
			return errors.As(err, &q) && time.Until(q.RetryAt) > 20*time.Second
		}},
		{"billing", 402, "", `{}`, func(err error) bool { var q *QuotaError; return errors.As(err, &q) && q.RetryAt.IsZero() }},
		{"too large", 413, "", `{}`, func(err error) bool { return errors.Is(err, ErrArticleInput) }},
		{"server error", 529, "", `{}`, func(err error) bool { return errors.Is(err, errProvider) }},
		{"refusal", 200, "", message("refusal"), func(err error) bool { return errors.Is(err, ErrModelOutput) }},
		{"truncated", 200, "", message("max_tokens", text), func(err error) bool { return errors.Is(err, ErrModelOutput) }},
		{"no text", 200, "", message("end_turn"), func(err error) bool { return errors.Is(err, ErrModelOutput) }},
		{"bad json", 200, "", message("end_turn", map[string]string{"type": "text", "text": "not json"}), func(err error) bool { return errors.Is(err, ErrModelOutput) }},
		{"oversized answer", 200, "", message("end_turn", map[string]string{"type": "text", "text": strings.Repeat("x", 5000)}), func(err error) bool { return errors.Is(err, errInvalid) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := claudeClient(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/v1/models" {
					return reply(200, catalog()), nil
				}
				resp := reply(tt.status, tt.body)
				if tt.header != "" {
					resp.Header.Set("Retry-After", tt.header)
				}
				return resp, nil
			})
			if _, err := c.Connect(t.Context(), testKey); err != nil {
				t.Fatal(err)
			}
			_, err := c.Classify(t.Context(), "claude-haiku-5-5", Article{Title: "Stars", Domain: "example.invalid"}, nil, nil)
			if !tt.check(err) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestClaudeConnectionSample(t *testing.T) {
	c, _ := claudeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/models" {
			return reply(200, catalog()), nil
		}
		var body struct{ Messages []struct{ Content string } }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !strings.Contains(body.Messages[0].Content, "Découvrir l’astronomie") {
			t.Errorf("not the fictional sample: %v", err)
		}
		return reply(200, message("end_turn", map[string]string{"type": "text", "text": englishTags("astronomy")})), nil
	})
	if err := c.Test(t.Context(), "claude-haiku-5-5"); !errors.Is(err, ErrReconnect) {
		t.Fatalf("test without a key: %v", err)
	}
	if _, err := c.Connect(t.Context(), testKey); err != nil {
		t.Fatal(err)
	}
	if err := c.Test(t.Context(), "claude-haiku-5-5"); err != nil {
		t.Fatal(err)
	}
}
