-- phase: expand
-- Likes on uploads too (the owner, 11-18: the upload's watch page is the recording's). An upload is liked by its number
-- (video_uploads.seq). Widening the check only lets more in: code that knows only 'vod' and 'clip' runs unchanged.
ALTER TABLE video_likes DROP CONSTRAINT IF EXISTS video_likes_kind_check;
ALTER TABLE video_likes ADD CONSTRAINT video_likes_kind_check CHECK (kind IN ('vod', 'clip', 'upload'));
