package aitagprovider

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"slices"
	"strings"
	"time"
)

var errIdentity = errors.New("ChatGPT sign-in identity could not be verified")

// The issuer and key endpoint are fixed. No JWT header can select a URL.
func (c *Client) verifyIdentity(ctx context.Context, raw, audience, nonce string) (string, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || len(raw) > 64<<10 {
		return "", errIdentity
	}
	decode := base64.RawURLEncoding.DecodeString
	header, err := decode(parts[0])
	var h struct{ Alg, Kid string }
	if err != nil || json.Unmarshal(header, &h) != nil || h.Alg != "RS256" || h.Kid == "" {
		return "", errIdentity
	}
	sig, err := decode(parts[2])
	if err != nil {
		return "", errIdentity
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	resp, err := c.request(ctx, "GET", issuer+"/.well-known/jwks.json", "", "application/json", "", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errProvider
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Alg, Use, N, E string }
	}
	if decodeBody(resp, &jwks, 256<<10) != nil {
		return "", errIdentity
	}
	verified := false
	for _, j := range jwks.Keys {
		if j.Kid != h.Kid || j.Kty != "RSA" || (j.Alg != "" && j.Alg != "RS256") || (j.Use != "" && j.Use != "sig") {
			continue
		}
		nb, errN := decode(j.N)
		eb, errE := decode(j.E)
		if errN != nil || errE != nil || len(nb) < 256 || len(nb) > 1024 || len(eb) == 0 || len(eb) > 4 {
			continue
		}
		mod := new(big.Int).SetBytes(nb)
		exp := new(big.Int).SetBytes(eb).Int64()
		if mod.BitLen() < 2048 || exp < 3 || exp > 1<<31-1 || exp%2 == 0 {
			continue
		}
		key := rsa.PublicKey{N: mod, E: int(exp)}
		if rsa.VerifyPKCS1v15(&key, crypto.SHA256, digest[:], sig) == nil {
			verified = true
			break
		}
	}
	if !verified {
		return "", errIdentity
	}
	var cl struct {
		Iss, Sub, Nonce, Azp string
		Aud                  json.RawMessage
		Exp, Nbf, Iat        int64
	}
	body, err := decode(parts[1])
	if err != nil || json.Unmarshal(body, &cl) != nil {
		return "", errIdentity
	}
	now := time.Now().Unix()
	if cl.Iss != issuer || cl.Sub == "" || cl.Nonce != nonce || nonce == "" || cl.Exp <= now || cl.Nbf > now+60 || cl.Iat > now+60 {
		return "", errIdentity
	}
	var audiences []string
	if json.Unmarshal(cl.Aud, &audiences) != nil {
		var single string
		if json.Unmarshal(cl.Aud, &single) != nil {
			return "", errIdentity
		}
		audiences = []string{single}
	}
	if !slices.Contains(audiences, audience) || (len(audiences) > 1 || cl.Azp != "") && cl.Azp != audience {
		return "", errIdentity
	}
	return cl.Sub, nil
}
