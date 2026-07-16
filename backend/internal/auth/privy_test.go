package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
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

func TestParseVerificationKeyEscapedNewlines(t *testing.T) {
	_, pubPEM := genKey(t)
	escaped := strings.ReplaceAll(pubPEM, "\n", `\n`)
	if _, err := parseVerificationKey(escaped); err != nil {
		t.Fatalf("escaped-newline PEM rejected: %s", err)
	}
}

func TestParseVerificationKeyRejectsBadInput(t *testing.T) {
	if _, err := parseVerificationKey("-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----"); err == nil {
		t.Error("expected error for garbage PEM body")
	}
	if _, err := NewPrivyVerifier(testAppID, "not pem at all"); err == nil {
		t.Error("expected error for non-PEM key")
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
