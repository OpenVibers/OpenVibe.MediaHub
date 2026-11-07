-- phase: expand
-- A watch id for every video on openvibe.video (plan track U, 2026-11-07): 11 characters of URL-safe base64 from 8
-- random bytes, YouTube's shape, so a watch page is openvibe.video/watch?v=<watch id> instead of /u/<vup_…>, which
-- anyone could walk. Media mints the id for every VOD and clip; an upload is a Media VOD in this tenant, so its watch
-- id is the VOD's, copied here once so a page, a card and the sitemap can name it without asking Media for every row.
--
-- Nullable on purpose: rows written before this release have none, and they are filled in batches afterwards
-- (uploads.backfillWatchIds, at boot, only where watch_id IS NULL) so the migration itself takes no table rewrite and
-- holds no lock over the whole table. A row with no id yet still answers at /u/<id>, which Media fills on the way.
-- Additive only: an older release never reads or writes the column.
ALTER TABLE video_uploads ADD COLUMN IF NOT EXISTS watch_id text COLLATE "C";

-- The lookup is by id alone and must be one index probe. Partial, so the backfill's many NULLs index nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_uploads_watch_id ON video_uploads (watch_id) WHERE watch_id IS NOT NULL;
