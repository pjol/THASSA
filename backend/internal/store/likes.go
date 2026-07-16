package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// LikeSubjects / ReactionSubjects are the allowed subject_type values.
var (
	LikeSubjects     = map[string]bool{"post": true, "comment": true, "market": true}
	ReactionSubjects = map[string]bool{"post": true, "comment": true, "market": true, "message": true}
)

// subjectTable maps subject_type to (table, counter column present?).
func subjectTable(subjectType string) (table string, hasCounter bool) {
	switch subjectType {
	case "post":
		return "posts", true
	case "comment":
		return "comments", true
	case "market":
		return "markets", false
	case "message":
		return "messages", false
	}
	return "", false
}

// Like adds the caller's like. Returns the subject owner's user id (for the
// post.liked notification) and the new like count.
func (s *Store) Like(ctx context.Context, userID uuid.UUID, subjectType string, subjectID uuid.UUID) (uuid.UUID, int, error) {
	if !LikeSubjects[subjectType] {
		return uuid.Nil, 0, errors.New("invalid subject_type")
	}
	table, hasCounter := subjectTable(subjectType)
	ownerCol := "author_id"
	if subjectType == "market" {
		ownerCol = "creator_id"
	}
	var owner uuid.UUID
	if err := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s FROM %s WHERE id=$1`, ownerCol, table), subjectID,
	).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, 0, errors.New("subject not found")
		}
		return uuid.Nil, 0, err
	}

	tag, err := s.pool.Exec(ctx, `
		INSERT INTO likes (subject_type, subject_id, user_id) VALUES ($1,$2,$3)
		ON CONFLICT DO NOTHING`, subjectType, subjectID, userID)
	if err != nil {
		return uuid.Nil, 0, err
	}
	if hasCounter && tag.RowsAffected() > 0 {
		_, _ = s.pool.Exec(ctx,
			fmt.Sprintf(`UPDATE %s SET like_count=like_count+1 WHERE id=$1`, table), subjectID)
	}
	count, err := s.likeCount(ctx, subjectType, subjectID)
	return owner, count, err
}

// Unlike removes the caller's like and returns the new count.
func (s *Store) Unlike(ctx context.Context, userID uuid.UUID, subjectType string, subjectID uuid.UUID) (int, error) {
	if !LikeSubjects[subjectType] {
		return 0, errors.New("invalid subject_type")
	}
	table, hasCounter := subjectTable(subjectType)
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM likes WHERE subject_type=$1 AND subject_id=$2 AND user_id=$3`,
		subjectType, subjectID, userID)
	if err != nil {
		return 0, err
	}
	if hasCounter && tag.RowsAffected() > 0 {
		_, _ = s.pool.Exec(ctx,
			fmt.Sprintf(`UPDATE %s SET like_count=GREATEST(like_count-1,0) WHERE id=$1`, table), subjectID)
	}
	return s.likeCount(ctx, subjectType, subjectID)
}

func (s *Store) likeCount(ctx context.Context, subjectType string, subjectID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM likes WHERE subject_type=$1 AND subject_id=$2`,
		subjectType, subjectID).Scan(&n)
	return n, err
}

// React sets (or, when the same emoji is sent again, toggles off) the caller's
// reaction on a subject. Returns the emoji breakdown and the caller's current
// reaction ("" when removed).
func (s *Store) React(ctx context.Context, userID uuid.UUID, subjectType string, subjectID uuid.UUID, emoji string) (map[string]int, string, error) {
	if !ReactionSubjects[subjectType] {
		return nil, "", errors.New("invalid subject_type")
	}
	var current string
	_ = s.pool.QueryRow(ctx,
		`SELECT emoji FROM reactions WHERE subject_type=$1 AND subject_id=$2 AND user_id=$3`,
		subjectType, subjectID, userID).Scan(&current)
	var mine string
	if current == emoji {
		if _, err := s.pool.Exec(ctx,
			`DELETE FROM reactions WHERE subject_type=$1 AND subject_id=$2 AND user_id=$3`,
			subjectType, subjectID, userID); err != nil {
			return nil, "", err
		}
	} else {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO reactions (subject_type, subject_id, user_id, emoji) VALUES ($1,$2,$3,$4)
			ON CONFLICT (subject_type, subject_id, user_id) DO UPDATE SET emoji=$4, created_at=now()`,
			subjectType, subjectID, userID, emoji); err != nil {
			return nil, "", err
		}
		mine = emoji
	}
	breakdown, err := s.ReactionBreakdown(ctx, subjectType, subjectID)
	return breakdown, mine, err
}

// Unreact removes the caller's reaction.
func (s *Store) Unreact(ctx context.Context, userID uuid.UUID, subjectType string, subjectID uuid.UUID) (map[string]int, error) {
	if !ReactionSubjects[subjectType] {
		return nil, errors.New("invalid subject_type")
	}
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM reactions WHERE subject_type=$1 AND subject_id=$2 AND user_id=$3`,
		subjectType, subjectID, userID); err != nil {
		return nil, err
	}
	return s.ReactionBreakdown(ctx, subjectType, subjectID)
}

// ReactionBreakdown tallies reactions per emoji for a subject.
func (s *Store) ReactionBreakdown(ctx context.Context, subjectType string, subjectID uuid.UUID) (map[string]int, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT emoji, count(*) FROM reactions WHERE subject_type=$1 AND subject_id=$2 GROUP BY emoji`,
		subjectType, subjectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var e string
		var c int
		if err := rows.Scan(&e, &c); err != nil {
			return nil, err
		}
		out[e] = c
	}
	return out, rows.Err()
}
