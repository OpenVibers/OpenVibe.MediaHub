-- phase: expand
-- Read-only agent access to a person's explicitly selected files. A capability is necessary to use the read route,
-- but each row is also bound to one file, one owner and one agent subject; grants can be revoked or expire.
CREATE TABLE mh_agent_grants (
    id            text COLLATE "C" PRIMARY KEY,      -- agr_<ULID>
    owner         text COLLATE "C" NOT NULL,         -- user:usr_…
    file_id       text COLLATE "C" NOT NULL REFERENCES mh_files (id) ON DELETE CASCADE,
    agent_subject text COLLATE "C" NOT NULL,         -- agent:agt_…
    created_at    text COLLATE "C" NOT NULL,
    expires_at    text COLLATE "C" NOT NULL,
    revoked_at    text COLLATE "C"
);

CREATE INDEX mh_agent_grants_owner ON mh_agent_grants (owner, created_at DESC);
CREATE INDEX mh_agent_grants_live ON mh_agent_grants (file_id, agent_subject, expires_at)
    WHERE revoked_at IS NULL;
