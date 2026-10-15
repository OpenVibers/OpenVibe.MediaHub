-- phase: expand
-- OpenVibe.Pics (server/pics): pictures on openvibe.pics, their albums, the reports people file and the hashes staff
-- took down. The bytes are OpenVibe.Media objects (unlisted: anyone with the link); MediaHub keeps what they are,
-- who uploaded them and whether they may be shown. Nothing here is a credential, except that a signed-out upload's
-- delete key is kept only as its sha256.

CREATE TABLE pics_images (
    id              text COLLATE "C" PRIMARY KEY,          -- pic_<ULID>
    slug            text COLLATE "C" NOT NULL UNIQUE,      -- the 8-character name in /i/<slug>
    owner           text COLLATE "C",                      -- user:usr_…, or NULL for a signed-out upload
    delete_key_hash text COLLATE "C",                      -- sha256 of a signed-out upload's delete key
    title           text NOT NULL DEFAULT '',              -- <= 120 characters (enforced in code)
    description     text NOT NULL DEFAULT '',              -- <= 2,000 characters (enforced in code)
    object_id       text COLLATE "C" NOT NULL,             -- med_… the picture, re-encoded without its metadata
    thumb_object_id text COLLATE "C",                      -- med_… a 640-pixel WebP of it (the first frame if animated)
    mime_type       text COLLATE "C" NOT NULL,
    ext             text COLLATE "C" NOT NULL,             -- jpg | png | gif | webp | avif
    width           integer NOT NULL,
    height          integer NOT NULL,
    bytes           bigint NOT NULL,
    animated        boolean NOT NULL DEFAULT false,
    sha256          text COLLATE "C" NOT NULL,             -- of the bytes served
    source_sha256   text COLLATE "C" NOT NULL,             -- of the bytes uploaded
    dhash           text COLLATE "C" NOT NULL,             -- 64-bit difference hash, 16 hex digits (near-duplicates)
    state           text COLLATE "C" NOT NULL DEFAULT 'active',
    report_count    integer NOT NULL DEFAULT 0,
    created_at      text COLLATE "C" NOT NULL,
    updated_at      text COLLATE "C" NOT NULL,
    last_viewed_at  text COLLATE "C",
    CHECK (state IN ('active', 'hidden', 'removed'))
);
CREATE INDEX pics_images_owner ON pics_images (owner, id DESC);
CREATE INDEX pics_images_state ON pics_images (state, id DESC);
CREATE INDEX pics_images_anonymous_idle ON pics_images (last_viewed_at) WHERE owner IS NULL;

CREATE TABLE pics_albums (
    id          text COLLATE "C" PRIMARY KEY,              -- alb_<ULID>
    slug        text COLLATE "C" NOT NULL UNIQUE,          -- /a/<slug>
    owner       text COLLATE "C" NOT NULL,                 -- user:usr_… (albums are account-only)
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at  text COLLATE "C" NOT NULL,
    updated_at  text COLLATE "C" NOT NULL
);
CREATE INDEX pics_albums_owner ON pics_albums (owner, id DESC);

CREATE TABLE pics_album_images (
    album_id  text COLLATE "C" NOT NULL REFERENCES pics_albums (id) ON DELETE CASCADE,
    image_id  text COLLATE "C" NOT NULL REFERENCES pics_images (id) ON DELETE CASCADE,
    position  integer NOT NULL,
    added_at  text COLLATE "C" NOT NULL,
    PRIMARY KEY (album_id, image_id)
);
CREATE INDEX pics_album_images_order ON pics_album_images (album_id, position);

-- One report per reporter per picture. A signed-out reporter is a keyed hash of their address, never the address.
CREATE TABLE pics_reports (
    id          text COLLATE "C" PRIMARY KEY,              -- prp_<ULID>
    image_id    text COLLATE "C" NOT NULL REFERENCES pics_images (id) ON DELETE CASCADE,
    reporter    text COLLATE "C" NOT NULL,
    reason      text COLLATE "C" NOT NULL,
    note        text NOT NULL DEFAULT '',
    created_at  text COLLATE "C" NOT NULL,
    UNIQUE (image_id, reporter)
);

-- What staff took down stays down: an upload whose bytes (sha256) or near-duplicate (dhash) match is refused.
CREATE TABLE pics_blocklist (
    kind        text COLLATE "C" NOT NULL,                 -- sha256 | dhash
    value       text COLLATE "C" NOT NULL,
    reason      text COLLATE "C" NOT NULL,
    image_id    text COLLATE "C",                          -- the picture it came from (kept after it is gone)
    created_by  text COLLATE "C" NOT NULL,
    created_at  text COLLATE "C" NOT NULL,
    PRIMARY KEY (kind, value),
    CHECK (kind IN ('sha256', 'dhash'))
);

-- Uploads per uploader per UTC day: a person, or a keyed hash of a signed-out address.
CREATE TABLE pics_usage (
    uploader text COLLATE "C" NOT NULL,
    day      text COLLATE "C" NOT NULL,
    uploads  integer NOT NULL DEFAULT 0,
    PRIMARY KEY (uploader, day)
);
