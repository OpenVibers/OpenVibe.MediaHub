-- phase: migrate
-- Uploads already public and ready before MediaHub published events count as published then: their
-- mediahub.video.published is never written late (server/video/uploads.js maybePublished).
UPDATE video_uploads SET published_at = COALESCE(ready_at, created_at)
 WHERE published_at IS NULL AND status = 'ready' AND state = 'active' AND visibility = 'public';
