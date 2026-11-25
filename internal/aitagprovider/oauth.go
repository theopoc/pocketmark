package aitagprovider

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"pocketmark/internal/fault"
	"slices"
	"strings"
	"time"
)

func randomSecret() string {
	var value [32]byte
	rand.Read(value[:])
	return base64.RawURLEncoding.EncodeToString(value[:])
}

// Start persists a short-lived attempt. A second Start supersedes the first.
func (c *Client) Start(ctx context.Context) (string, error) {
	return c.start(ctx, false)
}

// StartNew registers a different account after the owner disconnected the old
// one. A failed or abandoned attempt preserves the previously verified identity.
func (c *Client) StartNew(ctx context.Context) (string, error) {
	return c.start(ctx, true)
}

func (c *Client) start(ctx context.Context, newAccount bool) (string, error) {
	var location string
	err := c.withLock(ctx, func(reg *registration, save func() error) error {
		if newAccount && reg.Refresh != "" {
			return fault.New("ai_tagging", "chatgpt_already_connected", "disconnect the current ChatGPT account first")
		}
		if reg.HostID == "" {
			var id [16]byte
			rand.Read(id[:])
			id[6] = (id[6] & 15) | 64
			id[8] = (id[8] & 63) | 128
			reg.HostID = fmt.Sprintf("urn:uuid:%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
		}
		p := &attempt{NewAccount: newAccount || reg.ClientID == "", State: randomSecret(), Verifier: randomSecret(), Nonce: randomSecret(), Expires: time.Now().Add(15 * time.Minute)}
		challenge := sha256.Sum256([]byte(p.Verifier))
		params := url.Values{"client_id": {reg.ClientID}, "ext_agent_host_id": {reg.HostID}, "response_type": {"code"},
			"resource": {resource}, "redirect_uri": {redirectURI}, "scope": {"openid profile email offline_access resource.invoke " + planScope},
			"state": {p.State}, "nonce": {p.Nonce}, "code_challenge_method": {"S256"},
			"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}}
		if p.NewAccount {
			params.Set("client_id", registrationID)
			params.Set("agent_name_hint", "Pocketmark")
		}
		reg.Pending = p
		if err := save(); err != nil {
			return err
		}
		location = issuer + "/api/accounts/authorize?" + params.Encode()
		return nil
	})
	return location, err
}

var ErrCallback = fault.New("ai_tagging", "chatgpt_callback_invalid", "paste the complete loopback callback from the current ChatGPT sign-in")

func (c *Client) Finish(ctx context.Context, callback string) error {
	if len(callback) > 16<<10 {
		return ErrCallback
	}
	u, err := url.Parse(strings.TrimSpace(callback))
	if err != nil || u.Scheme != "http" || u.Host != "127.0.0.1:1455" || u.EscapedPath() != "/auth/callback" || u.User != nil || u.Fragment != "" {
		return ErrCallback
	}
	params, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(params["state"]) != 1 || len(params["client_id"]) > 1 || len(params["code"]) > 1 || len(params["error"]) > 1 {
		return ErrCallback
	}
	return c.withLock(ctx, func(reg *registration, save func() error) error {
		p := reg.Pending
		if p == nil || !time.Now().Before(p.Expires) || subtle.ConstantTimeCompare([]byte(p.State), []byte(params.Get("state"))) != 1 {
			return ErrCallback
		}
		reg.Pending = nil
		if err := save(); err != nil {
			return err
		}
		if params.Get("error") != "" {
			return errGrant
		}
		clientID := params.Get("client_id")
		if !p.NewAccount && reg.ClientID != "" {
			if clientID != "" && clientID != reg.ClientID {
				return ErrCallback
			}
			clientID = reg.ClientID
		}
		if clientID == "" || len(clientID) > 512 || clientID == registrationID || params.Get("code") == "" {
			return ErrCallback
		}
		t, err := c.token(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "resource": {resource},
			"code": {params.Get("code")}, "code_verifier": {p.Verifier}, "redirect_uri": {redirectURI}})
		if err != nil {
			return err
		}
		subject, err := c.verifyIdentity(ctx, t.ID, clientID, p.Nonce)
		if err != nil {
			return err
		}
		if !p.NewAccount && reg.Subject != "" && reg.Subject != subject {
			return errIdentity
		}
		if !slices.Contains(strings.Fields(t.Scope), planScope) {
			return errGrant
		}
		reg.ClientID = clientID
		reg.Subject = subject
		t.install(reg)
		return save()
	})
}

type tokenReply struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	ID      string `json:"id_token"`
	Type    string `json:"token_type"`
	Scope   string `json:"scope"`
	Seconds int    `json:"expires_in"`
	Error   string `json:"error"`
}

func (t tokenReply) install(reg *registration) {
	reg.Access = t.Access
	reg.Refresh = t.Refresh
	reg.Expires = time.Now().Add(time.Duration(t.Seconds) * time.Second)
}

func (c *Client) request(ctx context.Context, method, endpoint, contentType, accept, access string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, errProvider
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", accept)
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
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

func decodeBody(resp *http.Response, dest any, limit int64) error {
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(data)) > limit || json.Unmarshal(data, dest) != nil {
		return errInvalid
	}
	return nil
}

func (c *Client) token(ctx context.Context, params url.Values) (tokenReply, error) {
	var t tokenReply
	resp, err := c.request(ctx, "POST", tokenEndpoint, "application/x-www-form-urlencoded", "application/json", "", strings.NewReader(params.Encode()))
	if err != nil {
		return t, err
	}
	defer resp.Body.Close()
	err = decodeBody(resp, &t, 128<<10)
	if resp.StatusCode != 200 {
		if resp.StatusCode == 400 || resp.StatusCode == 401 {
			switch t.Error {
			case "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused":
				return t, ErrReconnect
			}
		}
		return t, errProvider
	}
	if err != nil || t.Access == "" || t.Refresh == "" || !strings.EqualFold(t.Type, "Bearer") || t.Seconds <= 0 || t.Seconds > 7*24*3600 {
		return t, errInvalid
	}
	return t, nil
}

func (c *Client) access(ctx context.Context) (string, error) {
	// Reads see committed envelopes. Only the refresh path needs a
	// critical section and a second read for changes made by other callers.
	reg, err := c.read(ctx)
	if err != nil {
		return "", err
	}
	if reg.Refresh == "" {
		return "", ErrReconnect
	}
	fresh := func(r *registration) bool { return time.Until(r.Expires) > time.Minute }
	if fresh(&reg) {
		return reg.Access, nil
	}
	var access string
	err = c.withLock(ctx, func(r *registration, save func() error) error {
		if r.Refresh == "" {
			return ErrReconnect
		}
		if fresh(r) {
			access = r.Access
			return nil
		}
		t, err := c.token(ctx, url.Values{"grant_type": {"refresh_token"}, "client_id": {r.ClientID}, "resource": {resource}, "refresh_token": {r.Refresh}})
		if errors.Is(err, ErrReconnect) || (err == nil && t.Scope != "" && !slices.Contains(strings.Fields(t.Scope), planScope)) {
			r.Access, r.Refresh = "", ""
			if e := save(); e != nil {
				return e
			}
			return ErrReconnect
		}
		if err != nil {
			return err
		}
		t.install(r)
		if err := save(); err != nil {
			return err
		}
		access = r.Access
		return nil
	})
	return access, err
}

// Disconnect removes renewable credentials while preserving the verified registration.
var ErrRevocation = fault.New("ai_tagging", "chatgpt_revocation_unconfirmed", "disconnected locally; remote revocation was not confirmed; manage access in ChatGPT Settings")

func (c *Client) Disconnect(ctx context.Context) error {
	return c.withEnvelope(ctx, func(raw []byte, write func([]byte) error) error {
		reg, err := c.open(raw)
		if errors.Is(err, ErrUnreadable) {
			if write(nil) != nil {
				return errSession
			}
			return ErrRevocation
		}
		if err != nil {
			return err
		}
		if reg.HostID == "" {
			return nil
		}
		old := reg
		if err := c.save(registration{HostID: reg.HostID, ClientID: reg.ClientID, Subject: reg.Subject}, write); err != nil {
			return err
		}
		if old.Refresh == "" {
			return nil
		}
		resp, err := c.request(ctx, "GET", issuer+"/.well-known/openid-configuration", "", "application/json", "", nil)
		if err != nil {
			return ErrRevocation
		}
		var meta struct {
			Issuer   string
			Endpoint string `json:"revocation_endpoint"`
		}
		err = decodeBody(resp, &meta, 128<<10)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 || meta.Issuer != issuer {
			return ErrRevocation
		}
		u, err := url.Parse(meta.Endpoint)
		if err != nil || u.Scheme != "https" || u.Host != "auth.openai.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return ErrRevocation
		}
		body := url.Values{"token": {old.Refresh}, "token_type_hint": {"refresh_token"}, "client_id": {old.ClientID}}
		resp, err = c.request(ctx, "POST", meta.Endpoint, "application/x-www-form-urlencoded", "application/json", "", strings.NewReader(body.Encode()))
		if err != nil {
			return ErrRevocation
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return ErrRevocation
		}
		return nil
	})
}
