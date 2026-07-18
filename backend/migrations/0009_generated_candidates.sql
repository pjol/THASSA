-- Generated-but-not-yet-created market candidates, saved from EVERY user's
-- generation queries so later attach-market searches surface them ("Start
-- market") before anyone has to re-generate. market_id is stamped once
-- someone actually starts the market, which drops the row out of search.
CREATE TABLE generated_market_candidates (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    title            TEXT NOT NULL,
    question         TEXT NOT NULL,
    settlement_query TEXT NOT NULL,
    category         TEXT,
    rule             TEXT,
    sources          JSONB NOT NULL DEFAULT '[]',
    market_id        UUID REFERENCES markets(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One row per distinct question: repeated generations reuse the stored row.
CREATE UNIQUE INDEX ux_generated_candidates_question
    ON generated_market_candidates (lower(question));
CREATE INDEX idx_generated_candidates_trgm
    ON generated_market_candidates USING gin (question gin_trgm_ops);
