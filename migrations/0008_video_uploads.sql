-- phase: expand
-- OpenVibe.Video uploads (server/video/uploads.js): videos people upload to openvibe.video. The bytes are an
-- OpenVibe.Media VOD in MediaHub's tenant (media-hub): Media stores them, probes them, makes the thumbnail and the HLS
-- timeline. MediaHub keeps who uploaded what, its title and visibility, how far the upload got, and the reports.
CREATE TABLE video_uploads (
    id              text COLLATE "C" PRIMARY KEY,          -- vup_<ULID>, the /u/<id> address
    owner           text COLLATE "C" NOT NULL,             -- user:usr_…
    owner_username  text COLLATE "C",                      -- the channel name at upload (/@<username> lists it)
    title           text NOT NULL,                         -- <= 120 characters (enforced in code)
    description     text NOT NULL DEFAULT '',              -- <= 5,000 characters (enforced in code)
    visibility      text COLLATE "C" NOT NULL DEFAULT 'public',
    media_vod_id    bigint,                                -- Media's VOD id in the media-hub tenant
    content_type    text COLLATE "C" NOT NULL,             -- what the parts are sent to Media as (video/mp4, video/webm, video/x-matroska)
    size_bytes      bigint NOT NULL,
    part_size       integer NOT NULL,
    parts_expected  integer NOT NULL,
    parts_received  integer NOT NULL DEFAULT 0,
    status          text COLLATE "C" NOT NULL DEFAULT 'uploading',
    error           text,
    duration_seconds double precision,
    thumbnail_url   text,
    state           text COLLATE "C" NOT NULL DEFAULT 'active',
    report_count    integer NOT NULL DEFAULT 0,
    views           bigint NOT NULL DEFAULT 0,
    created_at      text COLLATE "C" NOT NULL,
    updated_at      text COLLATE "C" NOT NULL,
    ready_at        text COLLATE "C",
    CHECK (visibility IN ('public', 'unlisted', 'private')),
    CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
    CHECK (state IN ('active', 'hidden', 'removed'))
);
CREATE INDEX video_uploads_owner ON video_uploads (owner, id DESC);
CREATE INDEX video_uploads_public ON video_uploads (id DESC) WHERE visibility = 'public' AND status = 'ready' AND state = 'active';
CREATE INDEX video_uploads_channel ON video_uploads (lower(owner_username), id DESC);

CREATE TABLE video_upload_reports (
    upload_id   text COLLATE "C" NOT NULL REFERENCES video_uploads(id) ON DELETE CASCADE,
    reporter    text COLLATE "C" NOT NULL,                 -- user:usr_… or ip:<keyed hash> (one report each)
    reason      text COLLATE "C" NOT NULL,
    note        text NOT NULL DEFAULT '',
    created_at  text COLLATE "C" NOT NULL,
    PRIMARY KEY (upload_id, reporter)
);
