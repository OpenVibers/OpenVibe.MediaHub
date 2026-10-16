-- phase: expand
-- The AI cut of an OpenVibe.Video upload (server/video/cut.js): an edited copy with the pauses taken out, or a reel of
-- the highlights the AI edit found. The copy is a new private upload of the same person (video_uploads.edited_from);
-- the original is never changed.
CREATE TABLE video_cuts (
    id               text COLLATE "C" PRIMARY KEY,                -- vcut_<ULID>
    upload_id        text COLLATE "C" NOT NULL REFERENCES video_uploads(id) ON DELETE CASCADE,   -- the original
    owner            text COLLATE "C" NOT NULL,                   -- user:usr_… (the original's owner)
    mode             text COLLATE "C" NOT NULL,                   -- pauses | tight | highlights
    status           text COLLATE "C" NOT NULL DEFAULT 'queued',
    ranges           jsonb,                                       -- [[start, end], …] kept, in seconds, once planned
    source_seconds   double precision,
    kept_seconds     double precision,
    removed_count    integer,                                     -- pauses taken out (pauses, tight)
    progress         real NOT NULL DEFAULT 0,                     -- 0..1 while rendering
    result_upload_id text COLLATE "C",                            -- the edited copy (vup_…), made when rendering starts
    attempts         integer NOT NULL DEFAULT 0,
    error            text,
    created_at       text COLLATE "C" NOT NULL,
    updated_at       text COLLATE "C" NOT NULL,
    started_at       text COLLATE "C",
    finished_at      text COLLATE "C",
    CHECK (mode IN ('pauses', 'tight', 'highlights')),
    CHECK (status IN ('queued', 'measuring', 'rendering', 'done', 'failed'))
);
CREATE INDEX video_cuts_upload ON video_cuts (upload_id, created_at DESC);
CREATE INDEX video_cuts_owner ON video_cuts (owner, created_at DESC);
CREATE INDEX video_cuts_due ON video_cuts (status, created_at);

-- The edited copy points at its original (shown to its owner); the highlights the AI edit found, with their ends
-- (chapters keep only the starts), for the highlights reel.
ALTER TABLE video_uploads ADD COLUMN edited_from text COLLATE "C";
ALTER TABLE video_upload_ai ADD COLUMN highlights jsonb;
