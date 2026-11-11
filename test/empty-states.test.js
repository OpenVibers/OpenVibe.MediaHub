'use strict';
/** Owner ask 81: the picture, video and file 404s, empty albums, pictures, playlists and sync keys use the kit. */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    const kim = t.network.addUser('media-empty');
    const request = (host, path, { signedIn = false } = {}) => new Promise((resolve, reject) => {
        const target = new URL(t.base);
        const req = http.request({ hostname: target.hostname, port: target.port, path,
            headers: { Host: host, ...(signedIn ? { Cookie: t.signIn(kim) } : {}) } }, (res) => {
            const chunks = [];
            res.on('data', (part) => chunks.push(part));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
    try {
        await check('a picture that does not exist draws the kit empty state', async () => {
            const r = await request('openvibe.pics', '/i/zzzznotapicture');
            assert.strictEqual(r.status, 404);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No picture here'));
            assert.ok(r.text.includes('Upload a picture'));
            assert.match(r.text, /kit\.css/);
        });
        await check('a video that does not exist draws the kit empty state', async () => {
            const r = await request('openvibe.video', '/v/zzzznotavideo');
            assert.strictEqual(r.status, 404);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No page here'));
            assert.ok(r.text.includes('Open OpenVibe.Video'));
            assert.match(r.text, /kit\.css/);
        });
        await check('a person with no album and no sync key draws the kit empty state', async () => {
            const albums = await request('openvibe.pics', '/albums', { signedIn: true });
            assert.strictEqual(albums.status, 200);
            assert.ok(albums.text.includes('class="ovk-empty"'));
            assert.ok(albums.text.includes('No albums yet'));
            assert.ok(albums.text.includes('Create an album'));
            assert.match(albums.text, /kit\.css/);
            const sync = await request('openvibe.download', '/sync', { signedIn: true });
            assert.strictEqual(sync.status, 200);
            assert.ok(sync.text.includes('class="ovk-empty"'));
            assert.ok(sync.text.includes('No sync keys yet'));
            assert.ok(sync.text.includes('Make a sync key'));
            assert.match(sync.text, /kit\.css/);
        });
        await check('a file that does not exist draws the kit empty state', async () => {
            const r = await request('openvibe.download', '/files/zzzznotafile', { signedIn: true });
            assert.strictEqual(r.status, 404);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No such file'));
            assert.match(r.text, /kit\.css/);
        });
    } finally { await t.close(); }
    done();
})();
