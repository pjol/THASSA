package api

import (
	"net/http"
	"strconv"

	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
)

// parseLimit reads ?limit= (bounded 1..100).
func parseLimit(r *http.Request, def int) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			return n
		}
	}
	return def
}

// feedOpts builds cursor-paginated query options from ?cursor=&limit=.
// Returns false (after writing a 400) when the cursor is malformed.
func feedOpts(w http.ResponseWriter, r *http.Request, defLimit int) (store.FeedOpts, bool) {
	cursor, err := store.DecodeCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid cursor")
		return store.FeedOpts{}, false
	}
	return store.FeedOpts{Cursor: cursor, Limit: parseLimit(r, defLimit)}, true
}
