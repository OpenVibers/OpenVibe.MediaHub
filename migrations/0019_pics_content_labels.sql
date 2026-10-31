-- phase: expand
-- Content labels on pictures (L1, labels and choices, 2026-10-31; Contracts 0.257.0 common.content-labels@1).
--
-- A picture's uploader labels it (PATCH /api/v1/images/:slug { labels }); the AI may suggest a label from what it
-- sees, stored in `suggested` and never applied. A label is not a ban: OpenVibe.Pics never hides a picture because
-- of it, and each viewer's Network label prefs decide what they see. The shape is `{ labels, suggested }`.
--
-- Expand only: an older release never reads the column, and the default keeps every existing picture label-free.
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
CREATE INDEX IF NOT EXISTS pics_images_content_labels ON pics_images USING gin (content_labels);
