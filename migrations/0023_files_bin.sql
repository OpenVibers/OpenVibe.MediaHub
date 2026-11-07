-- phase: expand
-- The bin (2026-11-07): a deleted file is kept for 30 days so its owner can restore it. The row and its bytes stay
-- where they are; binned_at is when it went to the bin, and a due job soft-deletes the row and asks Media to delete
-- the object once it is older than that. A binned row still counts against storage until it is purged.
ALTER TABLE mh_files ADD COLUMN binned_at timestamptz;

-- What the bin page lists and what the due purge scans: this person's binned files, newest first.
CREATE INDEX mh_files_binned ON mh_files (owner) WHERE binned_at IS NOT NULL AND deleted_at IS NULL;
