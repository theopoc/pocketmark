package aitagprovider

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mockTransport func(*http.Request) (*http.Response, error)

func (f mockTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func reply(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func jwt(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	encode := base64.RawURLEncoding.EncodeToString
	body := encode([]byte(jsonText(map[string]string{"alg": "RS256", "kid": "sample"}))) + "." + encode([]byte(jsonText(claims)))
	digest := sha256.Sum256([]byte(body))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return body + "." + encode(sig)
}

type testBackend struct {
	mu       sync.Mutex
	envelope []byte
}

func (b *testBackend) ReadAITagCredentials(context.Context) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.envelope), nil
}
func (b *testBackend) UpdateAITagCredentials(_ context.Context, fn func([]byte, func([]byte) error) error) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return fn(slices.Clone(b.envelope), func(next []byte) error { b.envelope = slices.Clone(next); return nil })
}
func setupSession(t *testing.T, c *Client, reg registration) {
	t.Helper()
	if err := c.withLock(t.Context(), func(r *registration, save func() error) error { *r = reg; return save() }); err != nil {
		t.Fatal(err)
	}
}

func oauthClient(t *testing.T) *Client {
	t.Helper()
	return New(&testBackend{}, "fictional-test-server-secret-32-bytes")
}

func TestOAuthLifecycle(t *testing.T) {
	c := oauthClient(t)
	ctx := context.Background()
	location, err := c.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Host != "auth.openai.com" || q.Get("client_id") != registrationID || !strings.HasPrefix(q.Get("ext_agent_host_id"), "urn:uuid:") || q.Get("agent_name_hint") != "Pocketmark" {
		t.Fatal("invalid authorization request")
	}
	state, nonce := q.Get("state"), q.Get("nonce")
	callback := redirectURI + "?" + url.Values{"state": {state}, "code": {"single-use-code"}, "client_id": {"issued-client"}}.Encode()
	if err := c.Finish(ctx, strings.Replace(callback, "127.0.0.1:1455", "example.invalid", 1)); !errors.Is(err, ErrCallback) {
		t.Fatal("accepted a different redirect origin")
	}
	if err := c.Finish(ctx, strings.Replace(callback, state, "unrelated", 1)); !errors.Is(err, ErrCallback) {
		t.Fatal("accepted a different state")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	claims := map[string]any{"iss": issuer, "aud": "issued-client", "exp": time.Now().Add(time.Hour).Unix(), "sub": "sample-person", "nonce": nonce}
	var revoked bool
	c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
		switch r.URL.String() {
		case tokenEndpoint:
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			pkce := sha256.Sum256([]byte(r.FormValue("code_verifier")))
			if encode(pkce[:]) != q.Get("code_challenge") || r.FormValue("resource") != resource || r.FormValue("client_id") != "issued-client" || r.FormValue("redirect_uri") != redirectURI || r.FormValue("code") != "single-use-code" {
				t.Fatal("bad authorization grant")
			}
			return reply(200, jsonText(map[string]any{"id_token": jwt(t, key, claims), "access_token": "fictional-access", "refresh_token": "fictional-refresh", "scope": planScope, "token_type": "Bearer", "expires_in": 3600})), nil
		case issuer + "/.well-known/jwks.json":
			return reply(200, jsonText(map[string]any{"keys": []map[string]string{{"kty": "RSA", "alg": "RS256", "kid": "sample", "n": encode(key.N.Bytes()), "e": encode(big.NewInt(int64(key.E)).Bytes())}}})), nil
		case resource + "/models":
			if r.Header.Get("Authorization") != "Bearer fictional-access" {
				t.Fatal("missing authorization")
			}
			return reply(200, `{"models":[{"slug":"hidden","visibility":"hide"},{"slug":"available","display_name":"Available Model","visibility":"list"}]}`), nil
		case issuer + "/.well-known/openid-configuration":
			return reply(200, jsonText(map[string]string{"issuer": issuer, "revocation_endpoint": issuer + "/revoke"})), nil
		case issuer + "/revoke":
			if r.FormValue("token") != "fictional-refresh" || r.FormValue("client_id") != "issued-client" {
				t.Fatal("bad revocation request")
			}
			revoked = true
			return reply(200, ""), nil
		default:
			t.Fatalf("unexpected endpoint %s", r.URL.Path)
			return nil, nil
		}
	})
	if err := c.Finish(ctx, callback); err != nil {
		t.Fatal(err)
	}
	if err := c.Finish(ctx, callback); !errors.Is(err, ErrCallback) {
		t.Fatal("callback was reusable")
	}
	for field, invalid := range map[string]any{"iss": "https://example.invalid", "aud": "another-client", "sub": "", "nonce": "stale", "exp": int64(1), "azp": "another-client", "nbf": time.Now().Add(time.Hour).Unix()} {
		old, present := claims[field]
		claims[field] = invalid
		_, err := c.verifyIdentity(ctx, jwt(t, key, claims), "issued-client", nonce)
		if !errors.Is(err, errIdentity) {
			t.Errorf("invalid %s claim accepted", field)
		}
		if present {
			claims[field] = old
		} else {
			delete(claims, field)
		}
	}
	signed := jwt(t, key, claims)
	parts := strings.Split(signed, ".")
	parts[1] = encode([]byte(jsonText(map[string]any{"iss": issuer, "aud": "issued-client", "sub": "someone-else", "nonce": nonce, "exp": time.Now().Add(time.Hour).Unix()})))
	if _, err := c.verifyIdentity(ctx, strings.Join(parts, "."), "issued-client", nonce); !errors.Is(err, errIdentity) {
		t.Fatal("accepted changed signed payload")
	}
	models, err := c.Models(ctx)
	if err != nil || len(models) != 1 || models[0] != (Model{"available", "Available Model"}) {
		t.Fatalf("models %v: %v", models, err)
	}
	b, err := c.backend.ReadAITagCredentials(ctx)
	if err != nil || len(b) == 0 || strings.Contains(string(b), "fictional-refresh") {
		t.Fatal("credential envelope was not protected")
	}
	again, err := c.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	next, _ := url.Parse(again)
	if next.Query().Get("client_id") != "issued-client" || next.Query().Get("ext_agent_host_id") != q.Get("ext_agent_host_id") || next.Query().Has("agent_name_hint") {
		t.Fatal("registration was not reused")
	}
	if err := c.Disconnect(ctx); err != nil || !revoked {
		t.Fatalf("disconnect: %v", err)
	}
	if yes, registered, err := c.State(ctx); yes || !registered || err != nil {
		t.Fatalf("disconnected: %v %v", yes, err)
	}
	switchURL, err := c.StartNew(ctx)
	if err != nil {
		t.Fatal(err)
	}
	switchAttempt, _ := url.Parse(switchURL)
	if switchAttempt.Query().Get("client_id") != registrationID {
		t.Fatal("new account did not request its own registration")
	}
	declined := redirectURI + "?" + url.Values{"state": {switchAttempt.Query().Get("state")}, "error": {"access_denied"}}.Encode()
	if err := c.Finish(ctx, declined); !errors.Is(err, errGrant) {
		t.Fatal("expected denied consent")
	}
	back, err := c.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	returning, _ := url.Parse(back)
	if returning.Query().Get("client_id") != "issued-client" || returning.Query().Get("ext_agent_host_id") != q.Get("ext_agent_host_id") {
		t.Fatal("disconnect or declined switch lost returning registration")
	}
}

func TestRefreshFailureKeepsRegistration(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", ClientID: "issued", Subject: "owner", Refresh: "original", Access: "expired"})
	c.http.Transport = mockTransport(func(*http.Request) (*http.Response, error) { return reply(400, `{"error":"invalid_grant"}`), nil })
	if _, err := c.access(t.Context()); !errors.Is(err, ErrReconnect) {
		t.Fatal(err)
	}
	if connected, registered, err := c.State(t.Context()); err != nil || connected || !registered {
		t.Fatal("unusable refresh was kept or identity was lost")
	}
}

func TestReconnectAfterSecretChange(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", Access: "expired", Refresh: "rotating"})
	other := New(c.backend, "a-different-fictional-secret")
	if _, _, err := other.State(t.Context()); !errors.Is(err, ErrUnreadable) {
		t.Fatal(err)
	}
	if err := other.Disconnect(context.Background()); !errors.Is(err, ErrRevocation) {
		t.Fatal(err)
	}
	if _, err := other.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRotatingRefreshSerializedAcrossClients(t *testing.T) {
	c := oauthClient(t)
	setupSession(t, c, registration{HostID: "host", ClientID: "issued", Refresh: "original", Access: "expired"})
	other := New(c.backend, "fictional-test-server-secret-32-bytes")
	var calls atomic.Int32
	c.http.Transport = mockTransport(func(r *http.Request) (*http.Response, error) {
		if n := calls.Add(1); n != 1 || r.FormValue("refresh_token") != "original" || r.FormValue("client_id") != "issued" {
			t.Error("invalid or repeated refresh")
		}
		return reply(200, `{"token_type":"Bearer","access_token":"fresh","refresh_token":"replacement","expires_in":3600}`), nil
	})
	other.http.Transport = c.http.Transport
	var wg sync.WaitGroup
	for _, client := range []*Client{c, other, c, other} {
		wg.Go(func() {
			token, err := client.access(context.Background())
			if err != nil || token != "fresh" {
				t.Errorf("refresh: %v", err)
			}
		})
	}
	wg.Wait()
	reg, err := c.read(t.Context())
	if err != nil || calls.Load() != 1 || reg.Refresh != "replacement" {
		t.Fatal("rotated token was not stored")
	}
}
