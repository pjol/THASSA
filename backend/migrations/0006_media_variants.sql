-- Responsive media ladder (spec §6.8). The ffmpeg worker now transcodes each
-- upload into low-file-size renditions and drops the original once they are
-- stored: images become a width-ladder of WebP/JPEG variants; videos gain a
-- poster still (the HLS master playlist already carries the bitrate ladder).
--
-- variants is a JSONB array of {"w":int,"h":int,"key":str,"fmt":str} (stored
-- KEYS, resolved to public URLs on read, same as s3_key/variant_key/hls_key).
-- poster_key is the video thumbnail. original_dropped records that the raw
-- upload (s3_key) has been deleted and the row now serves only transcoded
-- renditions — the drop-original idempotency guard reads it to skip re-work.

ALTER TABLE post_media
    ADD COLUMN variants         JSONB   NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN poster_key       TEXT,
    ADD COLUMN original_dropped BOOLEAN NOT NULL DEFAULT false;

-- Stories copy media fields inline from post_media at publish time; carry the
-- ladder + poster so story playback matches feed playback.
ALTER TABLE stories
    ADD COLUMN variants   JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN poster_key TEXT;

-- Messages copy media fields inline from post_media at send time.
ALTER TABLE messages
    ADD COLUMN variants   JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN poster_key TEXT;
