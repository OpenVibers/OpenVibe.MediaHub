-- phase: expand
-- MediaHub publishes its own events (contracts 0.196.0: mediahub.video.published, mediahub.picture.uploaded; Events#91
-- gives the hyphenated service the namespace mediahub.*). server/events-outbox.js writes them here in the change's own
-- transaction and the SDK relay sends them to OpenVibe.Events.
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;

-- When an upload was first public and ready (mediahub.video.published is written once, then).
ALTER TABLE video_uploads ADD COLUMN IF NOT EXISTS published_at text COLLATE "C";
