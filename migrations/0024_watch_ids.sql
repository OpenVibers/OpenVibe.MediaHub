-- phase: expand
-- A watch id for every upload and recording on openvibe.video (plan track U, 2026-11-07): 11 characters of URL-safe
-- base64 from 8 random bytes, YouTube's shape, so a watch page is /watch?v=<watch id> instead of /u/<vup_…>, an
-- address anyone could walk. Stream recordings and clips get theirs from OpenVibe.Media, which owns them; this column
-- is for the videos MediaHub owns.
--
-- Nullable on purpose: rows written before this release have none, and they are filled in batches afterwards
-- (server/video/watch-ids.js backfill, at boot, only where watch_id IS NULL) so this migration takes no table rewrite
-- and holds no lock over the whole table. Additive only: an older release never reads or writes the column.
ALTER TABLE video_uploads ADD COLUMN IF NOT EXISTS watch_id text COLLATE "C";

-- The lookup is by id alone and must be one index probe. Partial, so the backfill's many NULLs index nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_uploads_watch_id ON video_uploads (watch_id) WHERE watch_id IS NOT NULL;
