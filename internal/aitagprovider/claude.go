package aitagprovider

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	claudeEndpoint = "https://api.anthropic.com/v1"
	claudeVersion  = "2026-10-21"
	// DefaultClaudeModel is the lowest-cost current model and preselected on connection.
	DefaultClaudeModel = "claude-haiku-5-5"
	claudeKeyLimit     = 4096
)

var (
	// ErrInvalidKey reports a key that Anthropic rejected or that is malformed.
	ErrInvalidKey = errors.New("the Anthropic API key was not accepted")

	tagSchema = map[string]any{
		"type": "object",
		"properties": map[string]any{"tags": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":     map[string]any{"type": "string"},
					"language": map[string]any{"type": "string"},
				},
				"required":             []string{"name", "language"},
				"additionalProperties": false,
			},
		}},
		"required":             []string{"tags"},
		"additionalProperties": false,
	}
)

// ClaudeBackend stores one encrypted API key.
type ClaudeBackend interface {
	ReadAIClaudeKey(context.Context) ([]byte, error)
	WriteAIClaudeKey(context.Context, []byte) error
}

// Claude classifies bookmarks through the Anthropic Messages API with an
// owner-supplied API key. The key is sealed with the server secret at rest.
type Claude struct {
	backend ClaudeBackend
	aead    cipher.AEAD
	http    *http.Client
	base    string
}

func NewClaude(backend ClaudeBackend, serverSecret string) *Claude {
	key := sha256.Sum256([]byte("pocketmark/claude-api-key/v1\x00" + serverSecret))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCMWithRandomNonce(block)
	return &Claude{
		backend: backend, aead: aead, base: claudeEndpoint,
		http: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

// key returns the saved API key, or ErrReconnect when none is saved.
func (c *Claude) key(ctx context.Context) (string, error) {
	raw, err := c.backend.ReadAIClaudeKey(ctx)
	if err != nil {
		return "", errSession
	}
	if len(raw) == 0 {
		return "", ErrReconnect
	}
	if len(raw) > claudeKeyLimit {
		return "", ErrUnreadable
	}
	plain, err := c.aead.Open(nil, nil, raw, nil)
	if err != nil || len(plain) == 0 {
		return "", ErrUnreadable
	}
	return string(plain), nil
}

func (c *Claude) State(ctx context.Context) (bool, error) {
	_, err := c.key(ctx)
	if errors.Is(err, ErrReconnect) {
		return false, nil
	}
	return err == nil, err
}

func validKey(key string) bool {
	if len(key) < 8 || len(key) > 512 {
		return false
	}
	for _, r := range key {
		if r <= ' ' || r > '~' {
			return false
		}
	}
	return true
}

// Connect checks the key by listing models, then saves it. It returns the models
// the key may use so the caller can preselect DefaultClaudeModel.
func (c *Claude) Connect(ctx context.Context, key string) ([]Model, error) {
	key = strings.TrimSpace(key)
	if !validKey(key) {
		return nil, ErrInvalidKey
	}
	models, err := c.list(ctx, key)
	if errors.Is(err, ErrReconnect) {
		return nil, ErrInvalidKey
	}
	if err != nil {
		return nil, err
	}
	if c.backend.WriteAIClaudeKey(ctx, c.aead.Seal(nil, nil, []byte(key), nil)) != nil {
		return nil, errSession
	}
	return models, nil
}

func (c *Claude) Disconnect(ctx context.Context) error {
	if c.backend.WriteAIClaudeKey(ctx, nil) != nil {
		return errSession
	}
	return nil
}

func (c *Claude) request(ctx context.Context, method, path, key string, body []byte) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, errProvider
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", claudeVersion)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errProvider
	}
	return resp, nil
}

func claudeFailure(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusRequestEntityTooLarge:
		return ErrArticleInput
	case http.StatusTooManyRequests, http.StatusPaymentRequired:
		return quotaError(resp.Header.Get("Retry-After"))
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrReconnect
	default:
		return errProvider
	}
}

func (c *Claude) Models(ctx context.Context) ([]Model, error) {
	key, err := c.key(ctx)
	if err != nil {
		return nil, err
	}
	return c.list(ctx, key)
}

// list returns the models that accept effort and structured output settings,
// which tagging relies on. A model without capability data is kept.
func (c *Claude) list(ctx context.Context, key string) ([]Model, error) {
	resp, err := c.request(ctx, http.MethodGet, "/models?limit=1000", key, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, claudeFailure(resp)
	}
	var data struct {
		Data []struct {
			ID           string `json:"id"`
			DisplayName  string `json:"display_name"`
			Capabilities *struct {
				Effort            struct{ Supported bool } `json:"effort"`
				StructuredOutputs struct{ Supported bool } `json:"structured_outputs"`
			} `json:"capabilities"`
		} `json:"data"`
	}
	if decodeBody(resp, &data, 4<<20) != nil || data.Data == nil {
		return nil, errInvalid
	}
	list := []Model{}
	for _, m := range data.Data {
		if !strings.HasPrefix(m.ID, "claude-") || len(m.ID) > 256 {
			continue
		}
		if m.Capabilities != nil && !(m.Capabilities.Effort.Supported && m.Capabilities.StructuredOutputs.Supported) {
			continue
		}
		name := m.DisplayName
		if name == "" {
			name = m.ID
		}
		list = append(list, Model{m.ID, name})
	}
	return list, nil
}

func (c *Claude) Classify(ctx context.Context, model string, article Article, tags []string, beforeSend func(context.Context) error) ([]string, error) {
	allowed, prompt, err := prepare(model, article, tags)
	if err != nil {
		return nil, err
	}
	if prompt == "" {
		return []string{}, nil
	}
	// Sampling parameters and thinking are left at their defaults because
	// current models reject non-default values. Low effort keeps output short.
	body, err := json.Marshal(map[string]any{
		"model": model, "max_tokens": 4096,
		"system":   taggingInstructions,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
		"output_config": map[string]any{
			"effort": "low",
			"format": map[string]any{"type": "json_schema", "schema": tagSchema},
		},
	})
	if err != nil || len(body) > 256<<10 {
		return nil, ErrArticleInput
	}
	key, err := c.key(ctx)
	if err != nil {
		return nil, err
	}
	if beforeSend != nil {
		if err := beforeSend(ctx); err != nil {
			return nil, err
		}
	}
	resp, err := c.request(ctx, http.MethodPost, "/messages", key, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, claudeFailure(resp)
	}
	var msg struct {
		StopReason string `json:"stop_reason"`
		Content    []struct{ Type, Text string }
	}
	if decodeBody(resp, &msg, 1<<20) != nil {
		return nil, errInvalid
	}
	// A refusal or a truncated answer is a verdict on this article, not an outage.
	if msg.StopReason == "refusal" || msg.StopReason == "max_tokens" {
		return nil, ErrModelOutput
	}
	var answer strings.Builder
	for _, block := range msg.Content {
		if block.Type != "text" {
			continue
		}
		if answer.Len()+len(block.Text) > 4096 {
			return nil, errInvalid
		}
		answer.WriteString(block.Text)
	}
	if answer.Len() == 0 {
		return nil, ErrModelOutput
	}
	return parseTagSelection(answer.String(), allowed)
}

func (c *Claude) Test(ctx context.Context, model string) error {
	tags, err := c.Classify(ctx, model, sampleArticle, sampleTags, nil)
	return checkSample(tags, err)
}
