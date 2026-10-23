-- phase: expand
-- One upload per Media VOD. Recordings OpenRestream makes for a record-only stream (plan 2026-10-22 §3 D1) are filed here
-- when Media says they are ready, and that delivery can come twice; the index makes the second one change nothing.
-- Production had 8 uploads and 8 distinct VODs when this was added (2026-10-23).
CREATE UNIQUE INDEX IF NOT EXISTS video_uploads_vod ON video_uploads (media_vod_id) WHERE media_vod_id IS NOT NULL;
