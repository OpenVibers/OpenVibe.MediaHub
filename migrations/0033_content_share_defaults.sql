-- phase: expand
-- Per-person choices for new pictures, albums and videos. Download's table remains as published.
CREATE TABLE IF NOT EXISTS mh_content_share_defaults (
    owner text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('picture', 'album', 'video')),
    audience text NOT NULL CHECK (audience IN ('public', 'link', 'people', 'private')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, kind)
);
ALTER TABLE pics_uploads ADD COLUMN IF NOT EXISTS audience text;
DO $$ BEGIN
    ALTER TABLE pics_uploads ADD CONSTRAINT pics_uploads_audience_allowed
        CHECK (audience IS NULL OR audience IN ('public', 'link', 'people', 'private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
