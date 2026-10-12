'use strict';
/**
 * OpenVibe.Video playlists as a real API (plan T10): Bearer person tokens, app/agent/service capability
 * tokens (video.playlist.read / video.playlist.manage), anonymous public reads and the per-user public list.
 * No Live is started: the API returns item ids (the watch pages resolve the cards lazily), and the one page
 * checked here is an empty playlist.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

function vreq(base, path, { host = 'openvibe.video', method = 'GET', cookie, bearer, json, headers = {}, same = true } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: host, ...headers };
        if (cookie) h.cookie = cookie;
        if (bearer) h.authorization = `Bearer ${bearer}`;
        if (same) h['sec-fetch-site'] = 'same-origin';
        let data;
        if (json !== undefined) {
            data = Buffer.from(JSON.stringify(json));
            h['content-length'] = data.length;
            h['content-type'] = 'application/json';
        }
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json() { return JSON.parse(buf.toString('utf8')); } });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function api(t, path, { method = 'GET', cookie, bearer, json, same = true } = {}) {
    return vreq(t.base, path, { method, cookie, bearer, json, same });
}

/** Seed a developer app in the mock Network and mint an app token with the given capabilities. */
function mintApp(t, caps) {
    const appId = ids.newId('app');
    const projectId = ids.newId('project');
    t.network.state.projects.set(projectId, { id: projectId, name: 'project', environment_policy: 'production', allowance: caps, created_at: new Date().toISOString(), archived_at: null });
    t.network.state.apps.set(appId, { id: appId, project_id: projectId, environment: 'production', name: 'app', redirect_uris: [], created_at: new Date().toISOString(), revoked_at: null });
    return t.network.mintApp(appId, 'openvibe.download', caps);
}

(async () => {
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimBearer = t.network.userToken(kim);
    const kimCookie = t.signIn(kim);

    await check('a person Bearer token does playlist CRUD', async () => {
        const created = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Bearer list', visibility: 'public' } });
        assert.strictEqual(created.status, 201, created.text);
        const pl = created.json().playlist;
        assert.match(pl.id, /^vpl_[0-9A-HJKMNP-TV-Z]{26}$/);

        const list = await api(t, '/api/v1/video/playlists', { method: 'GET', bearer: kimBearer });
        assert.strictEqual(list.status, 200, list.text);
        assert.ok(list.json().playlists.some((x) => x.id === pl.id));

        const renamed = await api(t, `/api/v1/video/playlists/${pl.id}`, { method: 'PATCH', bearer: kimBearer, json: { title: 'Renamed by token' } });
        assert.strictEqual(renamed.status, 200, renamed.text);
        assert.strictEqual(renamed.json().playlist.title, 'Renamed by token');

        const gone = await api(t, `/api/v1/video/playlists/${pl.id}`, { method: 'DELETE', bearer: kimBearer });
        assert.strictEqual(gone.status, 204, gone.text);
    });

    await check('a session write from another origin is refused', async () => {
        const r = await api(t, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'csrf' }, same: false });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'request.cross_site');
    });

    await check('an app token without the capability is refused', async () => {
        const token = mintApp(t, []);
        const r = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: token, json: { title: 'nope' } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'capability.denied');
    });

    await check('an app with video.playlist.manage manages its own, and a person\'s is 404', async () => {
        const token = mintApp(t, ['video.playlist.manage']);

        const created = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: token, json: { title: 'App list', visibility: 'public' } });
        assert.strictEqual(created.status, 201, created.text);
        const pl = created.json().playlist;

        const renamed = await api(t, `/api/v1/video/playlists/${pl.id}`, { method: 'PATCH', bearer: token, json: { title: 'App list edited' } });
        assert.strictEqual(renamed.status, 200, renamed.text);
        assert.strictEqual(renamed.json().playlist.title, 'App list edited');

        // A person's playlist belongs to the person; an app is not its owner, so it answers 404 (not 403).
        const persons = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Kim\'s own', visibility: 'private' } });
        const pid = persons.json().playlist.id;
        const touch = await api(t, `/api/v1/video/playlists/${pid}`, { method: 'PATCH', bearer: token, json: { title: 'steal' } });
        assert.strictEqual(touch.status, 404, touch.text);
        assert.strictEqual(touch.json().code, 'playlist.not_found');

        const gone = await api(t, `/api/v1/video/playlists/${pl.id}`, { method: 'DELETE', bearer: token });
        assert.strictEqual(gone.status, 204, gone.text);
    });

    await check('an app with only video.playlist.read cannot write', async () => {
        const token = mintApp(t, ['video.playlist.read']);
        const write = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: token, json: { title: 'readonly' } });
        assert.strictEqual(write.status, 403, write.text);
        assert.strictEqual(write.json().code, 'capability.denied');

        const list = await api(t, '/api/v1/video/playlists', { method: 'GET', bearer: token });
        assert.strictEqual(list.status, 200, list.text);
    });

    await check('anonymous reads public and unlisted by id, private answers 404', async () => {
        const pub = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Public for the world', visibility: 'public' } });
        const pubId = pub.json().playlist.id;
        await api(t, `/api/v1/video/playlists/${pubId}/items`, { method: 'POST', bearer: kimBearer, json: { kind: 'vod', id: 101 } });

        const unlisted = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Unlisted by link', visibility: 'unlisted' } });
        const unlistedId = unlisted.json().playlist.id;

        const priv = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Private', visibility: 'private' } });
        const privId = priv.json().playlist.id;

        const publicRead = await api(t, `/api/v1/video/playlists/${pubId}`);
        assert.strictEqual(publicRead.status, 200, publicRead.text);
        const publicBody = publicRead.json();
        assert.strictEqual(publicBody.playlist.visibility, 'public');
        assert.strictEqual(publicBody.playlist.owner.kind, 'user');
        assert.strictEqual(publicBody.playlist.owner.username, 'kim');
        assert.deepStrictEqual(publicBody.items.map((x) => [x.kind, x.id, x.position]), [['vod', 101, 0]]);

        const unlistedRead = await api(t, `/api/v1/video/playlists/${unlistedId}`);
        assert.strictEqual(unlistedRead.status, 200, unlistedRead.text);

        const privateRead = await api(t, `/api/v1/video/playlists/${privId}`);
        assert.strictEqual(privateRead.status, 404, privateRead.text);
        assert.strictEqual(privateRead.json().code, 'playlist.not_found');

        // An app without video.playlist.read is refused a public read, but a private one still answers 404 (never 403).
        const noCap = mintApp(t, []);
        const appPublic = await api(t, `/api/v1/video/playlists/${pubId}`, { bearer: noCap });
        assert.strictEqual(appPublic.status, 403, appPublic.text);
        assert.strictEqual(appPublic.json().code, 'capability.denied');
        const appPrivate = await api(t, `/api/v1/video/playlists/${privId}`, { bearer: noCap });
        assert.strictEqual(appPrivate.status, 404, appPrivate.text);
        assert.strictEqual(appPrivate.json().code, 'playlist.not_found');
    });

    await check('the per-user public list is paginated and never lists unlisted/private', async () => {
        const pager = t.network.addUser('pager');
        const pagerBearer = t.network.userToken(pager);
        for (const title of ['public-a', 'public-b', 'public-c']) {
            const r = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: pagerBearer, json: { title, visibility: 'public' } });
            assert.strictEqual(r.status, 201, r.text);
        }
        await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: pagerBearer, json: { title: 'hidden-unlisted', visibility: 'unlisted' } });
        await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: pagerBearer, json: { title: 'hidden-private', visibility: 'private' } });

        const page1 = await api(t, '/api/v1/video/users/pager/playlists?limit=2');
        assert.strictEqual(page1.status, 200, page1.text);
        const body1 = page1.json();
        assert.strictEqual(body1.playlists.length, 2);
        assert.ok(body1.next_cursor, 'a second page exists');
        assert.deepStrictEqual(body1.playlists.map((x) => x.title), ['public-c', 'public-b']);
        assert.ok(!body1.playlists.some((x) => x.title.startsWith('hidden-')), 'unlisted/private never listed');

        const page2 = await api(t, `/api/v1/video/users/pager/playlists?limit=2&cursor=${encodeURIComponent(body1.next_cursor)}`);
        assert.strictEqual(page2.status, 200, page2.text);
        const body2 = page2.json();
        assert.deepStrictEqual(body2.playlists.map((x) => x.title), ['public-a']);
        assert.strictEqual(body2.next_cursor, null);

        const unknown = await api(t, '/api/v1/video/users/sam/playlists');
        assert.strictEqual(unknown.status, 200, unknown.text);
        assert.strictEqual(unknown.json().playlists.length, 0);
    });

    await check('an app-owned public playlist page says Curated by an app', async () => {
        const token = mintApp(t, ['video.playlist.manage']);
        const created = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: token, json: { title: 'App public list', visibility: 'public' } });
        const id = created.json().playlist.id;

        const page = await vreq(t.base, `/playlists/${id}`);
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(page.text.includes('Curated by an app'), page.text.slice(0, 600));
        assert.ok(!page.text.includes('href="/@'), 'no username link for an app owner');

        // A person-owned public playlist attributes the person with a username link.
        const persons = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Kim public', visibility: 'public' } });
        const personId = persons.json().playlist.id;
        const personPage = await vreq(t.base, `/playlists/${personId}`);
        assert.ok(personPage.text.includes('@kim'), personPage.text.slice(0, 600));
        assert.ok(personPage.text.includes('href="/@kim"'), 'a person owner links to their channel');
    });

    await check('a playlist with no stored username gets the owner\'s when they open their playlists', async () => {
        const made = await api(t, '/api/v1/video/playlists', { method: 'POST', bearer: kimBearer, json: { title: 'Older list', visibility: 'public' } });
        const id = made.json().playlist.id;
        await t.ctx.s.db.query('UPDATE video_playlists SET owner_username = NULL WHERE id = $1', [id]);   // as made before the column
        let pg = await vreq(t.base, `/playlists/${id}`);
        assert.ok(pg.text.includes('Curated by an OpenVibe member'), pg.text.slice(0, 600));
        const mine = await vreq(t.base, '/playlists', { cookie: kimCookie });
        assert.strictEqual(mine.status, 200);
        pg = await vreq(t.base, `/playlists/${id}`);
        assert.ok(pg.text.includes('href="/@kim"'), 'the owner\'s visit stored their username');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
