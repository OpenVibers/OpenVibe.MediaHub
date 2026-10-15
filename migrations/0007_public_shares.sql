-- phase: expand
-- OpenVibe.Download: public share links (MediaFire-style, the owner's Q10). A share marked public opens and downloads
-- for anyone with the link, signed in or not; it cannot also name accounts. Reports on it may come from people
-- without an account, counted by a keyed hash of their address (never the address).
ALTER TABLE mh_shares ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT false;
