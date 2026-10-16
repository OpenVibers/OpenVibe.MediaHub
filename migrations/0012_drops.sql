-- phase: expand
-- Drops (OpenVibe.Download, the owner's Q10, MediaFire-style): a file uploaded without an account, up to 2 GB, with a
-- public page /d/<slug> and a delete key shown once (kept as its sha256). A drop is kept 30 days after its last
-- download, then the sweep deletes it. Reports suspend it (any report of illegal content, or three distinct ones);
-- staff restore it or remove it, and a removed drop's sha256 goes on mh_drop_blocklist so the same file cannot come
-- back. Off until the owner registers the DMCA agent and the CSAM hash-matching account (plan T10, with Pics):
-- MEDIAHUB_DOWNLOAD_ANONYMOUS=1.
CREATE TABLE mh_drops (
    id               text COLLATE "C" PRIMARY KEY,          -- drp_<ULID>
    slug             text COLLATE "C" NOT NULL UNIQUE,      -- 24 random url-safe characters: the /d/<slug> address
    object_id        text COLLATE "C" NOT NULL,             -- med_… : an ownerless object in OpenVibe.Media
    name             text NOT NULL,
    size             bigint NOT NULL,
    content_type     text COLLATE "C" NOT NULL,
    sha256           text COLLATE "C",
    uploader         text COLLATE "C" NOT NULL,             -- ip:<keyed hash of the address>, for the per-address limits
    delete_key_hash  text COLLATE "C" NOT NULL,
    state            text COLLATE "C" NOT NULL DEFAULT 'active',
    report_count     integer NOT NULL DEFAULT 0,
    downloads        integer NOT NULL DEFAULT 0,
    created_at       text COLLATE "C" NOT NULL,
    last_download_at text COLLATE "C",
    removed_at       text COLLATE "C",
    CHECK (state IN ('active', 'suspended', 'removed'))
);
CREATE INDEX mh_drops_uploader ON mh_drops (uploader, created_at);
CREATE INDEX mh_drops_live ON mh_drops (state, created_at) WHERE state <> 'removed';

CREATE TABLE mh_drop_reports (
    drop_id    text COLLATE "C" NOT NULL REFERENCES mh_drops (id) ON DELETE CASCADE,
    reporter   text COLLATE "C" NOT NULL,                  -- user:usr_…, or ip:<keyed hash> signed out
    reason     text COLLATE "C" NOT NULL,
    note       text NOT NULL DEFAULT '',
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (drop_id, reporter)
);

-- A drop's upload session is an ordinary mh_uploads row whose owner is drop:<sha256 of its token>; the address it
-- came from rides along for the per-address limits.
ALTER TABLE mh_uploads ADD COLUMN drop_uploader text COLLATE "C";

CREATE TABLE mh_drop_blocklist (
    sha256     text COLLATE "C" PRIMARY KEY,
    drop_id    text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
