'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const ann = t.network.addUser('ann');
    const bob = t.network.addUser('bob');
    const file = (await upload(t, ann, bytes(300, 'a song'), { name: 'song.mp3', contentType: 'audio/mpeg' })).json().file;
    const form = (extra = {}) => ({ file: file.id, title: 'Our Song', artist: 'Ann', source_kind: 'creator', licence: 'creator_grant', rights_confirmed: 'yes', ...extra });
    let track;

    await check('only an audio file owner can publish with a streaming grant', async () => {
        assert.strictEqual((await t.get('/radio/publish', { as: ann, form: form(), headers: SAME })).status, 303);
        const tracks = (await t.get('/api/v1/radio/tracks')).json().tracks;
        assert.strictEqual(tracks.length, 1);
        track = tracks[0];
        assert.strictEqual(track.licence, 'creator_grant');
        assert.strictEqual(track.source, 'creator');
        assert.strictEqual((await t.get('/radio/publish', { as: bob, form: form(), headers: SAME })).status, 404);
        assert.strictEqual((await t.get('/radio/publish', { as: ann, form: form() })).status, 403);
    });

    await check('licence gate rejects unsupported or unproved sources and labels AI music', async () => {
        const second = (await upload(t, ann, bytes(300, 'another'), { name: 'second.mp3', contentType: 'audio/mpeg' })).json().file;
        const post = (extra) => t.get('/radio/publish', { as: ann, form: { ...form({ file: second.id }), ...extra }, headers: SAME });
        assert.strictEqual((await post({ licence: 'all_rights_reserved' })).status, 422);
        assert.strictEqual((await post({ source_kind: 'creative_commons', licence: 'CC-BY-4.0', source_url: '' })).status, 422);
        assert.strictEqual((await post({ source_kind: 'creative_commons', licence: 'CC-BY-4.0', source_url: 'https://example.org/cc-song' })).status, 422, 'CC attribution records whether it was changed');
        assert.strictEqual((await post({ rights_confirmed: 'no' })).status, 422);
        assert.strictEqual((await post({ source_kind: 'ai' })).status, 303);
        const ai = (await t.get('/api/v1/radio/tracks')).json().tracks.find((x) => x.source === 'ai');
        assert.strictEqual(ai.ai_made, true);
        assert.strictEqual(ai.licence, 'creator_grant');
        const ccFile = (await upload(t, ann, bytes(300, 'cc'), { name: 'cc.ogg', contentType: 'audio/ogg' })).json().file;
        assert.strictEqual((await post({ file: ccFile.id, source_kind: 'creative_commons', licence: 'CC-BY-4.0', source_url: 'https://example.org/cc-song', changes_note: 'none' })).status, 303);
        const cc = (await t.get('/api/v1/radio/tracks')).json().tracks.find((x) => x.licence === 'CC-BY-4.0');
        assert.strictEqual(cc.source_url, 'https://example.org/cc-song');
        assert.strictEqual(cc.changes_note, 'none');
        const pdFile = (await upload(t, ann, bytes(300, 'pd'), { name: 'pd.mp3', contentType: 'audio/mpeg' })).json().file;
        assert.strictEqual((await post({ file: pdFile.id, source_kind: 'public_domain', licence: 'public_domain', source_url: 'https://example.org/archive' })).status, 303);
        const pd = (await t.get('/api/v1/radio/tracks')).json().tracks.find((x) => x.source === 'public_domain');
        assert.strictEqual(pd.source_url, 'https://example.org/archive');
    });

    await check('public audio supports ranges and disappears when unpublished', async () => {
        const path = `/api/v1/radio/tracks/${track.id}/audio`;
        const stream = await t.get(path, { headers: { range: 'bytes=10-19' } });
        assert.strictEqual(stream.status, 206);
        assert.strictEqual(stream.buffer.length, 10);
        assert.match(stream.headers.get('content-type'), /audio\/mpeg/);
        assert.strictEqual((await t.get(`/radio/tracks/${track.id}/unpublish`, { as: bob, form: {}, headers: SAME })).status, 303);
        assert.strictEqual((await t.get(path)).status, 200, 'another user cannot revoke it');
        assert.strictEqual((await t.get(`/radio/tracks/${track.id}/unpublish`, { as: ann, form: {}, headers: SAME })).status, 303);
        assert.strictEqual((await t.get(path)).status, 404);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
