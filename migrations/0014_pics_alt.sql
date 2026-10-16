-- phase: expand
-- OpenVibe.Pics alt text (server/pics/describe.js): what a screen reader says for a picture, in the page, the
-- thumbnails and every embed snippet. The uploader writes it, or asks OpenVibe.AI for a draft (pics.describe_image,
-- only when they press the button) and keeps or edits it; the caption and tags come with that draft.
ALTER TABLE pics_images ADD COLUMN alt text NOT NULL DEFAULT '';             -- <= 160 characters (enforced in code)
ALTER TABLE pics_images ADD COLUMN alt_source text COLLATE "C";              -- 'person' | 'ai' (the draft as AI wrote it) | NULL none
ALTER TABLE pics_images ADD COLUMN ai_caption text;                          -- <= 400 characters, labelled as written by AI
ALTER TABLE pics_images ADD COLUMN ai_tags text;                             -- JSON array of up to six lowercase words
ALTER TABLE pics_images ADD COLUMN ai_described_at text COLLATE "C";         -- the last draft (the daily cap counts these)
CREATE INDEX pics_images_ai_described ON pics_images (ai_described_at) WHERE ai_described_at IS NOT NULL;
ALTER TABLE pics_images ADD CONSTRAINT pics_images_alt_source CHECK (alt_source IS NULL OR alt_source IN ('person', 'ai'));
