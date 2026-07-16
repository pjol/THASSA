package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

const userBriefCols = `u.id, u.username, u.display_name, u.avatar_url`

// UpsertUserByPrivyDID lazily provisions the local users row on first contact
// with a verified token, capturing/refreshing the linked wallet address.
func (s *Store) UpsertUserByPrivyDID(ctx context.Context, did, wallet string) (uuid.UUID, string, string, error) {
	var (
		id       uuid.UUID
		username *string
		walletDB *string
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (privy_did, wallet_address)
		VALUES ($1, NULLIF($2,''))
		ON CONFLICT (privy_did) DO UPDATE
			SET wallet_address = COALESCE(NULLIF($2,''), users.wallet_address),
			    updated_at = now()
		RETURNING id, username, wallet_address`,
		did, strings.ToLower(wallet),
	).Scan(&id, &username, &walletDB)
	if err != nil {
		return uuid.Nil, "", "", err
	}
	un, w := "", ""
	if username != nil {
		un = *username
	}
	if walletDB != nil {
		w = *walletDB
	}
	return id, un, w, nil
}

// GetProfileByUsername loads a user page (with counts + the viewer's follow
// status). Returns nil when not found.
func (s *Store) GetProfileByUsername(ctx context.Context, viewerID uuid.UUID, username string) (*structs.Profile, error) {
	var p structs.Profile
	var linksJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.links,
		       u.wallet_address, u.is_private, u.trades_visibility, u.created_at,
		       (SELECT count(*) FROM follows f WHERE f.followee_id=u.id AND f.status='accepted'),
		       (SELECT count(*) FROM follows f WHERE f.follower_id=u.id AND f.status='accepted'),
		       (SELECT count(*) FROM posts p WHERE p.author_id=u.id AND p.deleted_at IS NULL),
		       COALESCE((SELECT f.status FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id), '')
		FROM users u WHERE u.username = $2`,
		viewerID, username,
	).Scan(&p.ID, &p.Username, &p.DisplayName, &p.AvatarURL, &p.Bio, &linksJSON,
		&p.WalletAddress, &p.IsPrivate, &p.TradesVisibility, &p.CreatedAt,
		&p.FollowerCount, &p.FollowingCount, &p.PostCount, &p.FollowStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Links = []structs.Link{}
	if len(linksJSON) > 0 {
		_ = json.Unmarshal(linksJSON, &p.Links)
	}
	p.IsMe = p.ID == viewerID
	return &p, nil
}

// GetMe loads the caller's own profile by id.
func (s *Store) GetMe(ctx context.Context, userID uuid.UUID) (*structs.Profile, error) {
	var username string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(username::text,'') FROM users WHERE id=$1`, userID).Scan(&username)
	if err != nil {
		return nil, err
	}
	if username == "" {
		// Not yet onboarded: build a minimal profile.
		var p structs.Profile
		var linksJSON []byte
		err := s.pool.QueryRow(ctx, `
			SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.links,
			       u.wallet_address, u.is_private, u.trades_visibility, u.created_at
			FROM users u WHERE u.id=$1`, userID,
		).Scan(&p.ID, &p.Username, &p.DisplayName, &p.AvatarURL, &p.Bio, &linksJSON,
			&p.WalletAddress, &p.IsPrivate, &p.TradesVisibility, &p.CreatedAt)
		if err != nil {
			return nil, err
		}
		p.Links = []structs.Link{}
		if len(linksJSON) > 0 {
			_ = json.Unmarshal(linksJSON, &p.Links)
		}
		p.IsMe = true
		return &p, nil
	}
	return s.GetProfileByUsername(ctx, userID, username)
}

// UpdateMeParams are the PATCH /v1/me optionals.
type UpdateMeParams struct {
	Username    *string
	DisplayName *string
	Bio         *string
	AvatarURL   *string
	Links       []structs.Link
}

// ErrUsernameTaken is returned when the requested username is already in use.
var ErrUsernameTaken = errors.New("username taken")

// UpdateMe applies profile edits.
func (s *Store) UpdateMe(ctx context.Context, userID uuid.UUID, p UpdateMeParams) error {
	var linksJSON any
	if p.Links != nil {
		b, err := json.Marshal(p.Links)
		if err != nil {
			return err
		}
		linksJSON = b
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			username     = COALESCE($2, username),
			display_name = COALESCE($3, display_name),
			bio          = COALESCE($4, bio),
			avatar_url   = COALESCE($5, avatar_url),
			links        = COALESCE($6, links),
			updated_at   = now()
		WHERE id=$1`,
		userID, p.Username, p.DisplayName, p.Bio, p.AvatarURL, linksJSON)
	if err != nil && strings.Contains(err.Error(), "users_username_key") {
		return ErrUsernameTaken
	}
	return err
}

// UpdateSettings applies the privacy toggles (PATCH /v1/me/settings). When an
// account flips public, all pending follow requests are auto-accepted.
func (s *Store) UpdateSettings(ctx context.Context, userID uuid.UUID, isPrivate *bool, tradesVisibility *string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			is_private        = COALESCE($2, is_private),
			trades_visibility = COALESCE($3, trades_visibility),
			updated_at        = now()
		WHERE id=$1`, userID, isPrivate, tradesVisibility)
	if err != nil {
		return err
	}
	if isPrivate != nil && !*isPrivate {
		_, err = s.pool.Exec(ctx,
			`UPDATE follows SET status='accepted' WHERE followee_id=$1 AND status='pending'`, userID)
	}
	return err
}

// SetAvatar updates the avatar URL.
func (s *Store) SetAvatar(ctx context.Context, userID uuid.UUID, url string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET avatar_url=$2, updated_at=now() WHERE id=$1`, userID, url)
	return err
}

// UserBrief loads the compact shape for one user.
func (s *Store) UserBrief(ctx context.Context, userID uuid.UUID) (*structs.UserBrief, error) {
	var b structs.UserBrief
	err := s.pool.QueryRow(ctx,
		`SELECT `+userBriefCols+` FROM users u WHERE u.id=$1`, userID,
	).Scan(&b.ID, &b.Username, &b.DisplayName, &b.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// UserIDByUsername resolves a username. Returns uuid.Nil when unknown.
func (s *Store) UserIDByUsername(ctx context.Context, username string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE username=$1`, username).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

// UserWallet returns the user's wallet address ("" if none linked).
func (s *Store) UserWallet(ctx context.Context, userID uuid.UUID) (string, error) {
	var w *string
	if err := s.pool.QueryRow(ctx, `SELECT wallet_address FROM users WHERE id=$1`, userID).Scan(&w); err != nil {
		return "", err
	}
	if w == nil {
		return "", nil
	}
	return *w, nil
}

// UserIDByWallet resolves a wallet address to a user id (uuid.Nil if unknown).
func (s *Store) UserIDByWallet(ctx context.Context, wallet string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM users WHERE lower(wallet_address)=lower($1)`, wallet).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

// CanViewUser reports whether the viewer may see the author's content
// (private-account rule).
func (s *Store) CanViewUser(ctx context.Context, viewerID, authorID uuid.UUID) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s`, visiblePred("$1", "$2")), authorID, viewerID).Scan(&ok)
	return ok, err
}

// CanViewTrades reports whether the viewer may see the author's trading data.
func (s *Store) CanViewTrades(ctx context.Context, viewerID, authorID uuid.UUID) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s`, tradesVisiblePred("$1", "$2")), authorID, viewerID).Scan(&ok)
	return ok, err
}

// RegisterPushToken stores a device push token for later delivery.
func (s *Store) RegisterPushToken(ctx context.Context, userID uuid.UUID, token, platform string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
		ON CONFLICT (token) DO UPDATE SET user_id=$1, platform=$3`, userID, token, platform)
	return err
}
