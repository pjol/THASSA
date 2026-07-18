package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testAppID = "test-app-id"

func genKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return priv, string(pemBytes)
}

func mintToken(t *testing.T, priv *ecdsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = "test-kid"
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func baseClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"sub": "did:privy:abc123",
		"iss": privyIssuer,
		"aud": testAppID,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Add(-time.Minute).Unix(),
	}
}

func TestLocalVerification(t *testing.T) {
	priv, pubPEM := genKey(t)
	v, err := NewPrivyVerifier(testAppID, pubPEM)
	if err != nil {
		t.Fatalf("NewPrivyVerifier: %s", err)
	}
	if v.staticKey == nil {
		t.Fatal("expected pinned key, got JWKS fallback")
	}

	claims := baseClaims()
	claims["wallet_address"] = "0x1111111111111111111111111111111111111111"
	got, err := v.Verify(context.Background(), mintToken(t, priv, claims))
	if err != nil {
		t.Fatalf("Verify: %s", err)
	}
	if got.Subject != "did:privy:abc123" {
		t.Errorf("subject = %q", got.Subject)
	}
	if got.Wallet != "0x1111111111111111111111111111111111111111" {
		t.Errorf("wallet = %q", got.Wallet)
	}
}

func TestLocalVerificationRejects(t *testing.T) {
	priv, pubPEM := genKey(t)
	otherPriv, _ := genKey(t)
	v, err := NewPrivyVerifier(testAppID, pubPEM)
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]string{}

	cases["wrong signing key"] = mintToken(t, otherPriv, baseClaims())

	expired := baseClaims()
	expired["exp"] = time.Now().Add(-time.Hour).Unix()
	cases["expired"] = mintToken(t, priv, expired)

	badAud := baseClaims()
	badAud["aud"] = "another-app"
	cases["wrong audience"] = mintToken(t, priv, badAud)

	badIss := baseClaims()
	badIss["iss"] = "https://evil.example"
	cases["wrong issuer"] = mintToken(t, priv, badIss)

	noSub := baseClaims()
	delete(noSub, "sub")
	cases["missing subject"] = mintToken(t, priv, noSub)

	// alg=none / HS256 confusion attacks must fail against an EC key.
	hsTok := jwt.NewWithClaims(jwt.SigningMethodHS256, baseClaims())
	hs, _ := hsTok.SignedString([]byte("secret"))
	cases["HS256 alg confusion"] = hs

	cases["garbage"] = "not.a.jwt"

	for name, tok := range cases {
		if _, err := v.Verify(context.Background(), tok); err == nil {
			t.Errorf("%s: expected rejection, got success", name)
		}
	}
}

func TestParseVerificationKeyTolerantFormats(t *testing.T) {
	_, pubPEM := genKey(t)
	// base64 body with the armor stripped
	bare := pubPEM
	bare = strings.ReplaceAll(bare, "-----BEGIN PUBLIC KEY-----", "")
	bare = strings.ReplaceAll(bare, "-----END PUBLIC KEY-----", "")
	bare = strings.Join(strings.Fields(bare), "")

	forms := map[string]string{
		"canonical PEM":       pubPEM,
		"escaped-newline PEM":  strings.ReplaceAll(pubPEM, "\n", `\n`),
		"single-line PEM":      "-----BEGIN PUBLIC KEY-----" + bare + "-----END PUBLIC KEY-----",
		"bare base64 body":     bare,
		"bare base64 w/ space": bare[:20] + " " + bare[20:],
	}
	for name, form := range forms {
		if _, err := parseVerificationKey(form); err != nil {
			t.Errorf("%s: unexpectedly rejected: %s", name, err)
		}
	}
}

func TestParseVerificationKeyRejectsBadInput(t *testing.T) {
	// The app secret is not base64 SPKI — this is the common misconfiguration
	// and must fail with a clear error, not be silently accepted.
	for name, bad := range map[string]string{
		"empty":              "",
		"app secret-ish":     "3xAmpL3-pr1vy-app-s3cr3t-not-a-key",
		"armor + garbage":    "-----BEGIN PUBLIC KEY-----\ngarbage!!!\n-----END PUBLIC KEY-----",
		"valid b64 not SPKI": base64.StdEncoding.EncodeToString([]byte("hello world not a key")),
	} {
		if _, err := parseVerificationKey(bad); err == nil {
			t.Errorf("%s: expected rejection, got success", name)
		}
	}
	if _, err := NewPrivyVerifier(testAppID, "not a key at all"); err == nil {
		t.Error("expected NewPrivyVerifier to reject a bad key")
	}
}

func TestEmailClaimParsing(t *testing.T) {
	priv, pubPEM := genKey(t)
	v, err := NewPrivyVerifier(testAppID, pubPEM)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		mutate func(jwt.MapClaims)
		want  string
	}{
		{"top-level email claim", func(c jwt.MapClaims) { c["email"] = "a@thassa.io" }, "a@thassa.io"},
		{"email_address claim", func(c jwt.MapClaims) { c["email_address"] = "b@thassa.io" }, "b@thassa.io"},
		{"linked_accounts array (address)", func(c jwt.MapClaims) {
			c["linked_accounts"] = []any{
				map[string]any{"type": "wallet", "address": "0xabc"},
				map[string]any{"type": "email", "address": "c@thassa.io"},
			}
		}, "c@thassa.io"},
		{"linked_accounts JSON string (email field)", func(c jwt.MapClaims) {
			c["linked_accounts"] = `[{"type":"email","email":"d@thassa.io"}]`
		}, "d@thassa.io"},
		{"no email present", func(c jwt.MapClaims) {}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			claims := baseClaims()
			c.mutate(claims)
			got, err := v.Verify(context.Background(), mintToken(t, priv, claims))
			if err != nil {
				t.Fatalf("Verify: %s", err)
			}
			if got.Email != c.want {
				t.Errorf("Email = %q, want %q", got.Email, c.want)
			}
			// A token-carried email is always trusted (verified).
			if (got.Email != "") != got.EmailVerified {
				t.Errorf("EmailVerified = %v for email %q", got.EmailVerified, got.Email)
			}
		})
	}
}

func TestNoKeyFallsBackToJWKSMode(t *testing.T) {
	v, err := NewPrivyVerifier(testAppID, "")
	if err != nil {
		t.Fatal(err)
	}
	if v.staticKey != nil {
		t.Error("expected nil staticKey in JWKS fallback mode")
	}
}
