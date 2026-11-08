-- phase: expand
-- OpenVibe Radio: published audio is an owned MediaHub file with an explicit reuse grant.
CREATE TABLE IF NOT EXISTS mh_radio_tracks (
    id text COLLATE "C" PRIMARY KEY,
    file_id text COLLATE "C" NOT NULL UNIQUE REFERENCES mh_files(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    title text NOT NULL,
    artist text NOT NULL,
    source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('creator', 'creative_commons', 'public_domain', 'ai')),
    source_url text,
    licence text COLLATE "C" NOT NULL CHECK (licence IN ('creator_grant', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'public_domain')),
    licence_url text NOT NULL,
    changes_note text,
    ai_made boolean NOT NULL DEFAULT false,
    published_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS mh_radio_tracks_public ON mh_radio_tracks (published_at DESC) WHERE revoked_at IS NULL;
