-- phase: expand
-- OpenVibe.Video uploads in OpenVibe.Search (server/video/search-index.js): what was last sent for each upload, so a
-- sweep re-sends a document only when its content changed. Search's own listing gives the stored revision.
CREATE TABLE video_search_state (
    id         text COLLATE "C" PRIMARY KEY,          -- the upload's vup_ id (the Search document id)
    hash       text COLLATE "C" NOT NULL,             -- sha256 of the document last sent
    revision   integer NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
