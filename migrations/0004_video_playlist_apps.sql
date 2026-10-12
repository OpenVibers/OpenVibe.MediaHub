-- phase: expand
-- OpenVibe.Video playlists for apps, agents and services (plan T10): a playlist an app, agent or service
-- token makes is a normal playlist, owned by the token's requester (app:app_…, agent:agt_… or service:<slug>)
-- and recorded with the token's project. owner_username is the person's username when a person owns it, so
-- a public page can say who curated it. Nothing here is ever a credential, a key or a token.

ALTER TABLE video_playlists
    ADD COLUMN project_id text COLLATE "C",        -- prj_… when an app/agent/service token made it; NULL for a person
    ADD COLUMN owner_username text;                -- the person's username, when a person owns it; NULL otherwise
