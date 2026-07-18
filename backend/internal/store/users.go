package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// usernameCooldown is the minimum spacing between username changes (spec §7d.1).
const usernameCooldown = 7 * 24 * time.Hour

// UsernameChangeCooldownDays reports whether a username change is allowed given
// the last change time, and — when it is not — the whole number of days the
// user must wait (ceil), for the "try again in N days" copy. changedAt is the
// zero time when the username has never been changed (first set is always free).
func UsernameChangeCooldownDays(changedAt, now time.Time) (days int, allowed bool) {
	if changedAt.IsZero() {
		return 0, true
	}
	remaining := usernameCooldown - now.Sub(changedAt)
	if remaining <= 0 {
		return 0, true
	}
	return int(math.Ceil(remaining.Hours() / 24)), false
}

// ErrUsernameRateLimited is returned by UpdateMe when the once-a-week username
// change limit is hit; Days is the ceil'd wait for the error copy.
type ErrUsernameRateLimited struct{ Days int }

func (e ErrUsernameRateLimited) Error() string {
	return fmt.Sprintf("you can change your username once a week — try again in %d days", e.Days)
}

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

// SetUserEmail records the user's email + verification flag (spec §7c.1).
// Only called with a non-empty email; a verified email overwrites any prior
// value, so a later verified source always wins.
func (s *Store) SetUserEmail(ctx context.Context, userID uuid.UUID, email string, verified bool) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			email          = $2,
			email_verified = $3,
			updated_at     = now()
		WHERE id = $1
		  AND (email IS DISTINCT FROM $2 OR email_verified IS DISTINCT FROM $3)`,
		userID, email, verified)
	return err
}

// AdminUserSummary loads the compact admin/warp shape for one user (spec §7c).
// Returns nil when not found.
func (s *Store) AdminUserSummary(ctx context.Context, userID uuid.UUID) (*structs.AdminUser, error) {
	var u structs.AdminUser
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, email::text, avatar_url FROM users WHERE id=$1`, userID,
	).Scan(&u.ID, &u.Username, &u.Email, &u.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// AdminSearchUsers searches users by email OR username (case-insensitive
// substring / trigram), newest first. Admin-only (spec §7c.2).
func (s *Store) AdminSearchUsers(ctx context.Context, q string, limit int) ([]structs.AdminUser, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	pattern := "%" + strings.ToLower(strings.TrimSpace(q)) + "%"
	rows, err := s.pool.Query(ctx, `
		SELECT id, username, email::text, avatar_url
		FROM users
		WHERE lower(email::text) LIKE $1 OR lower(username::text) LIKE $1
		ORDER BY created_at DESC
		LIMIT $2`, pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.AdminUser{}
	for rows.Next() {
		var u structs.AdminUser
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ListUsernameReservations lists/searches admin whitelist rows (spec §7c),
// newest first. A non-empty q filters by username OR email substring.
func (s *Store) ListUsernameReservations(ctx context.Context, q string, limit int) ([]structs.UsernameReservation, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	q = strings.ToLower(strings.TrimSpace(q))
	var rows pgx.Rows
	var err error
	if q == "" {
		rows, err = s.pool.Query(ctx, `
			SELECT username::text, email::text, created_at
			FROM username_reservations
			ORDER BY created_at DESC
			LIMIT $1`, limit)
	} else {
		pattern := "%" + q + "%"
		rows, err = s.pool.Query(ctx, `
			SELECT username::text, email::text, created_at
			FROM username_reservations
			WHERE lower(username::text) LIKE $1 OR lower(email::text) LIKE $1
			ORDER BY created_at DESC
			LIMIT $2`, pattern, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.UsernameReservation{}
	for rows.Next() {
		var r structs.UsernameReservation
		if err := rows.Scan(&r.Username, &r.Email, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertUsernameReservation whitelists `email` for `username` (spec §7c),
// creating or replacing the row. Returns ErrUsernameInUse when the username is
// already claimed by an existing user (you can't whitelist an in-use name). The
// caller must have already validated the username format and lowercased email.
func (s *Store) UpsertUsernameReservation(ctx context.Context, username, email string, createdBy uuid.UUID) (*structs.UsernameReservation, error) {
	// Reject whitelisting a name a real user already holds (citext ⇒ case-insensitive).
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE username=$1)`, username).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrUsernameInUse
	}
	var r structs.UsernameReservation
	err := s.pool.QueryRow(ctx, `
		INSERT INTO username_reservations (username, email, created_by)
		VALUES ($1, $2, $3)
		ON CONFLICT (username) DO UPDATE
			SET email = EXCLUDED.email, created_by = EXCLUDED.created_by
		RETURNING username::text, email::text, created_at`,
		username, email, createdBy,
	).Scan(&r.Username, &r.Email, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// DeleteUsernameReservation removes a whitelist row (spec §7c). The name then
// reverts to default rules (still reserved-by-default if 1–4 chars). Returns
// whether a row was deleted.
func (s *Store) DeleteUsernameReservation(ctx context.Context, username string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM username_reservations WHERE username=$1`, username)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// GetProfileByUsername loads a user page (with counts + the viewer's follow
// status). Returns nil when not found.
func (s *Store) GetProfileByUsername(ctx context.Context, viewerID uuid.UUID, username string) (*structs.Profile, error) {
	var p structs.Profile
	var linksJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.links,
		       u.wallet_address, u.is_private, u.trades_visibility, u.created_at,
		       u.follower_count, u.following_count, u.post_count,
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
	p.Links = []string{}
	if len(linksJSON) > 0 {
		_ = json.Unmarshal(linksJSON, &p.Links)
	}
	p.Onboarded = true // has a username → onboarded
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
		p.Links = []string{}
		if len(linksJSON) > 0 {
			_ = json.Unmarshal(linksJSON, &p.Links)
		}
		p.IsMe = true
		s.attachNotificationPrefs(ctx, userID, &p)
		return &p, nil
	}
	p, err := s.GetProfileByUsername(ctx, userID, username)
	if err != nil || p == nil {
		return p, err
	}
	s.attachNotificationPrefs(ctx, userID, p)
	return p, nil
}

// attachNotificationPrefs loads the owner's private settings (notification
// toggles + server-signing opt-in) onto a /v1/me profile. Only ever called
// for the caller's own profile — never on public user shapes.
func (s *Store) attachNotificationPrefs(ctx context.Context, userID uuid.UUID, p *structs.Profile) {
	var raw []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT notification_prefs, server_signing_enabled FROM users WHERE id=$1`, userID,
	).Scan(&raw, &p.ServerSigningEnabled); err != nil {
		return
	}
	prefs := map[string]bool{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &prefs)
	}
	p.NotificationPrefs = prefs
}

// SetServerSigning flips the server-side signing opt-in (trade API route 2).
func (s *Store) SetServerSigning(ctx context.Context, userID uuid.UUID, enabled bool) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET server_signing_enabled=$2, updated_at=now() WHERE id=$1`, userID, enabled)
	return err
}

// ServerSigningEnabled reports the user's server-side signing opt-in.
func (s *Store) ServerSigningEnabled(ctx context.Context, userID uuid.UUID) bool {
	var on bool
	if err := s.pool.QueryRow(ctx,
		`SELECT server_signing_enabled FROM users WHERE id=$1`, userID).Scan(&on); err != nil {
		return false
	}
	return on
}

// NotificationCategoryEnabled reports whether the user has the given
// notification category switched on. A missing key (or any lookup error)
// means enabled — notifications default on.
func (s *Store) NotificationCategoryEnabled(ctx context.Context, userID uuid.UUID, category string) bool {
	enabled := true
	if err := s.pool.QueryRow(ctx,
		`SELECT COALESCE((notification_prefs->>$2)::boolean, true) FROM users WHERE id=$1`,
		userID, category).Scan(&enabled); err != nil {
		return true
	}
	return enabled
}

// UpdateMeParams are the PATCH /v1/me optionals. The claimer's identity fields
// (from the VERIFIED auth.Identity, never client input — spec §7c) drive
// username-reservation enforcement on a username change.
type UpdateMeParams struct {
	Username    *string
	DisplayName *string
	Bio         *string
	AvatarURL   *string
	Links       []string

	// IsAdmin exempts the claimer from ALL username reservation checks.
	IsAdmin bool
	// ClaimerEmail / ClaimerEmailVerified are the claimer's verified account
	// email used to satisfy a per-username whitelist row.
	ClaimerEmail         string
	ClaimerEmailVerified bool
}

// ErrUsernameTaken is returned when the requested username is already in use OR
// is reserved (by length or by a whitelist row for a different email). The two
// cases are deliberately indistinguishable to non-admins (spec §7c): a reserved
// name behaves exactly like a taken one.
var ErrUsernameTaken = errors.New("username taken")

// ErrUsernameInUse is returned by UpsertUsernameReservation when an admin tries
// to whitelist a username already claimed by an existing user (admin-facing).
var ErrUsernameInUse = errors.New("username is already in use by a user")

// UsernameClaimAllowed decides whether a claimer may take `username` given the
// reservation state (spec §7c). Pure so it is unit-testable without Postgres.
//
//   - Admins bypass every reservation rule.
//   - When a whitelist row exists (hasReservation), only a claimer whose
//     VERIFIED email matches the reserved email may claim it.
//   - Otherwise every 1–4 character username is reserved by default (blocked);
//     5+ character names with no whitelist row are free.
func UsernameClaimAllowed(username string, isAdmin, emailVerified bool, claimerEmail, reservedEmail string, hasReservation bool) bool {
	if isAdmin {
		return true
	}
	if hasReservation {
		return emailVerified &&
			strings.EqualFold(strings.TrimSpace(claimerEmail), strings.TrimSpace(reservedEmail))
	}
	n := len(strings.TrimSpace(strings.ToLower(username)))
	return n < 1 || n > 4 // 1–4 chars reserved by default
}

// UpdateMe applies profile edits. A username change is throttled to once per
// week (spec §7d.1): when the username actually changes and the previous change
// was < 7 days ago it returns ErrUsernameRateLimited; on an allowed change
// username_changed_at is stamped now(). The first set (from NULL / onboarding)
// is always allowed. The whole edit runs in one transaction so the throttle
// check and the write are consistent under concurrent PATCHes.
func (s *Store) UpdateMe(ctx context.Context, userID uuid.UUID, p UpdateMeParams) error {
	var linksJSON any
	if p.Links != nil {
		b, err := json.Marshal(p.Links)
		if err != nil {
			return err
		}
		linksJSON = b
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Determine whether the username actually changes (and enforce the throttle
	// only then). Same-value "changes" are treated as no-ops.
	usernameChanges := false
	if p.Username != nil {
		var cur *string
		var changedAt *time.Time
		if err := tx.QueryRow(ctx,
			`SELECT username::text, username_changed_at FROM users WHERE id=$1`, userID,
		).Scan(&cur, &changedAt); err != nil {
			return err
		}
		if cur == nil || !strings.EqualFold(*cur, *p.Username) {
			usernameChanges = true
			last := time.Time{}
			if changedAt != nil {
				last = *changedAt
			}
			if days, ok := UsernameChangeCooldownDays(last, time.Now()); !ok {
				return ErrUsernameRateLimited{Days: days}
			}

			// Reservation enforcement (spec §7c). Look up any whitelist row for
			// the requested name, then apply the pure decision. A reserved name
			// returns the SAME ErrUsernameTaken a taken name would — reserved
			// and taken are indistinguishable to non-admins.
			var reservedEmail string
			hasReservation := false
			err := tx.QueryRow(ctx,
				`SELECT email::text FROM username_reservations WHERE username=$1`, *p.Username,
			).Scan(&reservedEmail)
			switch {
			case err == nil:
				hasReservation = true
			case errors.Is(err, pgx.ErrNoRows):
				hasReservation = false
			default:
				return err
			}
			if !UsernameClaimAllowed(*p.Username, p.IsAdmin, p.ClaimerEmailVerified,
				p.ClaimerEmail, reservedEmail, hasReservation) {
				return ErrUsernameTaken
			}
		}
	}

	var newUsername *string
	if usernameChanges {
		newUsername = p.Username
	}
	_, err = tx.Exec(ctx, `
		UPDATE users SET
			username            = COALESCE($2, username),
			username_changed_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE username_changed_at END,
			display_name        = COALESCE($3, display_name),
			bio                 = COALESCE($4, bio),
			avatar_url          = COALESCE($5, avatar_url),
			links               = COALESCE($6, links),
			updated_at          = now()
		WHERE id=$1`,
		userID, newUsername, p.DisplayName, p.Bio, p.AvatarURL, linksJSON)
	if err != nil {
		if strings.Contains(err.Error(), "users_username_key") {
			return ErrUsernameTaken
		}
		return err
	}
	return tx.Commit(ctx)
}

// SearchUsers is the @-mention autocomplete (spec §7d.2): trigram match over
// username + display_name, best-match first. Only onboarded (username-bearing)
// users are returned.
func (s *Store) SearchUsers(ctx context.Context, q string, limit int) ([]structs.UserBrief, error) {
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	q = strings.ToLower(strings.TrimSpace(q))
	pattern := "%" + q + "%"
	return s.queryBriefs(ctx, `
		SELECT `+userBriefCols+`
		FROM users u
		WHERE u.username IS NOT NULL
		  AND (lower(u.username::text) LIKE $1 OR lower(coalesce(u.display_name,'')) LIKE $1)
		ORDER BY GREATEST(
			similarity(lower(u.username::text), $2),
			similarity(lower(coalesce(u.display_name,'')), $2)) DESC,
			u.follower_count DESC
		LIMIT $3`, pattern, q, limit)
}

// FilterExistingUsers returns the subset of ids that reference real users
// (deduped). Used to validate @-mention targets before storing them.
func (s *Store) FilterExistingUsers(ctx context.Context, ids []uuid.UUID) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM users WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// PushTokensForUser lists a user's device push tokens (spec §7d.4 push leg).
func (s *Store) PushTokensForUser(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT token FROM push_tokens WHERE user_id=$1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeletePushTokens prunes tokens Expo reported as DeviceNotRegistered.
func (s *Store) DeletePushTokens(ctx context.Context, tokens []string) error {
	if len(tokens) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM push_tokens WHERE token = ANY($1)`, tokens)
	return err
}

// UpdateSettings applies the privacy toggles (PATCH /v1/me/settings). When an
// account flips public, all pending follow requests are auto-accepted.
func (s *Store) UpdateSettings(ctx context.Context, userID uuid.UUID, isPrivate *bool, tradesVisibility *string, notificationPrefs map[string]bool) error {
	var prefsJSON []byte
	if notificationPrefs != nil {
		prefsJSON, _ = json.Marshal(notificationPrefs)
	}
	// notification_prefs merges (jsonb ||) so the client can PATCH one toggle
	// at a time without clobbering the others.
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			is_private         = COALESCE($2, is_private),
			trades_visibility  = COALESCE($3, trades_visibility),
			notification_prefs = CASE WHEN $4::jsonb IS NULL THEN notification_prefs ELSE notification_prefs || $4::jsonb END,
			updated_at         = now()
		WHERE id=$1`, userID, isPrivate, tradesVisibility, prefsJSON)
	if err != nil {
		return err
	}
	if isPrivate != nil && !*isPrivate {
		_, err = s.pool.Exec(ctx,
			`UPDATE follows SET status='accepted' WHERE followee_id=$1 AND status='pending'`, userID)
	}
	return err
}

// LinkWallet sets the user's wallet address when none is linked yet. Setting
// the same address again is a no-op; a different address on an already-linked
// account is rejected (the wallet binds once — §8.1).
func (s *Store) LinkWallet(ctx context.Context, userID uuid.UUID, wallet string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users SET wallet_address=$2, updated_at=now()
		WHERE id=$1 AND (wallet_address IS NULL OR wallet_address='' OR lower(wallet_address)=lower($2))`,
		userID, wallet)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("a different wallet is already linked")
	}
	return nil
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
	// Explicit ::uuid casts: the predicate compares the two bare parameters
	// ($1 = $2), which Postgres otherwise can't type-infer (uuid = text).
	err := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s`, visiblePred("$1::uuid", "$2::uuid")), authorID, viewerID).Scan(&ok)
	return ok, err
}

// CanViewTrades reports whether the viewer may see the author's trading data.
func (s *Store) CanViewTrades(ctx context.Context, viewerID, authorID uuid.UUID) (bool, error) {
	var ok bool
	// Explicit ::uuid casts: the predicate compares the two bare parameters
	// ($1 = $2), which Postgres otherwise can't type-infer (uuid = text).
	err := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s`, tradesVisiblePred("$1::uuid", "$2::uuid")), authorID, viewerID).Scan(&ok)
	return ok, err
}

// RegisterPushToken stores a device push token for later delivery.
func (s *Store) RegisterPushToken(ctx context.Context, userID uuid.UUID, token, platform string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
		ON CONFLICT (token) DO UPDATE SET user_id=$1, platform=$3`, userID, token, platform)
	return err
}
