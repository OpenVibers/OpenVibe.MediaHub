'use strict';

/**
 * Playlists on openvibe.video (step C): a signed-in person's named lists of OpenVibe.Live recordings and clips.
 * The rows hold only Live's public ids (kind + numeric id), never the media bytes — the watch pages ask Live for
 * the card and player details through the existing, cached Live client.
 *
 * The rules here are shared by the pages (server/video/pages.js) and the API (server/video/api.js) so a form and
 * a POST enforce the same numbers: 100 playlists per owner, 500 items per playlist (both from the environment),
 * a title of 1-120 characters, a description of at most 2,000, and a visibility of public | unlisted | private.
 *
 * A playlist belongs to a person (owner user:usr_…) or, through the API, to an app, agent or service
 * (owner app:app_… / agent:agt_… / service:<slug>). Nothing here trusts a caller's identity: the caller passes
 * the requester it already established, and this module only ever compares it with what the rows say.
 */

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const VISIBILITIES = ['public', 'unlisted', 'private'];
const KINDS = ['vod', 'clip'];
const PLAYLIST_ID_RE = /^vpl_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Live's ids: positive safe integers (what /v/:id and /c/:id accept). */
function isItemId(v) {
    return /^[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
}

function createPlaylists({ s, config, log = console }) {
    const nowIso = () => new Date(s.now()).toISOString();
    const max = () => Number(config.video.playlistsMax) || 100;
    const itemsMax = () => Number(config.video.playlistItemsMax) || 500;

    const cleanTitle = (v) => String(v == null ? '' : v).trim();
    const cleanDescription = (v) => String(v == null ? '' : v).trim();

    function titleError(title) {
        if (!title) return 'A playlist needs a title.';
        if (title.length > TITLE_MAX) return `A title is at most ${TITLE_MAX} characters.`;
        return null;
    }
    function descriptionError(desc) {
        if (desc.length > DESCRIPTION_MAX) return `A description is at most ${DESCRIPTION_MAX} characters.`;
        return null;
    }

    const get = async (id) => {
        if (!PLAYLIST_ID_RE.test(String(id || ''))) return null;
        return s.db.maybe('SELECT * FROM video_playlists WHERE id = $1', [id]);
    };

    const own = async (owner, id) => {
        if (!PLAYLIST_ID_RE.test(String(id || ''))) return null;
        const row = await s.db.maybe('SELECT * FROM video_playlists WHERE id = $1', [id]);
        return row && row.owner === owner ? row : null;
    };

    /** The person's playlists, newest-updated first, each with its item count. */
    const list = (owner) => s.db.many(
        `SELECT p.*, (SELECT count(*) FROM video_playlist_items i WHERE i.playlist_id = p.id)::int AS item_count
           FROM video_playlists p
          WHERE p.owner = $1
          ORDER BY p.updated_at DESC, p.id DESC`, [owner]);

    /**
     * A person's public playlists, newest first, paged by an opaque keyset cursor over (updated_at, id). Unlisted
     * and private playlists never appear here. `limit` is clamped to 1-50 by the caller and again here.
     */
    async function publicByOwner(owner, { limit, cursor = null } = {}) {
        const n = Math.min(50, Math.max(1, Number(limit) || 20));
        let after = null;
        if (cursor) {
            try {
                const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
                if (parsed && typeof parsed.updated_at === 'string' && typeof parsed.id === 'string' && PLAYLIST_ID_RE.test(parsed.id)) after = parsed;
            } catch { after = null; }
        }
        const params = [owner];
        let where = "p.owner = $1 AND p.visibility = 'public'";
        if (after) {
            params.push(after.updated_at, after.id);
            where += ` AND (p.updated_at, p.id) < ($${params.length - 1}, $${params.length})`;
        }
        const rows = await s.db.many(
            `SELECT p.*, (SELECT count(*) FROM video_playlist_items i WHERE i.playlist_id = p.id)::int AS item_count
               FROM video_playlists p
              WHERE ${where}
              ORDER BY p.updated_at DESC, p.id DESC
              LIMIT ${n + 1}`, params);
        const hasMore = rows.length > n;
        const page = hasMore ? rows.slice(0, n) : rows;
        const last = page.length ? page[page.length - 1] : null;
        const next = hasMore && last ? Buffer.from(JSON.stringify({ updated_at: last.updated_at, id: last.id })).toString('base64url') : null;
        return { playlists: page, next };
    }

    const count = (owner) => s.db.value('SELECT count(*) FROM video_playlists WHERE owner = $1', [owner]).then(Number);

    /** A person's public name on their playlists follows their account: playlists made before the column existed, or
     *  before a rename, get the current username when the person next opens their playlists. */
    async function refreshOwnerUsername(owner, username) {
        if (!String(owner || '').startsWith('user:') || !username) return;
        await s.db.query('UPDATE video_playlists SET owner_username = $2 WHERE owner = $1 AND owner_username IS DISTINCT FROM $2',
            [owner, String(username).slice(0, 64)]);
    }

    async function create(owner, { title, description = '', visibility = 'private', ownerUsername = null, projectId = null }) {
        const t = cleanTitle(title);
        const terr = titleError(t);
        if (terr) return { ok: false, code: 'playlist.invalid_title', detail: terr };
        const d = cleanDescription(description);
        const derr = descriptionError(d);
        if (derr) return { ok: false, code: 'playlist.invalid_description', detail: derr };
        if (!VISIBILITIES.includes(visibility)) return { ok: false, code: 'playlist.invalid_visibility', detail: 'Visibility is public, unlisted or private.' };
        if (await count(owner) >= max()) {
            return { ok: false, code: 'playlist.limit', detail: `You have ${max()} playlists (the most one person may have). Delete one first.` };
        }
        const now = nowIso();
        const row = {
            id: s.newId('vpl'), owner, title: t, description: d, visibility,
            owner_username: ownerUsername ? String(ownerUsername).slice(0, 64) : null,
            project_id: projectId ? String(projectId) : null,
            created_at: now, updated_at: now,
        };
        await s.db.query(
            `INSERT INTO video_playlists (id, owner, title, description, visibility, owner_username, project_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [row.id, row.owner, row.title, row.description, row.visibility, row.owner_username, row.project_id, row.created_at, row.updated_at]);
        return { ok: true, playlist: row };
    }

    /** PATCH { title?, description?, visibility? }: each field present is validated and replaced. */
    async function update(owner, id, patch) {
        const row = await own(owner, id);
        if (!row) return { ok: false, code: 'playlist.not_found', detail: 'No such playlist.' };
        const next = { title: row.title, description: row.description, visibility: row.visibility };
        if ('title' in patch) {
            const t = cleanTitle(patch.title);
            const err = titleError(t);
            if (err) return { ok: false, code: 'playlist.invalid_title', detail: err };
            next.title = t;
        }
        if ('description' in patch) {
            const d = cleanDescription(patch.description);
            const err = descriptionError(d);
            if (err) return { ok: false, code: 'playlist.invalid_description', detail: err };
            next.description = d;
        }
        if ('visibility' in patch) {
            if (!VISIBILITIES.includes(patch.visibility)) return { ok: false, code: 'playlist.invalid_visibility', detail: 'Visibility is public, unlisted or private.' };
            next.visibility = patch.visibility;
        }
        const updated = nowIso();
        await s.db.exec('UPDATE video_playlists SET title = $2, description = $3, visibility = $4, updated_at = $5 WHERE id = $1',
            [id, next.title, next.description, next.visibility, updated]);
        return { ok: true, playlist: { ...row, ...next, updated_at: updated } };
    }

    async function remove(owner, id) {
        const row = await own(owner, id);
        if (!row) return { ok: false, code: 'playlist.not_found', detail: 'No such playlist.' };
        await s.db.exec('DELETE FROM video_playlists WHERE id = $1', [id]);
        return { ok: true };
    }

    const items = (playlistId) => s.db.many(
        'SELECT * FROM video_playlist_items WHERE playlist_id = $1 ORDER BY position ASC, added_at ASC', [playlistId]);

    const getItem = (playlistId, kind, itemId) => s.db.maybe(
        'SELECT * FROM video_playlist_items WHERE playlist_id = $1 AND kind = $2 AND item_id = $3', [playlistId, kind, itemId]);

    const touch = (playlistId) => s.db.exec('UPDATE video_playlists SET updated_at = $2 WHERE id = $1', [playlistId, nowIso()]);

    async function addItem(owner, playlistId, { kind, id }) {
        const row = await own(owner, playlistId);
        if (!row) return { ok: false, code: 'playlist.not_found', detail: 'No such playlist.' };
        if (!KINDS.includes(kind)) return { ok: false, code: 'playlist.invalid_kind', detail: 'kind is vod or clip.' };
        if (!isItemId(id)) return { ok: false, code: 'playlist.invalid_item', detail: 'item id must be a positive whole number.' };
        const itemId = Number(id);
        const n = await s.db.value('SELECT count(*) FROM video_playlist_items WHERE playlist_id = $1', [playlistId]).then(Number);
        if (n >= itemsMax()) return { ok: false, code: 'playlist.items_limit', detail: `A playlist holds at most ${itemsMax()} items.` };
        const pos = await s.db.value('SELECT coalesce(max(position), -1) FROM video_playlist_items WHERE playlist_id = $1', [playlistId]).then((v) => Number(v) + 1);
        try {
            await s.db.query('INSERT INTO video_playlist_items (playlist_id, kind, item_id, position, added_at) VALUES ($1, $2, $3, $4, $5)',
                [playlistId, kind, itemId, pos, nowIso()]);
        } catch (err) {
            if (err && err.code === '23505') return { ok: false, code: 'playlist.item_duplicate', detail: 'That item is already in the playlist.' };
            throw err;
        }
        await touch(playlistId);
        return { ok: true, item: await getItem(playlistId, kind, itemId) };
    }

    async function removeItem(owner, playlistId, kind, id) {
        const row = await own(owner, playlistId);
        if (!row) return { ok: false, code: 'playlist.not_found', detail: 'No such playlist.' };
        if (!KINDS.includes(kind) || !isItemId(id)) return { ok: false, code: 'playlist.invalid_item', detail: 'That item is not valid.' };
        const removed = await s.db.exec('DELETE FROM video_playlist_items WHERE playlist_id = $1 AND kind = $2 AND item_id = $3',
            [playlistId, kind, Number(id)]);
        if (!removed) return { ok: false, code: 'playlist.item_not_found', detail: 'No such item in this playlist.' };
        await touch(playlistId);
        return { ok: true };
    }

    /** Reorder: the full playlist as an ordered list of { kind, id }; it must be exactly the current items. */
    async function reorder(owner, playlistId, list) {
        const row = await own(owner, playlistId);
        if (!row) return { ok: false, code: 'playlist.not_found', detail: 'No such playlist.' };
        if (!Array.isArray(list) || list.length > itemsMax()) return { ok: false, code: 'playlist.invalid_items', detail: 'items must be a list of { kind, id }.' };
        const wanted = list.map((x, i) => {
            if (!x || !KINDS.includes(x.kind) || !isItemId(x.id)) return null;
            return { kind: x.kind, id: Number(x.id), position: i };
        });
        if (wanted.some((x) => x === null)) return { ok: false, code: 'playlist.invalid_items', detail: 'items must be a list of { kind, id }.' };
        const key = (x) => `${x.kind}:${x.id}`;
        const wantKeys = new Set(wanted.map(key));
        if (wantKeys.size !== wanted.length) return { ok: false, code: 'playlist.invalid_items', detail: 'items must not repeat.' };
        const existing = await items(playlistId);
        if (wantKeys.size !== existing.length || existing.some((x) => !wantKeys.has(key({ kind: x.kind, id: Number(x.item_id) })))) {
            return { ok: false, code: 'playlist.invalid_items', detail: 'items must be exactly the playlist items, in a new order.' };
        }
        await s.db.tx(async (t) => {
            for (const w of wanted) {
                await t.exec('UPDATE video_playlist_items SET position = $3 WHERE playlist_id = $1 AND kind = $2 AND item_id = $4',
                    [playlistId, w.kind, w.position, w.id]);
            }
        });
        await touch(playlistId);
        return { ok: true, items: await items(playlistId) };
    }

    return {
        TITLE_MAX, DESCRIPTION_MAX, VISIBILITIES, KINDS, isItemId, isPlaylistId: (id) => PLAYLIST_ID_RE.test(String(id || '')),
        list, publicByOwner, refreshOwnerUsername, get, own, create, update, remove, items, getItem, addItem, removeItem, reorder,
    };
}

module.exports = { createPlaylists, TITLE_MAX, DESCRIPTION_MAX, VISIBILITIES, KINDS, isItemId };
