package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// IsConversationMember reports channel-level authz for DMs (REST + WS).
func (s *Store) IsConversationMember(ctx context.Context, convID, userID uuid.UUID) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2)`,
		convID, userID).Scan(&ok)
	return ok, err
}

// ConversationMemberIDs returns all member user ids of a conversation.
func (s *Store) ConversationMemberIDs(ctx context.Context, convID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT user_id FROM conversation_members WHERE conversation_id=$1`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetOrCreateConversation creates a dm/group thread with the given members
// (creator always included). For kind=dm with exactly one other member, an
// existing DM between the pair is reused.
func (s *Store) GetOrCreateConversation(ctx context.Context, creatorID uuid.UUID, kind string, memberIDs []uuid.UUID) (uuid.UUID, error) {
	members := map[uuid.UUID]struct{}{creatorID: {}}
	for _, m := range memberIDs {
		members[m] = struct{}{}
	}
	if kind == "dm" && len(members) == 2 {
		var other uuid.UUID
		for m := range members {
			if m != creatorID {
				other = m
			}
		}
		var existing uuid.UUID
		err := s.pool.QueryRow(ctx, `
			SELECT c.id FROM conversations c
			WHERE c.kind='dm'
			  AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1)
			  AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2)
			  AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id=c.id) = 2
			LIMIT 1`, creatorID, other).Scan(&existing)
		if err == nil {
			return existing, nil
		}
	}
	if len(members) > 2 {
		kind = "group"
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)

	var convID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO conversations (kind) VALUES ($1) RETURNING id`, kind).Scan(&convID); err != nil {
		return uuid.Nil, err
	}
	for m := range members {
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id)
			SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2)
			ON CONFLICT DO NOTHING`, convID, m); err != nil {
			return uuid.Nil, err
		}
	}
	return convID, tx.Commit(ctx)
}

// Conversations lists the caller's threads, newest activity first. The first
// `inline` conversations include their most recent messages so the client can
// pre-fetch threads for instant open.
func (s *Store) Conversations(ctx context.Context, userID uuid.UUID, limit, inline, inlineMessages int) ([]structs.Conversation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.kind, c.created_at,
		       (SELECT count(*) FROM messages m
		        WHERE m.conversation_id=c.id AND m.sender_id<>$1
		          AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at))
		FROM conversations c
		JOIN conversation_members me ON me.conversation_id=c.id AND me.user_id=$1
		ORDER BY (SELECT max(created_at) FROM messages m WHERE m.conversation_id=c.id) DESC NULLS LAST,
		         c.created_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	out := []structs.Conversation{}
	for rows.Next() {
		var c structs.Conversation
		if err := rows.Scan(&c.ID, &c.Kind, &c.CreatedAt, &c.Unread); err != nil {
			rows.Close()
			return nil, err
		}
		c.Members = []structs.ConversationMember{}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range out {
		members, err := s.conversationMembers(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Members = members

		n := 1
		if i < inline {
			n = inlineMessages
		}
		msgs, _, err := s.Messages(ctx, out[i].ID, FeedOpts{Limit: n})
		if err != nil {
			return nil, err
		}
		if len(msgs) > 0 {
			out[i].LastMessage = &msgs[0]
		}
		if i < inline {
			out[i].RecentMessages = msgs
		}
	}
	return out, nil
}

// conversationMembers loads members with their read state (last_read_at
// exposed per member for client read receipts).
func (s *Store) conversationMembers(ctx context.Context, convID uuid.UUID) ([]structs.ConversationMember, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+userBriefCols+`, cm.last_read_at
		FROM conversation_members cm JOIN users u ON u.id=cm.user_id
		WHERE cm.conversation_id=$1 ORDER BY cm.created_at`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.ConversationMember{}
	for rows.Next() {
		var m structs.ConversationMember
		if err := rows.Scan(&m.ID, &m.Username, &m.DisplayName, &m.AvatarURL, &m.LastReadAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Messages returns a conversation's messages newest-first (keyset paginated);
// clients render in reverse.
func (s *Store) Messages(ctx context.Context, convID uuid.UUID, o FeedOpts) ([]structs.Message, *string, error) {
	sql := `
		SELECT m.id, m.conversation_id, ` + userBriefCols + `, m.body,
		       m.media_kind, m.s3_key, m.hls_key, m.reply_to_id, m.created_at,
		       (SELECT json_object_agg(emoji, cnt) FROM (
		            SELECT emoji, count(*) cnt FROM reactions
		            WHERE subject_type='message' AND subject_id=m.id GROUP BY emoji) z)
		FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.conversation_id=$1`
	args := []any{convID}
	if o.Cursor != nil {
		sql += ` AND (m.created_at, m.id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY m.created_at DESC, m.id DESC LIMIT %d`, o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []structs.Message{}
	for rows.Next() {
		m, err := scanMessage(rows.Scan)
		if err != nil {
			return nil, nil, err
		}
		m.MediaURL = s.urlPtr(m.MediaURL) // stored key -> URL
		m.HLSURL = s.urlPtr(m.HLSURL)
		out = append(out, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(out); n > 0 && n >= o.Limit {
		next = NextCursor(n, o.Limit, out[n-1].CreatedAt, out[n-1].ID)
	}
	return out, next, nil
}

func scanMessage(scan func(...any) error) (*structs.Message, error) {
	var m structs.Message
	var reactionsJSON []byte
	if err := scan(&m.ID, &m.ConversationID, &m.Sender.ID, &m.Sender.Username,
		&m.Sender.DisplayName, &m.Sender.AvatarURL, &m.Body,
		&m.MediaKind, &m.MediaURL, &m.HLSURL, &m.ReplyToID, &m.CreatedAt, &reactionsJSON); err != nil {
		return nil, err
	}
	m.Reactions = map[string]int{}
	if len(reactionsJSON) > 0 {
		_ = unmarshalCounts(reactionsJSON, m.Reactions)
	}
	return &m, nil
}

// SendMessage inserts a message (text and/or one media attachment copied from
// an uploaded media row owned by the sender).
func (s *Store) SendMessage(ctx context.Context, convID, senderID uuid.UUID, body *string, mediaID, replyToID *uuid.UUID) (*structs.Message, error) {
	var mediaKind, s3Key, hlsKey *string
	if mediaID != nil {
		err := s.pool.QueryRow(ctx,
			`SELECT kind, s3_key, hls_key FROM post_media WHERE id=$1 AND owner_id=$2`,
			*mediaID, senderID).Scan(&mediaKind, &s3Key, &hlsKey)
		if err != nil {
			return nil, errors.New("media not found")
		}
	}
	var m structs.Message
	err := s.pool.QueryRow(ctx, `
		INSERT INTO messages (conversation_id, sender_id, body, media_kind, s3_key, hls_key, reply_to_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, conversation_id, body, media_kind, s3_key, hls_key, reply_to_id, created_at`,
		convID, senderID, body, mediaKind, s3Key, hlsKey, replyToID,
	).Scan(&m.ID, &m.ConversationID, &m.Body, &m.MediaKind, &m.MediaURL, &m.HLSURL, &m.ReplyToID, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	m.MediaURL = s.urlPtr(m.MediaURL)
	m.HLSURL = s.urlPtr(m.HLSURL)
	m.Reactions = map[string]int{}
	if err := s.pool.QueryRow(ctx,
		`SELECT `+userBriefCols+` FROM users u WHERE u.id=$1`, senderID,
	).Scan(&m.Sender.ID, &m.Sender.Username, &m.Sender.DisplayName, &m.Sender.AvatarURL); err != nil {
		return nil, err
	}
	return &m, nil
}

// MarkConversationRead stamps the caller's read pointer.
func (s *Store) MarkConversationRead(ctx context.Context, convID, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE conversation_members SET last_read_at=now()
		WHERE conversation_id=$1 AND user_id=$2`, convID, userID)
	return err
}

func unmarshalCounts(b []byte, dst map[string]int) error {
	return json.Unmarshal(b, &dst)
}
