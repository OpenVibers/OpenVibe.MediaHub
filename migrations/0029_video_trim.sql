-- phase: expand
-- Studio's trim: a cut of an exact [start, end] range, with an optional cover frame taken from the
-- original. The copy is made by the existing cuts worker; the original is never changed.
ALTER TABLE video_cuts DROP CONSTRAINT IF EXISTS video_cuts_mode_check;
ALTER TABLE video_cuts ADD CONSTRAINT video_cuts_mode_check CHECK (mode IN ('pauses', 'tight', 'highlights', 'trim'));
ALTER TABLE video_cuts ADD COLUMN IF NOT EXISTS cover_seconds double precision;
ALTER TABLE video_cuts ADD COLUMN IF NOT EXISTS result_title text;
ALTER TABLE video_cuts ADD COLUMN IF NOT EXISTS result_visibility text;
