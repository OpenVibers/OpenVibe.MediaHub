'use strict';

/**
 * OpenVibe.MediaHub — watch ids for the videos that live here (an upload, or a recording made in the browser).
 *
 * A watch page on openvibe.video is /watch?v=<watch id>, YouTube's shape, so a page cannot be found by counting: 8
 * random bytes as URL-safe base64 is 11 characters and 64 bits of entropy, never derived from the row's id or its
 * seq. The id is fixed for the row's life.
 *
 * The other two kinds of video on openvibe.video — a stream recording and a clip — belong to OpenVibe.Media, which
 * mints their ids. This module only owns the ones Media does not: video_uploads. The two spaces are separate, and the
 * page that answers /watch asks this table first and Media second.
 *
 * Migration 0024 adds the column and its partial unique index; rows older than it are filled in bounded, idempotent
 * batches (backfill, below, only where watch_id IS NULL) at boot, and a row read before it is reached gets one then
 * (ensure).
 */
const crypto = require('crypto');

const WATCH_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BACKFILL_BATCH = 500;
const MINT_ATTEMPTS = 5;

/** A fresh watch id: 64 random bits as 11 URL-safe base64 characters. */
function mint() {
    return crypto.randomBytes(8).toString('base64url');
}

/** Is this a watch id's shape? (Checked before any query.) */
function isWatchId(v) {
    return WATCH_ID_RE.test(String(v || ''));
}

function createWatchIds({ s }) {
    /** A watch id no upload holds yet; retries on the vanishing chance of a clash. */
    async function mintUnique() {
        for (let i = 0; i < MINT_ATTEMPTS; i++) {
            const id = mint();
            const taken = await s.db.maybe('SELECT 1 FROM video_uploads WHERE watch_id = $1', [id]);
            if (!taken) return id;
        }
        throw new Error('could not mint a watch id that no upload holds');
    }

    /** The row's watch id, minting and storing one when it has none yet. */
    async function ensure(row) {
        if (!row) return null;
        if (row.watch_id) return row.watch_id;
        const minted = await mintUnique();
        await s.db.query('UPDATE video_uploads SET watch_id = $2 WHERE id = $1 AND watch_id IS NULL', [row.id, minted]);
        const after = await s.db.maybe('SELECT watch_id FROM video_uploads WHERE id = $1', [row.id]);
        return (after && after.watch_id) || null;
    }

    /** An upload by its watch id, or null. */
    async function byWatchId(watchId) {
        if (!isWatchId(watchId)) return null;
        return s.db.maybe('SELECT * FROM video_uploads WHERE watch_id = $1', [String(watchId)]);
    }

    /**
     * Fill rows that have none, in one bounded batch, and say how many were filled and how many are left.
     * Idempotent and resumable: it only writes where watch_id IS NULL.
     */
    async function backfill({ limit = BACKFILL_BATCH } = {}) {
        const budget = Math.max(0, Number(limit) || 0);
        let filled = 0;
        if (budget) {
            const rows = await s.db.many('SELECT id FROM video_uploads WHERE watch_id IS NULL ORDER BY id LIMIT $1', [budget]);
            for (const row of rows) {
                const id = await mintUnique();
                const out = await s.db.query('UPDATE video_uploads SET watch_id = $2 WHERE id = $1 AND watch_id IS NULL', [row.id, id]);
                if (out && Number(out.rowCount) > 0) filled += 1;
            }
        }
        const remaining = Number(await s.db.value('SELECT count(*) FROM video_uploads WHERE watch_id IS NULL')) || 0;
        return { filled, remaining };
    }

    /** Batch after batch, until none is left. */
    async function backfillAll({ batch = BACKFILL_BATCH, maxBatches = 10_000, log = null } = {}) {
        let filled = 0;
        let remaining = 0;
        for (let i = 0; i < maxBatches; i++) {
            const out = await backfill({ limit: batch });
            filled += out.filled;
            remaining = out.remaining;
            if (!out.filled) break;
        }
        if (log && filled) log.log(`[WatchId] gave ${filled} upload(s) a watch id; ${remaining} left`);
        return { filled, remaining };
    }

    return { mintUnique, ensure, byWatchId, backfill, backfillAll };
}

module.exports = { createWatchIds, mint, isWatchId, WATCH_ID_RE, BACKFILL_BATCH };
