-- phase: expand
-- Playlists hold uploads too (kind 'upload'). A playlist item is a kind and a number; an upload's address is its
-- vup_ id, so each upload gets a stable number of its own (seq, filled for the uploads that exist) and a playlist
-- item of kind 'upload' carries it.
ALTER TABLE video_uploads ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX video_uploads_seq ON video_uploads (seq);
ALTER TABLE video_playlist_items DROP CONSTRAINT video_playlist_items_kind_check;
ALTER TABLE video_playlist_items ADD CONSTRAINT video_playlist_items_kind_check CHECK (kind IN ('vod', 'clip', 'upload'));
