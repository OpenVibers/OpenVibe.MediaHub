-- phase: expand
-- Discovery is separate from access: no existing picture is opted in by this migration.
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false;
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS tags text NOT NULL DEFAULT '[]';
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT '';
ALTER TABLE pics_images ADD COLUMN IF NOT EXISTS published_at timestamptz;
CREATE INDEX IF NOT EXISTS pics_gallery_new ON pics_images (published_at DESC, id DESC) WHERE listed = true AND state = 'active' AND audience = 'public';
CREATE TABLE IF NOT EXISTS pics_likes (
    image_id text NOT NULL REFERENCES pics_images(id) ON DELETE CASCADE,
    actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (image_id, actor)
);
CREATE TABLE IF NOT EXISTS pics_views (
    image_id text NOT NULL REFERENCES pics_images(id) ON DELETE CASCADE,
    visitor text NOT NULL, day text NOT NULL, PRIMARY KEY (image_id, visitor, day)
);
CREATE TABLE IF NOT EXISTS pics_uploads (
    id text PRIMARY KEY, owner text NOT NULL, size integer NOT NULL CHECK (size > 0),
    content_type text NOT NULL, name text NOT NULL, title text NOT NULL,
    offset_bytes integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL,
    image_id text REFERENCES pics_images(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS pics_upload_chunks (
    upload_id text NOT NULL REFERENCES pics_uploads(id) ON DELETE CASCADE,
    offset_bytes integer NOT NULL, bytes bytea NOT NULL,
    PRIMARY KEY (upload_id, offset_bytes)
);
