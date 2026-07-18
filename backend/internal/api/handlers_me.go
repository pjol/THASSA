package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// normalizeURL validates a user-entered profile link and returns a canonical
// form. A missing scheme defaults to https. It requires an http(s) scheme and a
// host containing a dot (a real domain), rejecting anything else.
func normalizeURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	if u.Host == "" || !strings.Contains(u.Host, ".") {
		return "", false
	}
	return u.String(), true
}

// handleGetMe returns the caller's own profile. While warped (spec §7c.2) it
// returns the EFFECTIVE (target) user plus a warp object describing the
// impersonation; otherwise it includes is_admin for the real user.
func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context()) // effective identity
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	s.writeMe(w, r, me)
}

// writeMe responds with the caller's own profile as a single flat "me" object
// that BOTH clients consume: the profile fields plus the request-scoped
// is_admin (or, while warped, the warp descriptor). The frontends read
// `res.me` and expect onboarded/is_admin/warp on that one object — returning
// is_admin/warp as siblings of a "user" key (as this used to) meant neither
// client ever saw `onboarded`, so onboarding looped forever.
func (s *Server) writeMe(w http.ResponseWriter, r *http.Request, me *structs.Profile) {
	b, err := json.Marshal(me)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	id, _ := auth.FromContext(r.Context()) // effective identity
	if auth.IsWarped(r.Context()) {
		real, _ := auth.RealIdentity(r.Context())
		m["warp"] = map[string]any{
			"active":      true,
			"admin_email": real.Email,
			"viewing": map[string]any{
				"id":       id.UserID,
				"username": id.Username,
				"email":    id.Email,
			},
		}
	} else {
		m["is_admin"] = id.IsAdmin
	}
	respond.JSON(w, http.StatusOK, map[string]any{"me": m})
}

// usernameRE is the username FORMAT gate: lowercase a-z 0-9 _ . and 1–30 long.
// The minimum is 1 (not 3) on purpose: 1–4 character names are reserved rather
// than rejected outright (spec §7c), so a non-admin who tries one gets the
// "username taken" 409 from the reservation layer — indistinguishable from an
// in-use name — instead of a length hint. Admins and whitelisted emails can
// legitimately hold short names, which is why the format gate must admit them.
var usernameRE = regexp.MustCompile(`^[a-z0-9_.]{1,30}$`)

type updateMeRequest struct {
	Username    *string  `json:"username"`
	DisplayName *string  `json:"display_name"`
	Bio         *string  `json:"bio"`
	AvatarURL   *string  `json:"avatar_url"`
	Links       []string `json:"links"`
	// Onboarded is accepted for client compatibility but is derived from the
	// username (setting a username IS onboarding), so it's advisory only.
	Onboarded *bool `json:"onboarded"`
}

// handleUpdateMe applies profile edits (username, bio, links, avatar).
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req updateMeRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Username != nil && !usernameRE.MatchString(*req.Username) {
		respond.Error(w, http.StatusBadRequest, "username must be 1-30 chars: a-z 0-9 _ .")
		return
	}
	if req.Bio != nil && len(*req.Bio) > 500 {
		respond.Error(w, http.StatusBadRequest, "bio too long")
		return
	}
	// A profile carries at most ONE link, and it must be a well-formed URL.
	if req.Links != nil {
		if len(req.Links) > 1 {
			respond.Error(w, http.StatusBadRequest, "you can add only one link")
			return
		}
		normalized := make([]string, 0, len(req.Links))
		for _, raw := range req.Links {
			if strings.TrimSpace(raw) == "" {
				continue
			}
			u, ok := normalizeURL(raw)
			if !ok {
				respond.Error(w, http.StatusBadRequest, "enter a valid link, e.g. https://example.com")
				return
			}
			normalized = append(normalized, u)
		}
		req.Links = normalized
	}
	// Reservation enforcement keys off the VERIFIED identity (spec §7c): the
	// email + is_admin come from the token-resolved Identity, never the body.
	err := s.db.UpdateMe(r.Context(), id.UserID, store.UpdateMeParams{
		Username:             req.Username,
		DisplayName:          req.DisplayName,
		Bio:                  req.Bio,
		AvatarURL:            req.AvatarURL,
		Links:                req.Links,
		IsAdmin:              id.IsAdmin,
		ClaimerEmail:         id.Email,
		ClaimerEmailVerified: id.EmailVerified,
	})
	if errors.Is(err, store.ErrUsernameTaken) {
		respond.Error(w, http.StatusConflict, "username taken")
		return
	}
	// Username-change throttle (spec §7d.1): 409 with the "try again in N days"
	// copy carrying the computed wait.
	var rateLimited store.ErrUsernameRateLimited
	if errors.As(err, &rateLimited) {
		respond.Error(w, http.StatusConflict, rateLimited.Error())
		return
	}
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	s.writeMe(w, r, me)
}

type updateSettingsRequest struct {
	IsPrivate         *bool           `json:"is_private"`
	TradesVisibility  *string         `json:"trades_visibility"`
	NotificationPrefs map[string]bool `json:"notification_prefs"`
}

// handleUpdateSettings toggles account privacy, trades visibility, and
// per-category notification preferences (partial: sent keys merge over the
// stored map).
func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req updateSettingsRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.TradesVisibility != nil && *req.TradesVisibility != "public" && *req.TradesVisibility != "private" {
		respond.Error(w, http.StatusBadRequest, "trades_visibility must be public or private")
		return
	}
	for k := range req.NotificationPrefs {
		if !slices.Contains(notify.Categories, k) {
			respond.Error(w, http.StatusBadRequest, "unknown notification category: "+k)
			return
		}
	}
	if err := s.db.UpdateSettings(r.Context(), id.UserID, req.IsPrivate, req.TradesVisibility, req.NotificationPrefs); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to update settings")
		return
	}
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	s.writeMe(w, r, me)
}

type linkWalletRequest struct {
	Address string `json:"address"`
}

var walletAddrRE = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

// handleLinkWallet registers the client's embedded wallet address. Privy
// access tokens don't always carry a wallet claim, so the app registers the
// embedded wallet it controls on first use; when the Privy server API is
// configured, the address is verified against the DID's linked accounts
// before being accepted (dev trusts the authenticated client). The wallet
// binds once — a different address on a linked account is rejected.
func (s *Server) handleLinkWallet(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req linkWalletRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	addr := strings.TrimSpace(req.Address)
	if !walletAddrRE.MatchString(addr) {
		respond.Error(w, http.StatusBadRequest, "invalid wallet address")
		return
	}
	if id.Wallet != "" && !strings.EqualFold(id.Wallet, addr) {
		respond.Error(w, http.StatusConflict, "a different wallet is already linked")
		return
	}
	if s.privyAPI.Enabled() {
		linked, err := s.privyAPI.WalletForDID(r.Context(), id.PrivyDID)
		if err != nil {
			respond.Error(w, http.StatusServiceUnavailable, "could not verify wallet ownership")
			return
		}
		if linked == "" || !strings.EqualFold(linked, addr) {
			respond.Error(w, http.StatusForbidden, "wallet does not belong to this account")
			return
		}
	}
	if err := s.db.LinkWallet(r.Context(), id.UserID, strings.ToLower(addr)); err != nil {
		respond.Error(w, http.StatusConflict, err.Error())
		return
	}
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	s.writeMe(w, r, me)
}

type setAvatarRequest struct {
	MediaID *string `json:"media_id"`
	URL     *string `json:"url"`
}

// handleSetAvatar sets the avatar from an uploaded media id (preferred) or a
// previously-presigned public URL.
func (s *Server) handleSetAvatar(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req setAvatarRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	var url string
	switch {
	case req.MediaID != nil:
		mid, err := uuid.Parse(*req.MediaID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid media id")
			return
		}
		media, ownerID, _, err := s.db.GetMedia(r.Context(), mid)
		if err != nil || media == nil {
			respond.Error(w, http.StatusNotFound, "media not found")
			return
		}
		if ownerID != id.UserID { // §8.1: ownership from the token id only
			respond.Error(w, http.StatusNotFound, "media not found")
			return
		}
		url = media.URL
	case req.URL != nil && *req.URL != "":
		url = *req.URL
	default:
		respond.Error(w, http.StatusBadRequest, "media_id or url required")
		return
	}
	if err := s.db.SetAvatar(r.Context(), id.UserID, url); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to set avatar")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"avatar_url": url})
}

// handleBadges returns the bottom-bar counters.
func (s *Server) handleBadges(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	notifications, messages, err := s.db.Badges(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load badges")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{
		"badges": map[string]int{"notifications": notifications, "messages": messages},
	})
}

// handleListFollowRequests lists pending requests to follow the caller.
func (s *Server) handleListFollowRequests(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	reqs, err := s.db.FollowRequests(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list follow requests")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"follow_requests": reqs})
}

func (s *Server) handleApproveFollowRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveFollowRequest(w, r, true)
}

func (s *Server) handleDenyFollowRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveFollowRequest(w, r, false)
}

func (s *Server) resolveFollowRequest(w http.ResponseWriter, r *http.Request, approve bool) {
	id, _ := auth.FromContext(r.Context())
	reqID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid request id")
		return
	}
	// §8.1: the UPDATE/DELETE is scoped to followee_id = token user.
	followerID, ok, err := s.db.ResolveFollowRequest(r.Context(), reqID, id.UserID, approve)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to resolve follow request")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "follow request not found")
		return
	}
	if approve {
		s.notify(r, followerID, notify.KindFollowAccept, map[string]any{"user_id": id.UserID})
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true, "approved": approve})
}

type pushTokenRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

// handleRegisterPushToken stores a device push token.
func (s *Server) handleRegisterPushToken(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req pushTokenRequest
	if err := respond.Decode(r, &req); err != nil || req.Token == "" {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Platform == "" {
		req.Platform = "expo"
	}
	if err := s.db.RegisterPushToken(r.Context(), id.UserID, req.Token, req.Platform); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to register push token")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRemovePushToken deletes the caller's push token.
func (s *Server) handleRemovePushToken(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req pushTokenRequest
	if err := respond.Decode(r, &req); err != nil || req.Token == "" {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	// §8.1: delete is scoped to the token's owner.
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM push_tokens WHERE token=$1 AND user_id=$2`, req.Token, id.UserID); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to remove push token")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notify persists + fans out via the bus (works across instances) and, when
// configured, delivers the best-effort push leg (spec §7d.4).
func (s *Server) notify(r *http.Request, userID uuid.UUID, kind string, payload map[string]any) {
	n, err := s.db.InsertNotification(r.Context(), userID, kind, payload)
	if err != nil {
		return
	}
	s.fanout.SendToUser(userID, kind, n)
	if s.push != nil {
		s.push.Push(userID, kind, payload)
	}
}

// notifyMany fans a single notification out to several users (deduped, skipping
// the nil id), each getting the persist + WS + push legs.
func (s *Server) notifyMany(r *http.Request, userIDs []uuid.UUID, kind string, payload map[string]any) {
	seen := map[uuid.UUID]bool{}
	for _, u := range userIDs {
		if u == uuid.Nil || seen[u] {
			continue
		}
		seen[u] = true
		s.notify(r, u, kind, payload)
	}
}

// uploadKey builds an unguessable object key: {scope}/{userID}/{unixnano}-{uuid}{ext}.
func uploadKey(scope string, userID uuid.UUID, filename string) string {
	ext := path.Ext(filename)
	if len(ext) > 10 {
		ext = ""
	}
	return fmt.Sprintf("%s/%s/%d-%s%s", scope, userID, time.Now().UnixNano(), uuid.NewString(), ext)
}
