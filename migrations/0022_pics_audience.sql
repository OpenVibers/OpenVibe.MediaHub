-- phase: expand
-- Sharing step 4 (design 2026-11-06): the share row is the authority; this column keeps the gathered
-- pages and the album in step with it, the 1:1 mapping the other repos use. Expand only.
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'public';
ALTER TABLE pics_albums ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'public';
