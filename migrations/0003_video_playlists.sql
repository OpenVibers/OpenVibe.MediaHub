-- phase: expand
-- OpenVibe.Video playlists (step C): a signed-in person's named lists of OpenVibe.Live recordings and clips,
-- shown on openvibe.video. Nothing here is ever a credential, a key or a token.
--
-- A playlist holds only Live's public ids (kind + numeric id), never the media bytes, so deleting a person's
-- account deletes the lists here and nothing else: the recordings and clips themselves stay on Live.

CREATE TABLE video_playlists (
    id          text COLLATE "C" PRIMARY KEY,          -- vpl_<ULID>
    owner       text COLLATE "C" NOT NULL,             -- user:usr_… (a playlist belongs to a person, never to an app)
    title       text NOT NULL,                         -- <= 120 characters (enforced in code)
    description text NOT NULL DEFAULT '',              -- <= 2,000 characters (enforced in code)
    visibility  text COLLATE "C" NOT NULL DEFAULT 'private',   -- public | unlisted | private
    created_at  text COLLATE "C" NOT NULL,
    updated_at  text COLLATE "C" NOT NULL,
    CHECK (visibility IN ('public', 'unlisted', 'private'))
);

-- The playlist page and the person's list are read as "this person's playlists, newest first".
CREATE INDEX video_playlists_owner ON video_playlists (owner, id DESC);

CREATE TABLE video_playlist_items (
    playlist_id text COLLATE "C" NOT NULL REFERENCES video_playlists (id) ON DELETE CASCADE,
    kind        text COLLATE "C" NOT NULL,             -- vod | clip
    item_id     bigint NOT NULL,                       -- Live's numeric id (the id /v/:id and /c/:id use)
    position    integer NOT NULL,                      -- 0-based order within the playlist
    added_at    text COLLATE "C" NOT NULL,
    CHECK (kind IN ('vod', 'clip')),
    UNIQUE (playlist_id, kind, item_id)
);

CREATE INDEX video_playlist_items_playlist ON video_playlist_items (playlist_id, position);
