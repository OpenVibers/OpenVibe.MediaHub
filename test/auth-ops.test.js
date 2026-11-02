'use strict';
/**
 * Sign-in on openvibe-sdk/sso (client id media-hub, legacy cookies media-hub_at/media-hub_rt, SDK flow cookies ov_oauth_*),
 * truthful readiness (the database and the OAuth client are required; JWKS and Valkey are optional),
 * /release.json, loopback-only /metrics, and pages useful without JavaScript.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');

/** Every Set-Cookie of a response as a Cookie header (the SDK's flow spans several cookies). */
const cookieHeader = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/updates');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'media-hub');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{32}$/);
        const set = r.headers.getSetCookie().join('\n');
        assert.match(set, /ov_oauth_state=[^;]+;.*Path=\/auth.*HttpOnly/i);
        assert.match(set, /ov_oauth_verifier=[^;]+;.*Path=\/auth.*HttpOnly/i);
        assert.match(set, /ov_oauth_next=%2Fupdates|ov_oauth_next=\/updates/);
    });

    await check('openvibe.video and openvibe.pics sign in with their own registered callback URI', async () => {
        for (const [host, callback] of [['openvibe.video', 'https://openvibe.video/auth/callback'], ['openvibe.pics', 'https://openvibe.pics/auth/callback']]) {
            const r = await t.get('/auth/login', { headers: { 'x-forwarded-host': host } });
            assert.strictEqual(r.status, 302, host);
            assert.strictEqual(new URL(r.headers.get('location')).searchParams.get('redirect_uri'), callback, host);
        }
    });

    await check('callback exchanges the code with the matching verifier and sets httpOnly session cookies', async () => {
        const login = await t.get('/auth/login?next=/updates');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieHeader(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/updates');
        const set = r.headers.get('set-cookie');
        assert.match(set, /ov_token=[^;]+;.*HttpOnly/i);
        assert.match(set, /ov_refresh=[^;]+;.*HttpOnly/i);
        assert.match(set, /media-hub_at=;/, 'the legacy access cookie is cleared once the SDK session is written');
        const at = set.match(/ov_token=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `ov_token=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
        // media-hub_at is read as the session until the SDK writes its own: nobody is signed out by the move.
        const legacy = await t.get('/auth/me', { cookie: `media-hub_at=${t.network.userToken(user)}` });
        assert.strictEqual(legacy.json().user.username, 'kim');
    });

    await check('a lost flow or a used code recovers once, then shows the page (never a bare line)', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieHeader(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        // A lost flow (no state cookie) starts the sign-in again by itself instead of failing.
        const lost = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`);
        assert.strictEqual(lost.status, 302);
        assert.strictEqual(lost.headers.get('location'), '/auth/login');
        assert.match(lost.headers.get('set-cookie'), /ov_oauth_retry=1/);
        // A second failure shows the page.
        const again = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: 'ov_oauth_retry=1' });
        assert.strictEqual(again.status, 400);
        assert.match(again.text, /Sign-in didn&#39;t finish|Sign-in didn't finish/);
        assert.match(again.text, /Try again/);
        // A verifier that does not match is a used/bad code: the same one recovery.
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        const mismatch = await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(mismatch.status, 302, 'a code the Network refuses starts the sign-in once more');
        const mismatchAgain = await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: `${flowCookie}; ov_oauth_retry=1` });
        assert.strictEqual(mismatchAgain.status, 400, 'the second failure shows the page');
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        const nextCookie = r.headers.getSetCookie().find((c) => c.startsWith('ov_oauth_next='));
        assert.ok(!nextCookie || /^ov_oauth_next=;/.test(nextCookie), 'nothing off-site is remembered as next');
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.searchParams.get('client_id'), 'media-hub');
    });

    await check('readiness is truthful: db and the OAuth client required; JWKS and Valkey optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.required, true);
        assert.ok('valkey' in b.checks, 'the optional Valkey check is listed');
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'media-hub');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript (noscript nav, SSR footer)', async () => {
        for (const p of ['/', '/updates']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript><nav/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
    });

    await check('the API answers /ping and unknown routes are problem+json 404', async () => {
        const ping = await t.get('/api/v1/ping');
        assert.strictEqual(ping.status, 200);
        assert.deepStrictEqual(ping.json(), { ok: true, service: 'media-hub' });
        const gone = await t.get('/api/v1/nope');
        assert.strictEqual(gone.status, 404);
        assert.match(gone.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(gone.json().code, 'route.not_found');
    });

    await t.close();
    done();
})();
