package push

import (
	"fmt"
	"strings"
)

// TitleBody maps a notification kind + payload to the push title and body shown
// on the device (spec §7d.4 "Title/body per kind"). It is pure and total: every
// kind resolves to a non-empty title, with a generic fallback for unmapped
// kinds, so a push is always presentable.
func TitleBody(kind string, payload map[string]any) (title, body string) {
	switch kind {
	case "post.mention":
		who := atName(payload, "author_username")
		return "New mention", strings.TrimSpace(who+" mentioned you in a post")
	case "dm.message":
		if p := str(payload, "preview"); p != "" {
			return "New message", p
		}
		return "New message", "You have a new message"
	case "follow.new":
		return "New follower", "Someone started following you"
	case "follow.request":
		return "Follow request", "Someone requested to follow you"
	case "follow.accepted":
		return "Follow accepted", "Your follow request was accepted"
	case "position.swing":
		q := str(payload, "question")
		dir := str(payload, "direction")
		pct := intVal(payload, "pct")
		word := "moved"
		if dir == "up" {
			word = "jumped"
		} else if dir == "down" {
			word = "dropped"
		}
		body = fmt.Sprintf("Your position %s %d%%", word, abs(pct))
		if q != "" {
			body += " — " + q
		}
		return "Big move in your position", body
	case "following.large_entry":
		who := atName(payload, "actor_username")
		mkt := str(payload, "question")
		body = who + " placed a large bet"
		if mkt != "" {
			body += " on " + mkt
		}
		return "Big bet from someone you follow", strings.TrimSpace(body)
	case "market.matched":
		return "Your bet was taken", "Someone took the other side of your bet"
	case "market.settled":
		if o := str(payload, "outcome"); o != "" {
			return "Market settled", "Outcome: " + o
		}
		return "Market settled", "A market you're in has settled"
	case "market.open":
		if m := str(payload, "message"); m != "" {
			return "You're committed", m
		}
		return "You're committed", "Waiting for someone to take your bet"
	case "order.filled":
		return "Order filled", "Your order was filled"
	case "order.rejected":
		if r := str(payload, "reason"); r != "" {
			return "Order rejected", r
		}
		return "Order rejected", "Your order could not be placed"
	case "post.liked":
		return "New like", "Someone liked your post"
	case "post.commented":
		return "New comment", "Someone commented on your post"
	default:
		return "Thassa", "You have a new notification"
	}
}

// atName renders an @username from the payload, or "Someone" when absent.
func atName(payload map[string]any, key string) string {
	if u := str(payload, key); u != "" {
		return "@" + u
	}
	return "Someone"
}

func str(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if v, ok := payload[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// intVal reads an integer-ish payload value (handles int, int64, float64 from
// JSON round-trips).
func intVal(payload map[string]any, key string) int {
	if payload == nil {
		return 0
	}
	switch v := payload[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
