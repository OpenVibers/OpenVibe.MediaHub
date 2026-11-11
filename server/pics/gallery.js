'use strict';
/**
 * The public gallery: what OpenVibe.Pics shows when a picture's owner publishes it.
 *
 * A picture is public only when three things agree: its own row says it is listed and active, its audience is
 * Everyone, and the share row says Everyone too. The share row is the authority (openvibe-sdk/share); the listed
 * flag is the owner's opt-in. So a picture stays off the gallery by default, and it leaves the gallery the moment the owner
 * narrows it (server/sharing.js clears the flag) or a moderator hides it.
 */
const { html, raw } = require('../render/html');
const glyphs = require('openvibe-shared/glyphs');
const kit = require('openvibe-shared/kit');
const labelsUi = require('../render/labels-ui');
const PUBLIC = "i.listed = true AND i.state = 'active' AND i.audience = 'public' AND EXISTS (SELECT 1 FROM shares sh WHERE sh.service = 'mediahub' AND sh.kind = 'picture' AND sh.resource_id = i.id AND sh.audience = 'public')";
const isPublic = (row) => Boolean(row.listed && row.state === 'active' && row.audience === 'public');
const tags = (row) => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } };
function parseTags(value) {
    if (!Array.isArray(value) || value.length > 10 || value.some((t) => typeof t !== 'string' || !/^[\p{L}\p{N}_-]{1,32}$/u.test(t))) return null;
    return [...new Set(value.map((t) => t.toLowerCase()))];
}
/** The heading icon the showcase kit puts beside every section title (openvibe-shared/showcase keeps its own copy). */
function headIcon(name) {
    const key = glyphs.NAMES.includes(name) ? name : (glyphs.fromFa ? glyphs.fromFa(name) : null);
    return key && glyphs.path(key) ? `<span class="sc-h-ic" aria-hidden="true">${glyphs.svg(key, { size: 18 })}</span>` : '';
}
function options(query = {}) {
    return { sort: ['popular', 'new', 'rising'].includes(query.sort) ? query.sort : 'popular',
        q: String(query.q || '').trim().slice(0, 120), tag: String(query.tag || '').trim().toLowerCase().slice(0, 32),
        offset: Math.min(10000, Math.max(0, parseInt(query.cursor, 10) || 0)), limit: Math.min(30, Math.max(1, parseInt(query.limit, 10) || 30)) };
}
async function browse(s, query) {
    const o = options(query);
    const order = o.sort === 'new' ? 'published_at DESC, id DESC' : o.sort === 'rising' ? 'recent_likes DESC, published_at DESC, id DESC' : 'likes DESC, views DESC, published_at DESC, id DESC';
    const rows = await s.db.many(`SELECT * FROM (SELECT i.*,
        (SELECT count(*)::int FROM pics_likes l WHERE l.image_id = i.id) AS likes,
        (SELECT count(*)::int FROM pics_views v WHERE v.image_id = i.id) AS views,
        (SELECT count(*)::int FROM pics_likes l WHERE l.image_id = i.id AND l.created_at > $5::timestamptz) AS recent_likes
        FROM pics_images i WHERE ${PUBLIC}
        AND ($1 = '' OR position(lower($1) in lower(i.title || ' ' || i.description || ' ' || i.tags)) > 0)
        AND ($2 = '' OR i.tags::jsonb @> jsonb_build_array($2::text))) g
        ORDER BY ${order} LIMIT $3 OFFSET $4`, [o.q, o.tag, o.limit + 1, o.offset, new Date(s.now() - 86400000).toISOString()]);
    return { rows: rows.slice(0, o.limit), next: rows.length > o.limit ? String(o.offset + o.limit) : null, ...o };
}
async function counts(s, id) {
    return s.db.maybe(`SELECT (SELECT count(*)::int FROM pics_likes WHERE image_id = $1) AS likes,
        (SELECT count(*)::int FROM pics_views WHERE image_id = $1) AS views`, [id]);
}
async function publish(ctx, row, viewer, input) {
    if (typeof input.listed !== 'boolean') return { error: 'Choose whether to publish this picture.' };
    const parsed = input.tags === undefined ? tags(row) : parseTags(input.tags);
    if (!parsed) return { error: 'Use up to ten tags of 1–32 letters, numbers, underscores or hyphens.' };
    if (input.listed && row.state !== 'active') return { error: 'Only an active picture can be published.' };
    await ctx.s.tx(async () => {
        if (input.listed) await ctx.sharing.setAudience(viewer, 'picture', row.id, 'public');
        await ctx.s.db.query(`UPDATE pics_images SET listed = $2, tags = $3, author_name = $4,
            published_at = CASE WHEN $2 THEN coalesce(published_at, $5::timestamptz) ELSE published_at END WHERE id = $1`,
        [row.id, input.listed, JSON.stringify(parsed), String(viewer.displayName || viewer.username || 'OpenVibe member').slice(0, 100), ctx.s.iso()]);
    });
    return { ok: true };
}
const wire = (pics, row) => ({ ...pics.toWire(row), author: row.author_name || 'OpenVibe member', tags: tags(row), likes: Number(row.likes || 0), views: Number(row.views || 0), published_at: row.published_at });
/** 1234 → "1.2K": counts on a card are read at a glance; the exact number is in the title and the screen-reader text. */
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n)).replace('.0', '');
const glyph = (name, size = 14) => raw(`<span class="ovp-gc-ic" aria-hidden="true">${glyphs.svg(name, { size })}</span>`);
const count = (n, one, many, name) => html`<span class="ovp-gc-n" title="${n} ${n === 1 ? one : many}">${glyph(name)}<span aria-hidden="true">${compact(n)}</span><span class="ovp-sr">${n} ${n === 1 ? one : many}</span></span>`;
// The picture is a link too (a second way in, out of the tab order); the title is the card's one link a keyboard meets.
const card = (pics, row) => html`<article class="ovp-gallery-card"${labelsUi.attrs(labelsUi.inForce(row), { owner: row.owner })}><a class="ovp-gc-pic" href="/i/${row.slug}" tabindex="-1"><img src="/i/${row.slug}/thumb.webp" alt="${pics.altOf(row)}" width="${row.width}" height="${row.height}" loading="lazy" decoding="async"></a>
<div class="ovp-gc-body"><h3 class="ovp-gc-title"><a href="/i/${row.slug}">${row.title || 'Untitled picture'}</a></h3>
<p class="ovp-gc-meta"><span class="ovp-gc-by">${row.author_name || 'OpenVibe member'}</span>${count(Number(row.views || 0), 'view', 'views', 'eye')}${count(Number(row.likes || 0), 'like', 'likes', 'heart')}</p>
${tags(row).length ? html`<p class="ovp-gc-tags">${tags(row).map((t) => html`<a class="ovp-tag" href="/?tag=${encodeURIComponent(t)}">#${t}</a>`)}</p>` : ''}</div></article>`;
const cards = (pics, rows) => rows.map((row) => card(pics, row));
function render(pics, result) {
    const href = (sort, cursor = '') => `/?${new URLSearchParams({ sort, q: result.q, tag: result.tag, ...(cursor ? { cursor } : {}) })}`;
    return html`<section class="ovp-section sc-sec" aria-labelledby="sc-discover-pictures"><h2 id="sc-discover-pictures">${raw(headIcon('image'))}<span>Discover pictures</span></h2>
<p class="sc-lede">Pictures people chose to share with everyone. An upload stays out of the gallery until its owner publishes it.</p>
<div class="ovp-gallery-bar"><form class="ovp-gallery-search" action="/" method="get" role="search">${glyph('search', 17)}<label class="ovp-sr" for="gallery-search">Search pictures and tags</label><input id="gallery-search" name="q" value="${result.q}" type="search" maxlength="120" placeholder="Search pictures or tags">${result.sort !== 'popular' ? html`<input type="hidden" name="sort" value="${result.sort}">` : ''}<button type="submit">Search</button></form>
<nav class="ovp-gallery-tabs" aria-label="Gallery order">${['popular', 'new', 'rising'].map((sort) => html`<a href="${href(sort)}" ${sort === result.sort ? raw('aria-current="page"') : ''}>${sort[0].toUpperCase() + sort.slice(1)}</a>`)}</nav></div>
${result.tag ? html`<p class="ovp-gallery-tagged">Tagged <b>#${result.tag}</b> <a href="${href(result.sort).replace(/&?tag=[^&]*/, '')}">Clear</a></p>` : ''}
<div class="ovp-gallery" data-gallery>${cards(pics, result.rows)}</div>
${!result.rows.length ? raw(`<div class="ovp-gallery-empty">${result.q || result.tag
    ? kit.empty({ icon: 'search', title: 'No public pictures match yet', text: 'Try another word or tag, or see everything published so far.', action: { href: '/', label: 'Clear the search', icon: 'image' } })
    : kit.empty({ icon: 'image', title: 'The gallery is waiting for its first picture', text: 'Upload a picture, then choose Publish to gallery on its page. Until you do, it stays out of the gallery.', action: { href: '/mine', label: 'Your pictures', icon: 'image' } })}</div>`) : ''}
${result.next ? html`<a class="ovp-btn" data-gallery-next href="${href(result.sort, result.next)}">More pictures</a>` : ''}<p role="status" data-gallery-status></p></section>`;
}
module.exports = { PUBLIC, isPublic, tags, parseTags, options, browse, counts, publish, wire, cards, render };
