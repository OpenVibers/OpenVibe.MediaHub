-- phase: expand
-- Fast exact-byte lookups stay scoped to the person who owns each picture.
CREATE INDEX pics_images_owner_source_hash ON pics_images (owner, source_sha256, created_at DESC)
    WHERE owner IS NOT NULL AND state = 'active';
CREATE INDEX pics_images_owner_hash ON pics_images (owner, sha256, created_at DESC)
    WHERE owner IS NOT NULL AND state = 'active';
