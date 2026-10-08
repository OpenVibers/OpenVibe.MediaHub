-- phase: expand
-- OpenVibe.MediaHub: the private drive (files and folders), the share links people hand out, the reports against
-- those shares and the per-person upload counter. Applied at boot by openvibe-sdk/db (one file per phase,
-- NNNN_name.sql, in order). Nothing written here is ever a credential, a key or a token.
--
-- v1 is deliberately narrow: openvibe.download only, signed in only, private by default. The bytes never live here:
-- every file row names an object in OpenVibe.Media (object_id), and the bytes are served from there.

CREATE TABLE mh_files (
    id           text COLLATE "C" PRIMARY KEY,          -- fil_<ULID>
    owner        text COLLATE "C" NOT NULL,             -- user:usr_… (a file belongs to a person, never to an app)
    object_id    text COLLATE "C" NOT NULL,             -- med_… : the object in OpenVibe.Media holding the bytes
    name         text NOT NULL,                         -- what the person called it (never a path)
    size         bigint NOT NULL,
    content_type text COLLATE "C" NOT NULL,
    sha256       text COLLATE "C",                      -- what Media computed, when it gave one
    folder_id    text COLLATE "C",                      -- fld_<ULID>, or NULL for the drive's root
    created_at   text COLLATE "C" NOT NULL,
    deleted_at   text COLLATE "C"                       -- soft delete: the row stays until the bytes are gone
);

-- The drive is read as "this person's files, newest first"; a folder view narrows it to one folder.
CREATE INDEX mh_files_owner ON mh_files (owner, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX mh_files_folder ON mh_files (folder_id) WHERE deleted_at IS NULL;
CREATE INDEX mh_files_object ON mh_files (object_id);

CREATE TABLE mh_folders (
    id         text COLLATE "C" PRIMARY KEY,            -- fld_<ULID>
    owner      text COLLATE "C" NOT NULL,               -- user:usr_…
    parent_id  text COLLATE "C",                        -- fld_<ULID>, or NULL for the drive's root
    name       text NOT NULL,
    created_at text COLLATE "C" NOT NULL
);

-- One folder per name per parent per person: two folders called "work" in the same place confuse everybody.
CREATE UNIQUE INDEX mh_folders_once ON mh_folders (owner, coalesce(parent_id, ''), lower(name));
CREATE INDEX mh_folders_owner ON mh_folders (owner, id DESC);

CREATE TABLE mh_shares (
    slug             text COLLATE "C" PRIMARY KEY,      -- 24 url-safe random characters (/s/<slug>)
    file_id          text COLLATE "C" REFERENCES mh_files (id) ON DELETE CASCADE,
    folder_id        text COLLATE "C" REFERENCES mh_folders (id) ON DELETE CASCADE,
    owner            text COLLATE "C" NOT NULL,         -- user:usr_…
    owner_username   text,                              -- the owner's OpenVibe username: what a share page shows,
                                                        -- and nothing else about them (no subject, no id)
    expires_at       text COLLATE "C" NOT NULL,         -- 1 hour to 7 days after creation
    allowed_subjects jsonb,                             -- NULL: any signed-in person; else {"subjects":[usr_…],"usernames":[…]}
    downloads        integer NOT NULL DEFAULT 0,
    report_count     integer NOT NULL DEFAULT 0,        -- the most reports this share has ever had: a high-water
                                                        -- mark, so a share staff restored is not suspended again
                                                        -- by the reports that were already there
    revoked_at       text COLLATE "C",
    suspended_at     text COLLATE "C",                  -- set by the report threshold; only staff clear it
    created_at       text COLLATE "C" NOT NULL,
    CHECK ((file_id IS NULL) <> (folder_id IS NULL))
);

CREATE INDEX mh_shares_owner ON mh_shares (owner, created_at DESC);
CREATE INDEX mh_shares_file ON mh_shares (file_id);
CREATE INDEX mh_shares_folder ON mh_shares (folder_id);

CREATE TABLE mh_reports (
    slug       text COLLATE "C" NOT NULL REFERENCES mh_shares (slug) ON DELETE CASCADE,
    reporter   text COLLATE "C" NOT NULL,               -- user:usr_…
    reason     text COLLATE "C" NOT NULL,               -- malware | illegal | copyright | other
    note       text,                                    -- <= 500 characters
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (slug, reporter)
);

CREATE INDEX mh_reports_recent ON mh_reports (created_at DESC);
-- The staff queue reads "the shares somebody reported, newest report first"; this index is the join's own order.
CREATE INDEX mh_reports_by_slug ON mh_reports (slug, created_at DESC);

CREATE TABLE mh_usage (
    owner   text COLLATE "C" NOT NULL,                  -- user:usr_…
    day     text COLLATE "C" NOT NULL,                  -- YYYY-MM-DD, UTC
    uploads integer NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, day)
);

-- An in-flight chunked upload (the browser sends a big file in parts; /api/v1/uploads/*). It is MediaHub's own
-- state because Media issues the multipart session but knows nothing about whose file it is: this row is what
-- makes a resume (and an abort) belong to one person. Deleted when the upload completes or is abandoned.
CREATE TABLE mh_uploads (
    id             text COLLATE "C" PRIMARY KEY,        -- upl_<ULID>
    owner          text COLLATE "C" NOT NULL,
    object_id      text COLLATE "C" NOT NULL,           -- med_… : the object being uploaded in Media
    upload_id      text COLLATE "C" NOT NULL,           -- Media's multipart session id
    name           text NOT NULL,
    size           bigint NOT NULL,
    content_type   text COLLATE "C" NOT NULL,
    folder_id      text COLLATE "C",
    part_size      integer NOT NULL,
    parts_expected integer NOT NULL,
    file_id        text COLLATE "C",                    -- set once the upload completed into a file
    created_at     text COLLATE "C" NOT NULL,
    expires_at     text COLLATE "C" NOT NULL            -- after this the session is abandoned and its parts dropped
);

CREATE INDEX mh_uploads_owner ON mh_uploads (owner, id DESC);

-- openvibe-sdk/account-data (ADR-033): one row per export or deletion event this service has applied, so a
-- redelivered event never erases twice and a confirmation that failed is sent again. ACCOUNT_DATA_SCHEMA,
-- written here rather than at boot so the schema is the migrations' business like every other table.
CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);
