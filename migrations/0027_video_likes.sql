-- phase: expand
-- A person's likes on Live recordings and clips, shown on openvibe.video.
CREATE TABLE video_likes (
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('vod', 'clip')),
    item_id bigint NOT NULL,
    owner text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (kind, item_id, owner)
);
CREATE INDEX video_likes_owner ON video_likes (owner);
