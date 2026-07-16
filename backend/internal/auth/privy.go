package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const privyIssuer = "https://auth.privy.io"

// PrivyVerifier verifies Privy access tokens fully locally: ES256 signature
// against the app's pinned verification key (PRIVY_VERIFICATION_KEY, the
// public key shown in the Privy dashboard), plus issuer, audience
// (= PRIVY_APP_ID), and expiry. No network callout is made on any request
// path when the key is pinned. When no key is configured, the verifier falls
// back to fetching the app JWKS from auth.privy.io (cached), preserving
// dev-time convenience.
type PrivyVerifier struct {
	appID     string
	staticKey *ecdsa.PublicKey // pinned verification key; nil = JWKS fallback
	jwksURL   string
	client    *http.Client

	mu        sync.RWMutex
	keys      map[string]*ecdsa.PublicKey // kid -> key
	fetchedAt time.Time
}

// NewPrivyVerifier builds a verifier for the given Privy app id.
// verificationKeyPEM is the app's ES256 public verification key in PEM (SPKI)
// form as shown in the Privy dashboard; literal "\n" escapes are accepted so
// the key can live on one env line. Empty enables the JWKS fallback.
func NewPrivyVerifier(appID, verificationKeyPEM string) (*PrivyVerifier, error) {
	v := &PrivyVerifier{
		appID:   appID,
		jwksURL: fmt.Sprintf("%s/api/v1/apps/%s/jwks.json", privyIssuer, appID),
		client:  &http.Client{Timeout: 10 * time.Second},
		keys:    map[string]*ecdsa.PublicKey{},
	}
	if strings.TrimSpace(verificationKeyPEM) != "" {
		key, err := parseVerificationKey(verificationKeyPEM)
		if err != nil {
			return nil, fmt.Errorf("PRIVY_VERIFICATION_KEY: %w", err)
		}
		v.staticKey = key
	}
	return v, nil
}

// parseVerificationKey decodes a PEM (SPKI) ES256 public key, tolerating
// env-style literal "\n" escapes.
func parseVerificationKey(pemStr string) (*ecdsa.PublicKey, error) {
	pemStr = strings.ReplaceAll(pemStr, `\n`, "\n")
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("not valid PEM")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return nil, fmt.Errorf("must be an ES256 (P-256) public key")
	}
	return ec, nil
}

// Verify implements Verifier.
func (p *PrivyVerifier) Verify(ctx context.Context, token string) (*Claims, error) {
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodES256.Alg() {
			return nil, fmt.Errorf("unexpected alg %q", t.Method.Alg())
		}
		kid, _ := t.Header["kid"].(string)
		return p.keyFor(ctx, kid)
	},
		jwt.WithIssuer(privyIssuer),
		jwt.WithAudience(p.appID),
		jwt.WithExpirationRequired(),
		jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}),
	)
	if err != nil || !parsed.Valid {
		return nil, ErrUnauthorized
	}
	mc, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, ErrUnauthorized
	}
	sub, _ := mc["sub"].(string)
	if sub == "" {
		return nil, ErrUnauthorized
	}
	return &Claims{Subject: sub, Wallet: walletClaim(mc)}, nil
}

// walletClaim extracts the linked/embedded wallet address from the token's
// custom claims. Privy encodes linked accounts either as a top-level
// wallet_address claim or inside a linked_accounts JSON list.
func walletClaim(mc jwt.MapClaims) string {
	if w, _ := mc["wallet_address"].(string); w != "" {
		return w
	}
	// linked_accounts may be a JSON string or an array of objects.
	var accounts []map[string]any
	switch v := mc["linked_accounts"].(type) {
	case string:
		_ = json.Unmarshal([]byte(v), &accounts)
	case []any:
		for _, e := range v {
			if m, ok := e.(map[string]any); ok {
				accounts = append(accounts, m)
			}
		}
	}
	for _, a := range accounts {
		typ, _ := a["type"].(string)
		if typ == "wallet" || typ == "smart_wallet" {
			if addr, _ := a["address"].(string); addr != "" {
				return addr
			}
		}
	}
	return ""
}

// keyFor returns the verification key for a token. With a pinned key
// configured, that key is always used (no callout, kid ignored). Otherwise
// the cached JWKS key for kid is returned, refreshing the set when the kid is
// unknown or the cache is stale (1h TTL).
func (p *PrivyVerifier) keyFor(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	if p.staticKey != nil {
		return p.staticKey, nil
	}
	p.mu.RLock()
	key, ok := p.keys[kid]
	fresh := time.Since(p.fetchedAt) < time.Hour
	p.mu.RUnlock()
	if ok && fresh {
		return key, nil
	}
	if err := p.refresh(ctx); err != nil {
		// Fall back to a stale cached key rather than hard-failing.
		if ok {
			return key, nil
		}
		return nil, err
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	if key, ok := p.keys[kid]; ok {
		return key, nil
	}
	return nil, fmt.Errorf("jwks: unknown kid %q", kid)
}

type jwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func (p *PrivyVerifier) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.jwksURL, nil)
	if err != nil {
		return err
	}
	res, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("jwks fetch: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks fetch: status %d", res.StatusCode)
	}
	var body struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return fmt.Errorf("jwks decode: %w", err)
	}
	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range body.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" {
			continue
		}
		pub, err := ecKey(k)
		if err != nil {
			continue
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return fmt.Errorf("jwks: no usable ES256 keys")
	}
	p.mu.Lock()
	p.keys = keys
	p.fetchedAt = time.Now()
	p.mu.Unlock()
	return nil
}

func ecKey(k jwk) (*ecdsa.PublicKey, error) {
	xb, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil {
		return nil, err
	}
	yb, err := base64.RawURLEncoding.DecodeString(k.Y)
	if err != nil {
		return nil, err
	}
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(xb),
		Y:     new(big.Int).SetBytes(yb),
	}, nil
}
