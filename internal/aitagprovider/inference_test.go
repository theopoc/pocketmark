package aitagprovider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func stream(answer string) string {
	return "data: " + jsonText(map[string]string{"type": "response.output_text.delta", "delta": answer}) + "\n\n" +
		"data: " + jsonText(map[string]string{"type": "response.completed"}) + "\n\n"
}

func englishTags(names ...string) string {
	tags := make([]map[string]string, 0, len(names))
	for _, name := range names {
		tags = append(tags, map[string]string{"name": name, "language": "en"})
	}
	return jsonText(map[string]any{"tags": tags})
}

func TestConnectionSampleRequestsJSONInInput(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", Refresh: "session", Access: "valid", Expires: time.Now().Add(time.Hour)})
	c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
		var body struct {
			Input []struct{ Role, Content string }
			Text  struct{ Format struct{ Type string } }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Text.Format.Type != "json_object" {
			t.Fatal("expected JSON object mode")
		}
		// Responses validates input messages before generation, even with top-level instructions.
		for _, message := range body.Input {
			if message.Role == "user" && strings.Contains(message.Content, "JSON") {
				if !strings.Contains(message.Content, "Découvrir l’astronomie") || !strings.Contains(message.Content, `"tags":["astronomie","astronomy"]`) {
					t.Fatal("expected a fictional French article with French and English vocabulary")
				}
				return reply(200, stream(englishTags("astronomy"))), nil
			}
		}
		return reply(200, "data: {\"type\":\"error\",\"code\":\"invalid_request_error\",\"param\":\"input\"}\n\n"), nil
	})
	if err := c.Test(t.Context(), "sample-model"); err != nil {
		t.Fatalf("fictional bookmark failed the connection test: %v", err)
	}
}

func TestClassify(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", Refresh: "session", Access: "valid", Expires: time.Now().Add(time.Hour)})
	ctx := context.Background()
	article := Article{Title: "A tutorial", Domain: "example.invalid", Description: "https://example.invalid/guide?key=private-value and some words"}
	tags := []string{"one", "machine learning", strings.Repeat("ⱥ", 40)}
	result := stream(englishTags("machine learning", "one", "unneeded"))
	calls := 0
	c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != resource+"/responses" || r.Header.Get("Authorization") != "Bearer valid" {
			t.Error("unexpected request")
		}
		var request struct {
			Input               []struct{ Role, Content string }
			Model, Instructions string
			Store               *bool
			Stream              bool
			Tools               []any
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if len(request.Input) != 1 || request.Input[0].Role != "user" || !request.Stream || request.Store == nil || *request.Store || len(request.Tools) != 0 || strings.Contains(request.Input[0].Content, "private-value") {
			t.Error("request exposed unsupported settings or URL parameters")
		}
		return reply(200, result), nil
	})
	out, err := c.Classify(ctx, "available", article, tags, nil)
	if err != nil || !slices.Equal(out, []string{"machine learning", "one"}) {
		t.Fatalf("got %v, %v", out, err)
	}
	if _, err := c.Classify(ctx, "available", Article{Domain: article.Domain}, tags, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("sent a request for a domain alone")
	}
	if _, err := c.Classify(ctx, "available", Article{Domain: strings.Repeat("x", 256), Title: "article"}, tags, nil); !errors.Is(err, ErrArticleInput) || calls != 1 {
		t.Fatal("invalid bookmark did not produce a local article-specific error")
	}
	for _, invalid := range []string{`{}`, `{"indices":[0],"newTags":[]}`, `{"tags":[null]}`, `{"tags":["one"]}`, englishTags("one", "two", "three", "four")} {
		result = stream(invalid)
		if _, err := c.Classify(ctx, "available", article, tags, nil); !errors.Is(err, ErrModelOutput) {
			t.Fatalf("accepted %s, %v", invalid, err)
		}
	}
}

func TestClassifyFallback(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", Refresh: "session", Access: "valid", Expires: time.Now().Add(time.Hour)})
	article := Article{Title: "Déployer une application avec des agents IA", Domain: "example.invalid"}
	for _, tc := range []struct {
		name       string
		vocabulary []string
		answer     string
		want       []string
	}{
		{"empty vocabulary", nil, englishTags("  CI/CD  ", "ci/cd", "AI agents"), []string{"ci/cd", "ai agents"}},
		{"unrelated vocabulary", []string{"music"}, englishTags("AWS", "machine learning"), []string{"aws", "machine learning"}},
		{"translate French vocabulary", []string{"agents ia", "développement logiciel"}, englishTags("AI agents", "software development"), []string{"ai agents", "software development"}},
		{"existing English synonym first", []string{"agents ia", "agentic software"}, englishTags("ai agents", "AGENTIC SOFTWARE"), []string{"agentic software"}},
		{"mixed reply reuses existing English", []string{"astronomie", "astronomy"},
			`{"tags":[{"name":"astronomie","language":"fr"},{"name":"astronomy","language":"en"},{"name":"stars","language":"en"}]}`, []string{"astronomy"}},
		{"mixed reply creates English fallback", []string{"agents ia"},
			`{"tags":[{"name":"agents ia","language":"fr"},{"name":"AI Agents","language":"en"}]}`, []string{"ai agents"}},
		{"reuse existing punctuation", []string{"tools: ci"}, englishTags("tools: ci"), []string{"tools: ci"}},
		{"no identifiable topic", nil, englishTags(), []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, guards := 0, 0
			c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if guards != 1 {
					t.Fatal("sent bookmark before checking owner consent")
				}
				var request struct{ Instructions string }
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				for _, rule := range []string{"lowercase English", "existing English tags", "Translate foreign-language topics into English"} {
					if !strings.Contains(request.Instructions, rule) {
						t.Fatalf("missing language instruction %q", rule)
					}
				}
				return reply(200, stream(tc.answer)), nil
			})
			result, err := c.Classify(t.Context(), "available", article, tc.vocabulary, func(context.Context) error {
				guards++
				return nil
			})
			if err != nil || calls != 1 || !slices.Equal(result, tc.want) {
				t.Fatalf("selection=%v calls=%d err=%v", result, calls, err)
			}
		})
	}
}

func TestInvalidTagProposals(t *testing.T) {
	for _, answer := range []string{
		`{"tags":null}`, `{"tags":"cloud"}`, `{"tags":[{"name":"cloud"}]}`,
		`{"tags":[{"name":"agents ia","language":"fr"}]}`,
		`{"tags":[{"name":"cloud","language":"en"},{"name":"nuages"}]}`,
		`{"tags":[{"name":"cloud","language":"en"},{"language":"fr"}]}`,
		`{"tags":[{"name":"cloud","language":"en"},{"name":"nuages","language":"malformed"}]}`,
		englishTags("  "), englishTags("https://example.org/?q=secret"), englishTags("bad\x00name"),
		englishTags(strings.Repeat("x", 81)),
	} {
		if _, err := parseTagSelection(answer, []string{"agents ia"}); !errors.Is(err, ErrModelOutput) {
			t.Errorf("expected invalid selection for %s, got %v", answer, err)
		}
	}
}

func TestStreamTerminalAndQuota(t *testing.T) {
	for _, x := range []struct {
		name, stream string
		quota        bool
	}{
		{"no terminal", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"[]\"}\n\n", false},
		{"quota after delta", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"[]\"}\n\n" + "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n", true},
		{"temporary", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_unavailable\"}}}\n\n", false},
		{"incomplete", "data: {\"type\":\"response.incomplete\"}\n\n", false},
		{"large", "data: " + strings.Repeat("x", 300<<10) + "\n\n", false},
	} {
		t.Run(x.name, func(t *testing.T) {
			resp := reply(200, x.stream)
			resp.Header.Set("Retry-After", "90")
			_, err := readResult(resp)
			var q *QuotaError
			if err == nil || errors.As(err, &q) != x.quota {
				t.Fatalf("unexpected error %v", err)
			}
			if q != nil && time.Until(q.RetryAt) < 80*time.Second {
				t.Fatal("missing indicated retry time")
			}
		})
	}
	var q *QuotaError
	if !errors.As(httpFailure(reply(429, `{"detail":"usage limited"}`)), &q) || !q.RetryAt.IsZero() {
		t.Fatal("invented a reset time")
	}
}

func TestClassificationGuardAfterRefresh(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", ClientID: "registered", Refresh: "old", Access: "expired"})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	refreshStarted, finishRefresh := make(chan struct{}), make(chan struct{})
	canceledJob, done := make(chan struct{}), make(chan error, 1)
	posts := 0
	c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == tokenEndpoint {
			close(refreshStarted)
			select {
			case <-finishRefresh:
				return reply(200, `{"token_type":"Bearer","access_token":"fresh","refresh_token":"replacement","expires_in":3600}`), nil
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		posts++
		return reply(200, stream(englishTags())), nil
	})
	jobCanceled := errors.New("job was canceled locally")
	go func() {
		_, err := c.Classify(ctx, "available", Article{Title: "An article", Domain: "example.invalid"}, []string{"sample"}, func(context.Context) error {
			select {
			case <-canceledJob:
				return jobCanceled
			default:
				return nil
			}
		})
		done <- err
	}()
	select {
	case <-refreshStarted:
	case err := <-done:
		t.Fatalf("finished before refresh: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(canceledJob)
	close(finishRefresh)
	if err := <-done; err != jobCanceled || posts != 0 {
		t.Fatalf("canceled job made %d inference requests, err=%v", posts, err)
	}
}
