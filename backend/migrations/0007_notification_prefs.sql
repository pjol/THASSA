-- Per-category notification preferences (Settings → Notifications toggles).
-- Keys are category slugs (likes, comments, mentions, follows, messages,
-- markets, trading) mapping to booleans; a missing key means enabled.
ALTER TABLE users ADD COLUMN notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
