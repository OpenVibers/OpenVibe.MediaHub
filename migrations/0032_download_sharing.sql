-- phase: expand
-- Existing drive files stay private. New uploads choose an audience when the upload starts.
-- Old expiring links keep working until their owner changes the file's sharing. New files and changed files
-- use the share row on every legacy link path as well.
ALTER TABLE mh_files ADD COLUMN IF NOT EXISTS share_v1 boolean NOT NULL DEFAULT false;
ALTER TABLE mh_files ALTER COLUMN share_v1 SET DEFAULT true;
ALTER TABLE mh_uploads ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'private';
DO $$ BEGIN
    ALTER TABLE mh_uploads ADD CONSTRAINT mh_uploads_audience_allowed
        CHECK (audience IN ('public', 'link', 'people', 'private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS mh_share_defaults (
    owner text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    audience text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, kind),
    CHECK (kind = 'download'),
    CHECK (audience IN ('public', 'link', 'people', 'private'))
);

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'mediahub', 'download', f.id,
    CASE WHEN f.owner LIKE 'user:usr\_%' THEN jsonb_build_object('type', 'user', 'id', substr(f.owner, 6))
         ELSE jsonb_build_object('type', 'service', 'id', 'mediahub') END,
    'private'
FROM mh_files f WHERE f.deleted_at IS NULL
ON CONFLICT (service, kind, resource_id) DO NOTHING;
