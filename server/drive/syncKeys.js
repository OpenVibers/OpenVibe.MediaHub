'use strict';
/**
 * Sync keys (migration 0011): what lets the openvibe-download command (openvibe-sdk) back a folder up into a person's
 * drive without a browser. A key is `ovdl_` and 43 url-safe characters; only its sha256 is stored, and it is shown
 * once. It acts for its owner on the drive's /api/v1 only (server/http/api.js decides that), so a leaked key can read
 * and fill the drive but cannot make share links or touch Pics or Video, and its owner revokes it on /sync.
 */
const crypto = require('crypto');

const KEY_RE = /^ovdl_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 60;
/** How often a key's last-used time is written (a sync makes many requests). */
const TOUCH_MS = 5 * 60 * 1000;

const hashOf = (key) => crypto.createHash('sha256').update(key).digest('hex');

function createSyncKeys({ s, config }) {
    const max = () => Number(config.quotas.syncKeys) || 10;
    const touched = new Map();

    const list = (owner) => s.db.many(
        'SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM mh_sync_keys WHERE owner = $1 ORDER BY created_at DESC', [owner]);

    /** A new key for `owner`: { ok, key (shown once), row } or { ok: false, code, detail }. */
    async function create(owner, rawName) {
        const name = Array.from(String(rawName == null ? '' : rawName), (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').trim();
        if (!name) return { ok: false, code: 'sync_key.name', detail: 'Name the key after the computer it is for.' };
        if (name.length > NAME_MAX) return { ok: false, code: 'sync_key.name', detail: `A name is at most ${NAME_MAX} characters.` };
        const live = Number(await s.db.value('SELECT count(*) FROM mh_sync_keys WHERE owner = $1 AND revoked_at IS NULL', [owner]));
        if (live >= max()) return { ok: false, code: 'sync_key.limit', detail: `You have ${max()} sync keys (the most one person may). Revoke one first.` };
        const key = `ovdl_${crypto.randomBytes(32).toString('base64url')}`;
        const row = await s.db.one(
            `INSERT INTO mh_sync_keys (id, owner, name, token_hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, prefix, created_at, last_used_at, revoked_at`,
            [s.newId('dsk'), owner, name, hashOf(key), key.slice(0, 12), s.iso()]);
        return { ok: true, key, row };
    }

    async function revoke(owner, id) {
        const n = await s.db.exec('UPDATE mh_sync_keys SET revoked_at = $3 WHERE owner = $1 AND id = $2 AND revoked_at IS NULL', [owner, String(id || ''), s.iso()]);
        return n > 0;
    }

    /** The owner a key acts for, or null (malformed, unknown or revoked). */
    async function resolve(key) {
        if (!KEY_RE.test(String(key || ''))) return null;
        const row = await s.db.maybe('SELECT id, owner FROM mh_sync_keys WHERE token_hash = $1 AND revoked_at IS NULL', [hashOf(key)]);
        if (!row) return null;
        const now = s.now();
        if ((touched.get(row.id) || 0) + TOUCH_MS < now) {
            touched.set(row.id, now);
            await s.db.exec('UPDATE mh_sync_keys SET last_used_at = $2 WHERE id = $1', [row.id, s.iso()]);
        }
        return row.owner;
    }

    return { list, create, revoke, resolve, NAME_MAX, max };
}

module.exports = { createSyncKeys, KEY_RE };
