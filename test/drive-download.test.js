'use strict';
/**
 * Downloading. This is the highest-risk surface of the service: an upload must never be handed to a browser as if
 * it were a document. Every download is an attachment, with X-Content-Type-Options: nosniff and the real type only
 * for a short safe list — HTML, SVG and anything executable come back as an opaque blob. Nothing is ever inline,
 * and no upload is ever rendered in a page.
 *
 * The bytes are read from OpenVibe.Media through the app, so MediaHub's own headers are what the browser sees
 * whatever Media answers.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, sha256, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');

    const put = async (name, data, contentType) => (await upload(t, kim, data, { name, contentType })).json().file;

    await check('a safe type keeps its own Content-Type; everything else is an opaque blob', async () => {
        const cases = [
            ['photo.png', 'image/png', 'image/png'],
            ['paper.pdf', 'application/pdf', 'application/pdf'],
            ['notes.txt', 'text/plain', 'text/plain'],
            ['bundle.zip', 'application/zip', 'application/zip'],
            ['song.mp3', 'audio/mpeg', 'audio/mpeg'],
            ['clip.mp4', 'video/mp4', 'video/mp4'],
            ['page.html', 'text/html', 'application/octet-stream'],
            ['picture.svg', 'image/svg+xml', 'application/octet-stream'],
            ['feed.xml', 'application/xml', 'application/octet-stream'],
            ['run.sh', 'application/x-sh', 'application/octet-stream'],
            ['no-type', null, 'application/octet-stream'],
        ];
        for (const [name, declared, expected] of cases) {
            const file = await put(name, bytes(64, name), declared);
            const dl = await t.get(`/files/${file.id}/download`, { as: kim });
            assert.strictEqual(dl.status, 200, `${name}: ${dl.text.slice(0, 120)}`);
            assert.ok(dl.headers.get('content-type').startsWith(expected), `${name}: ${dl.headers.get('content-type')} should start with ${expected}`);
            assert.match(dl.headers.get('content-disposition'), /^attachment; filename=/, name);
            assert.ok(!/inline/i.test(dl.headers.get('content-disposition')), `${name} must never be inline`);
            assert.strictEqual(dl.headers.get('x-content-type-options'), 'nosniff', name);
            assert.strictEqual(dl.headers.get('x-robots-tag'), 'noindex', name);
            assert.match(dl.headers.get('cache-control'), /private/, name);
            assert.strictEqual(sha256(dl.buffer), sha256(bytes(64, name)), `${name}: the bytes are the ones uploaded`);
        }
    });

    await check('an uploaded HTML page is never rendered: it comes back as octet-stream, as an attachment', async () => {
        const nasty = Buffer.from('<!doctype html><html><body><script>window.top.location="https://evil.test"</script></body></html>');
        const file = await put('shared.html', nasty, 'text/html');
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;

        const page = await t.get(`/s/${slug}`, { as: sam });
        assert.strictEqual(page.status, 200);
        assert.ok(!page.text.includes('window.top.location'), 'the bytes are not in the page');
        assert.ok(!/<script>window\.top/.test(page.text));

        const dl = await t.get(`/s/${slug}/download`, { as: sam });
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(dl.headers.get('content-type').split(';')[0], 'application/octet-stream');
        assert.strictEqual(dl.headers.get('x-content-type-options'), 'nosniff');
        assert.match(dl.headers.get('content-disposition'), /^attachment/);
        assert.strictEqual(sha256(dl.buffer), sha256(nasty), 'and the bytes are exactly what was uploaded');
    });

    await check('a name full of quotes and newlines cannot break the header', async () => {
        const file = await put('a"; attachment; filename="evil.exe\r\nX-Injected: 1.txt', bytes(20, 'name'), 'text/plain');
        const dl = await t.get(`/files/${file.id}/download`, { as: kim });
        assert.strictEqual(dl.status, 200);
        const dispo = dl.headers.get('content-disposition');
        assert.match(dispo, /^attachment; filename="[^"]*"$/, dispo);
        assert.ok(!dispo.includes('\n') && !dispo.includes('\r'), dispo);
        assert.strictEqual(dl.headers.get('x-injected'), null, 'no header was injected');
    });

    await check('a download resumes: a Range is passed through and answered 206', async () => {
        const data = bytes(4096, 'range');
        const file = await put('slice.bin', data, 'application/octet-stream');
        const part = await t.get(`/files/${file.id}/download`, { as: kim, headers: { range: 'bytes=100-199' } });
        assert.strictEqual(part.status, 206, part.text.slice(0, 120));
        assert.strictEqual(part.buffer.length, 100);
        assert.strictEqual(sha256(part.buffer), sha256(data.subarray(100, 200)));
        assert.strictEqual(part.headers.get('content-range'), 'bytes 100-199/4096');
        assert.strictEqual(part.headers.get('content-disposition'), 'attachment; filename="slice.bin"');
    });

    await check('nothing is served to anybody who is not signed in', async () => {
        const file = await put('guarded.bin', bytes(30, 'guarded'), 'application/octet-stream');
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        for (const p of [`/files/${file.id}/download`, `/s/${slug}/download`]) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 401, p);
            assert.ok(!r.buffer.includes(Buffer.from('guarded')), `${p}: no bytes to a guest`);
        }
    });

    await check('what Media no longer has is a plain 410, not a broken page', async () => {
        const file = await put('gone.bin', bytes(30, 'gone'), 'application/octet-stream');
        t.media.objectOf(file.object.media_object_id).lifecycle_status = 'deleted';
        const r = await t.get(`/files/${file.id}/download`, { as: kim });
        assert.strictEqual(r.status, 410, r.text.slice(0, 120));
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.ok(!r.text.includes('<html'), 'a sentence, not a page');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
