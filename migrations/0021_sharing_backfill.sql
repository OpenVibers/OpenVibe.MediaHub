-- phase: migrate
-- Every upload and album that existed before sharing is registered once, so canView has a row for all
-- of them. Pictures and albums were always "anyone with the link", so they are Everyone; a video upload
-- keeps its own column's words (public → Everyone, unlisted → the link, private → Only me).
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'mediahub', 'picture', p.id,
    CASE
        WHEN p.owner LIKE 'user:usr\_%' THEN jsonb_build_object('type', 'user', 'id', substr(p.owner, 6))
        WHEN p.owner LIKE 'guest:gst\_%' THEN jsonb_build_object('type', 'guest', 'id', substr(p.owner, 7))
        ELSE jsonb_build_object('type', 'service', 'id', 'mediahub')
    END,
    'public'
FROM pics_images p WHERE p.state <> 'removed'
ON CONFLICT (service, kind, resource_id) DO NOTHING;

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'mediahub', 'album', a.id,
    CASE
        WHEN a.owner LIKE 'user:usr\_%' THEN jsonb_build_object('type', 'user', 'id', substr(a.owner, 6))
        WHEN a.owner LIKE 'guest:gst\_%' THEN jsonb_build_object('type', 'guest', 'id', substr(a.owner, 7))
        ELSE jsonb_build_object('type', 'service', 'id', 'mediahub')
    END,
    'public'
FROM pics_albums a
ON CONFLICT (service, kind, resource_id) DO NOTHING;

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'mediahub', 'video', v.id,
    CASE
        WHEN v.owner LIKE 'user:usr\_%' THEN jsonb_build_object('type', 'user', 'id', substr(v.owner, 6))
        WHEN v.owner LIKE 'guest:gst\_%' THEN jsonb_build_object('type', 'guest', 'id', substr(v.owner, 7))
        ELSE jsonb_build_object('type', 'service', 'id', 'mediahub')
    END,
    CASE v.visibility WHEN 'public' THEN 'public' WHEN 'unlisted' THEN 'link' ELSE 'private' END
FROM video_uploads v WHERE v.state <> 'removed'
ON CONFLICT (service, kind, resource_id) DO NOTHING;
