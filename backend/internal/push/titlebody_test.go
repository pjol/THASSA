package push

import (
	"strings"
	"testing"
)

func TestTitleBody(t *testing.T) {
	tests := []struct {
		name        string
		kind        string
		payload     map[string]any
		wantTitle   string
		bodyContains string
	}{
		{
			name:         "post mention with author",
			kind:         "post.mention",
			payload:      map[string]any{"author_username": "alice"},
			wantTitle:    "New mention",
			bodyContains: "@alice",
		},
		{
			name:         "post mention without author",
			kind:         "post.mention",
			payload:      nil,
			wantTitle:    "New mention",
			bodyContains: "Someone",
		},
		{
			name:         "dm with preview",
			kind:         "dm.message",
			payload:      map[string]any{"preview": "hey there"},
			wantTitle:    "New message",
			bodyContains: "hey there",
		},
		{
			name:         "follow new",
			kind:         "follow.new",
			wantTitle:    "New follower",
			bodyContains: "following",
		},
		{
			name:         "position swing up (float pct from JSON)",
			kind:         "position.swing",
			payload:      map[string]any{"direction": "up", "pct": float64(75), "question": "Will it rain?"},
			wantTitle:    "Big move in your position",
			bodyContains: "75%",
		},
		{
			name:         "position swing down",
			kind:         "position.swing",
			payload:      map[string]any{"direction": "down", "pct": 60},
			wantTitle:    "Big move in your position",
			bodyContains: "dropped 60%",
		},
		{
			name:         "large entry",
			kind:         "following.large_entry",
			payload:      map[string]any{"actor_username": "bob", "question": "BTC > 100k?"},
			wantTitle:    "Big bet from someone you follow",
			bodyContains: "@bob",
		},
		{
			name:         "unknown kind falls back",
			kind:         "something.new",
			wantTitle:    "Thassa",
			bodyContains: "notification",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title, body := TitleBody(tt.kind, tt.payload)
			if title != tt.wantTitle {
				t.Fatalf("title = %q, want %q", title, tt.wantTitle)
			}
			if title == "" {
				t.Fatal("title must never be empty")
			}
			if tt.bodyContains != "" && !strings.Contains(body, tt.bodyContains) {
				t.Fatalf("body = %q, want it to contain %q", body, tt.bodyContains)
			}
		})
	}
}

// TestTitleBodyTotal guarantees every kind (and the fallback) yields a
// non-empty title + body, so a push is always presentable.
func TestTitleBodyTotal(t *testing.T) {
	kinds := []string{
		"post.mention", "dm.message", "follow.new", "follow.request", "follow.accepted",
		"position.swing", "following.large_entry", "market.matched", "market.settled",
		"market.open", "order.filled", "order.rejected", "post.liked", "post.commented",
		"totally.unknown",
	}
	for _, k := range kinds {
		title, body := TitleBody(k, nil)
		if title == "" || body == "" {
			t.Fatalf("kind %q produced empty title/body (%q/%q)", k, title, body)
		}
	}
}
