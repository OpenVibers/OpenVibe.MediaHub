-- phase: expand
-- Sync keys (OpenVibe.Download backups): a person makes a key on /sync and gives it to the openvibe-download command
-- (openvibe-sdk) on their own computer, which keeps a folder backed up in their drive. A key acts for its owner on the
-- drive's /api/v1 only (files, folders, uploads, usage; never share links, Pics or Video). Only a hash is kept; the key
-- is shown once. A revoked key stays listed until its owner deletes the account.
CREATE TABLE mh_sync_keys (
    id           text COLLATE "C" PRIMARY KEY,          -- dsk_<ULID>
    owner        text COLLATE "C" NOT NULL,             -- user:usr_…
    name         text NOT NULL,                         -- what the person called it (the computer it is for)
    token_hash   text COLLATE "C" NOT NULL UNIQUE,      -- sha256 hex of the whole key
    prefix       text COLLATE "C" NOT NULL,             -- the key's first characters, to tell keys apart in the list
    created_at   text COLLATE "C" NOT NULL,
    last_used_at text COLLATE "C",
    revoked_at   text COLLATE "C"
);
CREATE INDEX mh_sync_keys_owner ON mh_sync_keys (owner, created_at DESC);
