package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrPrivyAPIUnconfigured is returned when the Privy server API is invoked
// without an app secret. Callers must treat this as "email unknown", never
// fabricate one (spec §7c.1).
var ErrPrivyAPIUnconfigured = errors.New("privy app secret not configured")

// PrivyAPI is a minimal client for Privy's server REST API
// (https://auth.privy.io/api/v1). It authenticates with HTTP Basic
// app_id:app_secret plus the privy-app-id header, and is used solely to fetch
// a user's verified email by DID when it is not carried in the access token
// (spec §7c.1 source 2). Results are cached in-memory with a short TTL.
type PrivyAPI struct {
	appID   string
	secret  string
	baseURL string
	client  *http.Client
	ttl     time.Duration

	mu    sync.Mutex
	cache map[string]emailEntry
}

type emailEntry struct {
	email string
	at    time.Time
}

// NewPrivyAPI builds the client. When secret is empty the client is inert:
// every EmailForDID call returns ErrPrivyAPIUnconfigured.
func NewPrivyAPI(appID, secret string) *PrivyAPI {
	return &PrivyAPI{
		appID:   appID,
		secret:  strings.TrimSpace(secret),
		baseURL: privyAPIHost + "/api/v1",
		client:  &http.Client{Timeout: 10 * time.Second},
		ttl:     5 * time.Minute,
		cache:   map[string]emailEntry{},
	}
}

// Enabled reports whether the client can call the API (an app secret is set).
func (p *PrivyAPI) Enabled() bool { return p != nil && p.secret != "" }

// EmailForDID fetches the user by DID and returns the verified email linked
// account. Returns ErrPrivyAPIUnconfigured when no app secret is set, and an
// empty string (no error) when the user has no verified email.
func (p *PrivyAPI) EmailForDID(ctx context.Context, did string) (string, error) {
	if !p.Enabled() {
		return "", ErrPrivyAPIUnconfigured
	}
	if did == "" {
		return "", nil
	}

	p.mu.Lock()
	if e, ok := p.cache[did]; ok && time.Since(e.at) < p.ttl {
		p.mu.Unlock()
		return e.email, nil
	}
	p.mu.Unlock()

	email, err := p.fetchEmail(ctx, did)
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	p.cache[did] = emailEntry{email: email, at: time.Now()}
	p.mu.Unlock()
	return email, nil
}

// privyUser is the subset of the get-user response we consume.
type privyUser struct {
	LinkedAccounts []struct {
		Type    string `json:"type"`
		Address string `json:"address"`
		Email   string `json:"email"`
	} `json:"linked_accounts"`
}

// WalletForDID fetches the user by DID and returns the linked/embedded wallet
// address. Returns ErrPrivyAPIUnconfigured when no app secret is set, and an
// empty string (no error) when the user has no wallet.
func (p *PrivyAPI) WalletForDID(ctx context.Context, did string) (string, error) {
	if !p.Enabled() {
		return "", ErrPrivyAPIUnconfigured
	}
	if did == "" {
		return "", nil
	}
	u, err := p.fetchUser(ctx, did)
	if err != nil || u == nil {
		return "", err
	}
	for _, a := range u.LinkedAccounts {
		if (a.Type == "wallet" || a.Type == "smart_wallet") && a.Address != "" {
			return a.Address, nil
		}
	}
	return "", nil
}

// fetchUser retrieves the Privy user record by DID. A 404 returns (nil, nil).
func (p *PrivyAPI) fetchUser(ctx context.Context, did string) (*privyUser, error) {
	url := fmt.Sprintf("%s/users/%s", p.baseURL, did)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.appID, p.secret)
	req.Header.Set("privy-app-id", p.appID)
	req.Header.Set("Accept", "application/json")

	res, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("privy api: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil // user not found ⇒ no data, not an error
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("privy api: status %d", res.StatusCode)
	}
	var u privyUser
	if err := json.NewDecoder(res.Body).Decode(&u); err != nil {
		return nil, fmt.Errorf("privy api decode: %w", err)
	}
	return &u, nil
}

func (p *PrivyAPI) fetchEmail(ctx context.Context, did string) (string, error) {
	u, err := p.fetchUser(ctx, did)
	if err != nil || u == nil {
		return "", err
	}
	for _, a := range u.LinkedAccounts {
		if a.Type != "email" {
			continue
		}
		addr := a.Address
		if addr == "" {
			addr = a.Email
		}
		if addr != "" {
			return addr, nil
		}
	}
	return "", nil
}
