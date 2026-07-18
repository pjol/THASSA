// Package push delivers Expo push notifications (spec §7d.4). It is wired as a
// second, best-effort leg of the notification path (after the WS fanout): given
// a target user + notification kind/payload it looks up the user's device
// tokens, derives a title/body, and POSTs to the Expo push service. Tokens Expo
// reports as DeviceNotRegistered are pruned. Delivery is fire-and-forget so it
// never slows the request path, and tolerant of network failure. No API key is
// required (Expo push is unauthenticated).
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// expoEndpoint is the Expo push API (batch of up to 100 messages per request).
const expoEndpoint = "https://exp.host/--/api/v2/push/send"

const expoBatchSize = 100

// TokenStore is the slice of the store the pusher needs: read a user's tokens
// and prune dead ones.
type TokenStore interface {
	PushTokensForUser(ctx context.Context, userID uuid.UUID) ([]string, error)
	DeletePushTokens(ctx context.Context, tokens []string) error
}

// Service sends Expo push notifications on behalf of the notification pipeline.
type Service struct {
	db     TokenStore
	client *http.Client
}

// New builds a push Service. A nil TokenStore disables delivery (Push becomes a
// no-op) so the notification path degrades gracefully when push is unwired.
func New(db TokenStore) *Service {
	return &Service{db: db, client: &http.Client{Timeout: 10 * time.Second}}
}

// Push delivers a notification of kind/payload to every device of userID. It is
// non-blocking: the actual lookup + HTTP happen in a detached goroutine with a
// bounded timeout, so it never delays the caller. Best-effort — all errors are
// logged and swallowed.
func (s *Service) Push(userID uuid.UUID, kind string, payload map[string]any) {
	if s == nil || s.db == nil || userID == uuid.Nil {
		return
	}
	title, body := TitleBody(kind, payload)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.deliver(ctx, userID, kind, title, body, payload); err != nil {
			log.Printf("push: deliver to %s (%s): %v", userID, kind, err)
		}
	}()
}

// expoMessage is one Expo push payload.
type expoMessage struct {
	To    string         `json:"to"`
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Data  map[string]any `json:"data,omitempty"`
	Sound string         `json:"sound,omitempty"`
}

// expoResponse is the Expo /push/send reply (one ticket per message, in order).
type expoResponse struct {
	Data []struct {
		Status  string `json:"status"`
		ID      string `json:"id"`
		Message string `json:"message"`
		Details struct {
			Error string `json:"error"`
		} `json:"details"`
	} `json:"data"`
}

func (s *Service) deliver(ctx context.Context, userID uuid.UUID, kind, title, body string, payload map[string]any) error {
	tokens, err := s.db.PushTokensForUser(ctx, userID)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		return nil
	}
	data := map[string]any{"kind": kind}
	for k, v := range payload {
		data[k] = v
	}

	var dead []string
	for start := 0; start < len(tokens); start += expoBatchSize {
		end := start + expoBatchSize
		if end > len(tokens) {
			end = len(tokens)
		}
		batch := tokens[start:end]
		msgs := make([]expoMessage, len(batch))
		for i, tok := range batch {
			msgs[i] = expoMessage{To: tok, Title: title, Body: body, Data: data, Sound: "default"}
		}
		invalid, err := s.sendBatch(ctx, msgs, batch)
		if err != nil {
			return err
		}
		dead = append(dead, invalid...)
	}
	if len(dead) > 0 {
		return s.db.DeletePushTokens(ctx, dead)
	}
	return nil
}

// sendBatch POSTs one ≤100-message batch and returns the tokens Expo rejected
// as DeviceNotRegistered (to be pruned).
func (s *Service) sendBatch(ctx context.Context, msgs []expoMessage, tokens []string) ([]string, error) {
	b, err := json.Marshal(msgs)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, expoEndpoint, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("expo push status %d", resp.StatusCode)
	}
	var er expoResponse
	if err := json.NewDecoder(resp.Body).Decode(&er); err != nil {
		return nil, err
	}
	var dead []string
	for i, ticket := range er.Data {
		if i >= len(tokens) {
			break
		}
		if ticket.Status == "error" && ticket.Details.Error == "DeviceNotRegistered" {
			dead = append(dead, tokens[i])
		}
	}
	return dead, nil
}
