-- phase: expand
-- The AI edit of an OpenVibe.Video upload (server/video/ai-edit.js): OpenVibe.AI's media.analyze (local speech-to-text,
-- highlights and an overview) on the finished video. The transcript becomes captions, the highlights chapters, and the
-- overview a suggested description the owner may use. One row per upload, kept while the upload exists.
CREATE TABLE video_upload_ai (
    upload_id   text COLLATE "C" PRIMARY KEY REFERENCES video_uploads(id) ON DELETE CASCADE,
    status      text COLLATE "C" NOT NULL DEFAULT 'queued',
    attempts    integer NOT NULL DEFAULT 0,
    run_id      text COLLATE "C",
    overview    text,
    chapters    jsonb NOT NULL DEFAULT '[]',     -- [{ start, title }] from the highlights, in time order
    segments    jsonb NOT NULL DEFAULT '[]',     -- [{ start, end, text }] the transcript
    language    text COLLATE "C",
    error       text,
    next_at     text COLLATE "C",                -- when to ask OpenVibe.AI again (a run still going, or a failure)
    updated_at  text COLLATE "C" NOT NULL,
    CHECK (status IN ('queued', 'running', 'done', 'failed'))
);
CREATE INDEX video_upload_ai_due ON video_upload_ai (status, next_at);
