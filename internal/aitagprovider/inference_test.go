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

func TestClassify(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", Refresh: "session", Access: "valid", Expires: time.Now().Add(time.Hour)})
	ctx := context.Background()
	article := Article{Title: "A tutorial", Domain: "example.invalid", Description: "https://example.invalid/guide?key=private-value and some words"}
	tags := []string{"one", "machine learning", strings.Repeat("ⱥ", 40)}
	result := stream(`{"indices":[1,0]}`)
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
	if _, err := c.Classify(ctx, "available", article, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Classify(ctx, "available", Article{Domain: article.Domain}, tags, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("sent a request for an empty vocabulary or a domain alone")
	}
	if _, err := c.Classify(ctx, "available", Article{Domain: strings.Repeat("x", 256), Title: "article"}, tags, nil); !errors.Is(err, ErrArticleInput) || calls != 1 {
		t.Fatal("invalid bookmark did not produce a local article-specific error")
	}
	for _, invalid := range []string{`{}`, `{"indices":[null]}`, `{"indices":["one"]}`, `{"indices":[3]}`, `{"indices":[0,1,2,0]}`} {
		result = stream(invalid)
		if _, err := c.Classify(ctx, "available", article, tags, nil); !errors.Is(err, ErrModelOutput) {
			t.Fatalf("accepted %s, %v", invalid, err)
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
		return reply(200, stream(`{"indices":[]}`)), nil
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
