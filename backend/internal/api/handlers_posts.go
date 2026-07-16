package api

import (
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/respond"
)

type createPostRequest struct {
	Caption  *string  `json:"caption"`
	Kind     string   `json:"kind"` // photo | video | reel
	MediaIDs []string `json:"media_ids"`
	MarketID *string  `json:"market_id"` // optional attach-market
}

// handleCreatePost publishes a post from previously-uploaded media, optionally
// attaching a market. §8.1: the author is always the token user; media
// attachment verifies owner_id in the UPDATE.
func (s *Server) handleCreatePost(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req createPostRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Kind == "" {
		req.Kind = "photo"
	}
	if req.Kind != "photo" && req.Kind != "video" && req.Kind != "reel" {
		respond.Error(w, http.StatusBadRequest, "invalid post kind")
		return
	}
	if len(req.MediaIDs) == 0 || len(req.MediaIDs) > 10 {
		respond.Error(w, http.StatusBadRequest, "posts need 1-10 media items")
		return
	}
	if req.Caption != nil && len(*req.Caption) > 2200 {
		respond.Error(w, http.StatusBadRequest, "caption too long")
		return
	}
	mediaIDs := make([]uuid.UUID, 0, len(req.MediaIDs))
	for _, m := range req.MediaIDs {
		mid, err := uuid.Parse(m)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid media id")
			return
		}
		mediaIDs = append(mediaIDs, mid)
	}
	var marketID *uuid.UUID
	if req.MarketID != nil && *req.MarketID != "" {
		mid, err := uuid.Parse(*req.MarketID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid market id")
			return
		}
		if summary, err := s.db.MarketSummaryByID(r.Context(), mid); err != nil || summary == nil {
			respond.Error(w, http.StatusNotFound, "market not found")
			return
		}
		marketID = &mid
	}

	postID, _, err := s.db.CreatePost(r.Context(), id.UserID, req.Caption, req.Kind, marketID, mediaIDs)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to create post")
		return
	}
	post, err := s.db.GetPost(r.Context(), id.UserID, postID)
	if err != nil || post == nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load post")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"post": post})
}

// handleFeed is the home feed: followed users + recency-ranked fill.
func (s *Server) handleFeed(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	opts, ok := feedOpts(w, r, 20)
	if !ok {
		return
	}
	posts, next, err := s.db.Feed(r.Context(), id.UserID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load feed")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"posts": posts, "next_cursor": next})
}

// handleReels is the vertical short-form feed.
func (s *Server) handleReels(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	opts, ok := feedOpts(w, r, 10)
	if !ok {
		return
	}
	posts, next, err := s.db.Reels(r.Context(), id.UserID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load reels")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"posts": posts, "next_cursor": next})
}

// handleExplorePosts is the discovery grid (public accounts only).
func (s *Server) handleExplorePosts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	opts, ok := feedOpts(w, r, 24)
	if !ok {
		return
	}
	posts, next, err := s.db.ExplorePosts(r.Context(), id.UserID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load explore")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"posts": posts, "next_cursor": next})
}

// handleGetPost returns one post (visibility enforced in the query).
func (s *Server) handleGetPost(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	postID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid post id")
		return
	}
	post, err := s.db.GetPost(r.Context(), id.UserID, postID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load post")
		return
	}
	if post == nil {
		respond.Error(w, http.StatusNotFound, "post not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"post": post})
}

// handleDeletePost soft-deletes the caller's own post (§8.1: author_id from
// the token inside the UPDATE, 404 otherwise).
func (s *Server) handleDeletePost(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	postID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid post id")
		return
	}
	ok, err := s.db.DeletePost(r.Context(), id.UserID, postID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to delete post")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "post not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- likes & reactions -------------------------------------------------------

type likeRequest struct {
	SubjectType string `json:"subject_type"` // post | comment | market
	SubjectID   string `json:"subject_id"`
}

func (s *Server) handleLike(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req likeRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	subjectID, err := uuid.Parse(req.SubjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid subject id")
		return
	}
	owner, count, err := s.db.Like(r.Context(), id.UserID, req.SubjectType, subjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to like")
		return
	}
	if owner != uuid.Nil && owner != id.UserID && req.SubjectType == "post" {
		s.notify(r, owner, notify.KindPostLiked, map[string]any{
			"post_id": subjectID, "user_id": id.UserID,
		})
	}
	respond.JSON(w, http.StatusOK, map[string]any{"liked": true, "like_count": count})
}

func (s *Server) handleUnlike(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req likeRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	subjectID, err := uuid.Parse(req.SubjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid subject id")
		return
	}
	count, err := s.db.Unlike(r.Context(), id.UserID, req.SubjectType, subjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to unlike")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"liked": false, "like_count": count})
}

type reactRequest struct {
	SubjectType string `json:"subject_type"` // post | comment | market | message
	SubjectID   string `json:"subject_id"`
	Emoji       string `json:"emoji"`
}

func (s *Server) handleReact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req reactRequest
	if err := respond.Decode(r, &req); err != nil || req.Emoji == "" || len(req.Emoji) > 16 {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	subjectID, err := uuid.Parse(req.SubjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid subject id")
		return
	}
	breakdown, mine, err := s.db.React(r.Context(), id.UserID, req.SubjectType, subjectID, req.Emoji)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to react")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"reactions": breakdown, "my_reaction": mine})
}

func (s *Server) handleUnreact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req reactRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	subjectID, err := uuid.Parse(req.SubjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid subject id")
		return
	}
	breakdown, err := s.db.Unreact(r.Context(), id.UserID, req.SubjectType, subjectID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to remove reaction")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"reactions": breakdown, "my_reaction": ""})
}

// --- comments ---------------------------------------------------------------

type createCommentRequest struct {
	Body     string  `json:"body"`
	ParentID *string `json:"parent_id"`
}

// handlePostComments lists a post's comments (post must be visible).
func (s *Server) handlePostComments(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	postID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid post id")
		return
	}
	if post, err := s.db.GetPost(r.Context(), id.UserID, postID); err != nil || post == nil {
		respond.Error(w, http.StatusNotFound, "post not found")
		return
	}
	opts, ok := feedOpts(w, r, 50)
	if !ok {
		return
	}
	comments, next, err := s.db.PostComments(r.Context(), id.UserID, postID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load comments")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"comments": comments, "next_cursor": next})
}

func (s *Server) handleCreatePostComment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	postID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid post id")
		return
	}
	post, err := s.db.GetPost(r.Context(), id.UserID, postID)
	if err != nil || post == nil {
		respond.Error(w, http.StatusNotFound, "post not found")
		return
	}
	comment, ok := s.createComment(w, r, id.UserID, &postID, nil)
	if !ok {
		return
	}
	if post.Author.ID != id.UserID {
		s.notify(r, post.Author.ID, "post.commented", map[string]any{
			"post_id": postID, "comment_id": comment, "user_id": id.UserID,
		})
	}
}

// createComment is shared between post + market comment endpoints.
func (s *Server) createComment(w http.ResponseWriter, r *http.Request, userID uuid.UUID, postID, marketID *uuid.UUID) (uuid.UUID, bool) {
	var req createCommentRequest
	if err := respond.Decode(r, &req); err != nil || req.Body == "" || len(req.Body) > 2200 {
		respond.Error(w, http.StatusBadRequest, "invalid comment body")
		return uuid.Nil, false
	}
	var parentID *uuid.UUID
	if req.ParentID != nil && *req.ParentID != "" {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid parent id")
			return uuid.Nil, false
		}
		parentID = &pid
	}
	comment, err := s.db.CreateComment(r.Context(), userID, postID, marketID, parentID, req.Body)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create comment")
		return uuid.Nil, false
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"comment": comment})
	return comment.ID, true
}

// handleDeleteComment removes the caller's own comment.
func (s *Server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	commentID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid comment id")
		return
	}
	ok, err := s.db.DeleteComment(r.Context(), id.UserID, commentID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to delete comment")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "comment not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- stories ------------------------------------------------------------------

type createStoryRequest struct {
	MediaID string `json:"media_id"`
}

func (s *Server) handleCreateStory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req createStoryRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	mediaID, err := uuid.Parse(req.MediaID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid media id")
		return
	}
	storyID, err := s.db.CreateStoryFromMedia(r.Context(), id.UserID, mediaID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to create story")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"id": storyID})
}

// handleListStories returns active stories from followed users + self.
func (s *Server) handleListStories(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	stories, err := s.db.ActiveStories(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load stories")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"stories": stories})
}

// handleViewStory records a view (idempotent, visibility-gated in the query).
func (s *Server) handleViewStory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	storyID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid story id")
		return
	}
	if err := s.db.ViewStory(r.Context(), id.UserID, storyID); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to record view")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleExploreMarkets is the markets tab of explore (volume + recency rank,
// offset pagination — the ranking is not keyset-stable).
func (s *Server) handleExploreMarkets(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 20)
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 10000 {
			offset = n
		}
	}
	markets, err := s.db.ExploreMarkets(r.Context(), limit, offset)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load markets")
		return
	}
	var next *string
	if len(markets) >= limit {
		n := strconv.Itoa(offset + limit)
		next = &n
	}
	respond.JSON(w, http.StatusOK, map[string]any{"markets": markets, "next_cursor": next})
}
