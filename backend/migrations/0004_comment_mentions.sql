-- Comment @-mentions (spec §7d.2, mirroring posts). Stored by user id so a
-- rendered mention always shows the mentioned user's CURRENT username, even
-- after a rename. comments.mentions is the verbatim [{user_id,start,len}] wire
-- payload (UTF-16 character offsets into the comment body); comment_mentions is
-- the normalized join used for notification / "tagged" lookups, indexed on
-- user_id.
--
-- SHARD KEY: post author for post comments, market_id for market comments —
-- same as the comments table they extend (spec §6.7).

ALTER TABLE comments ADD COLUMN mentions JSONB NOT NULL DEFAULT '[]';

CREATE TABLE comment_mentions (
    comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id);
