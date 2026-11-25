// Package aitagprovider connects a Pocketmark owner's ChatGPT plan to AI tagging.
package aitagprovider

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"pocketmark/internal/fault"
	"time"
)

const (
	issuer         = "https://auth.openai.com"
	resource       = "https://api.openai.com/v1"
	tokenEndpoint  = issuer + "/api/accounts/oauth/token"
	redirectURI    = "http://127.0.0.1:1455/auth/callback"
	registrationID = "dynamic_agent_client"
	planScope      = "chatgpt.tokens.use.direct"
	sessionLimit   = 256 << 10
)

var (
	ErrReconnect  = fault.New("ai_tagging", "chatgpt_reconnect_required", "connect your ChatGPT plan again")
	ErrUnreadable = fault.New("ai_tagging", "chatgpt_session_unreadable", "the saved ChatGPT connection cannot be opened; disconnect and connect it again")
	errSession    = fault.New("ai_tagging", "chatgpt_session_storage_failed", "could not read or save the protected ChatGPT connection")
	errProvider   = fault.New("ai_tagging", "chatgpt_request_failed", "ChatGPT could not complete the request")
	errInvalid    = fault.New("ai_tagging", "chatgpt_invalid_response", "ChatGPT returned an invalid response")
	errGrant      = fault.New("ai_tagging", "chatgpt_grant_missing", "ChatGPT plan access was not granted")
)

type QuotaError struct{ RetryAt time.Time }

func (*QuotaError) Error() string { return "ChatGPT plan usage limit reached" }

// Backend serializes access to one encrypted envelope across all replicas.
// Each successful write is durable even when subsequent work in fn fails.
// A nil write removes an unreadable envelope after an explicit disconnect.
type Backend interface {
	ReadAITagCredentials(context.Context) ([]byte, error)
	UpdateAITagCredentials(context.Context, func([]byte, func([]byte) error) error) error
}

type Client struct {
	backend Backend
	aead    cipher.AEAD
	http    *http.Client
}

func New(backend Backend, serverSecret string) *Client {
	key := sha256.Sum256([]byte("pocketmark/chatgpt-plan/v1\x00" + serverSecret))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCMWithRandomNonce(block)
	return &Client{
		backend: backend, aead: aead,
		http: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

type registration struct {
	HostID   string
	ClientID string
	Subject  string
	Access   string
	Refresh  string
	Expires  time.Time
	Pending  *attempt
}

type attempt struct {
	NewAccount bool
	State      string
	Verifier   string
	Nonce      string
	Expires    time.Time
}

func (c *Client) open(body []byte) (registration, error) {
	var reg registration
	if len(body) == 0 {
		return reg, nil
	}
	if len(body) > sessionLimit {
		return reg, ErrUnreadable
	}
	plain, err := c.aead.Open(nil, nil, body, nil)
	if err != nil || json.Unmarshal(plain, &reg) != nil || reg.HostID == "" {
		return registration{}, ErrUnreadable
	}
	return reg, nil
}

func (c *Client) read(ctx context.Context) (registration, error) {
	raw, err := c.backend.ReadAITagCredentials(ctx)
	if err != nil {
		return registration{}, errSession
	}
	return c.open(raw)
}

func (c *Client) save(reg registration, write func([]byte) error) error {
	plain, err := json.Marshal(reg)
	if err != nil || len(plain)+c.aead.Overhead() > sessionLimit {
		return errSession
	}
	if err = write(c.aead.Seal(nil, nil, plain, nil)); err != nil {
		return errSession
	}
	return nil
}

func (c *Client) withEnvelope(ctx context.Context, fn func([]byte, func([]byte) error) error) error {
	var operationError error
	err := c.backend.UpdateAITagCredentials(ctx, func(raw []byte, write func([]byte) error) error {
		operationError = fn(raw, write)
		return operationError
	})
	if err != nil && !errors.Is(err, operationError) {
		return errSession
	}
	return operationError
}

func (c *Client) withLock(ctx context.Context, fn func(*registration, func() error) error) error {
	return c.withEnvelope(ctx, func(raw []byte, write func([]byte) error) error {
		reg, err := c.open(raw)
		if err != nil {
			return err
		}
		return fn(&reg, func() error { return c.save(reg, write) })
	})
}

func (c *Client) State(ctx context.Context) (connected, registered bool, err error) {
	reg, err := c.read(ctx)
	return reg.Refresh != "" && reg.Access != "", reg.ClientID != "" && reg.Subject != "", err
}
