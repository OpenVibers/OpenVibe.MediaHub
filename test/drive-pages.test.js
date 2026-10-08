'use strict';
/**
 * The drive's pages: what a guest, a person and staff see, folder navigation, the usage bar, the upload form and
 * the one script on any page — and that everything a person typed is escaped everywhere it is shown.
 *
 * Nothing here needs JavaScript: the pages are server-rendered and the forms are plain POSTs.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');

    await check('a guest gets a sign-in page for every file page, never a file', async () => {
        for (const p of ['/files', '/files/fil_01JABCDEFGHJKMNPQRSTVWXYZ0', '/staff', '/s/abcdefghijklmnopqrstuvwx']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 401, p);
            assert.ok(r.text.includes('Sign in'), `${p}: a sign-in page`);
            assert.ok(r.text.includes('/auth/login?next='), `${p}: with a way to sign in`);
            assert.ok(!r.text.includes('<progress'), `${p}: and nothing of the drive`);
        }
        // The home page and the safety rules are public: they are how somebody decides to sign up at all.
        assert.strictEqual((await t.get('/')).status, 200);
        assert.strictEqual((await t.get('/safety')).status, 200);
    });

    await check('the home page says what this is, the rules, and that everything needs an account', async () => {
        const home = await t.get('/');
        assert.ok(home.text.includes('private drive'), 'it says what it is');
        assert.ok(home.text.includes('no anonymous upload'), 'and that nothing is anonymous');
        assert.ok(home.text.includes('Sign in with OpenVibe'), 'a way in');
        assert.ok(home.text.includes('/safety'), 'a link to the rules');
        const safety = await t.get('/safety');
        assert.ok(safety.text.includes('abuse@openvibe.network'), 'the abuse contact');
        assert.ok(safety.text.includes('dmca@openvibe.network'), 'the copyright contact');
        assert.ok(safety.text.includes('child sexual'), 'what is not allowed, said plainly');
        assert.ok(safety.text.includes('malware'), 'and the rest of it');
        assert.ok(/3 distinct reports|three/i.test(safety.text), 'how reports work');
    });

    await check('the drive shows the usage bar, the upload form and the one page script', async () => {
        const r = await t.get('/files', { as: kim });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<progress id="usage"'), 'the usage bar is a progress element');
        assert.ok(r.text.includes('2.0 GB'), 'the quota from the environment');
        assert.ok(r.text.includes('action="/files/upload"'), 'the upload form');
        assert.ok(r.text.includes('enctype="multipart/form-data"'), 'which is a plain file form');
        assert.ok(r.text.includes('data-upload'), 'that the script upgrades');
        assert.ok(r.text.includes('/js/upload.js?v='), 'and the script itself');
        assert.ok(r.text.includes('<noscript>'), 'the frame\'s no-JavaScript navigation is still there');
        // Signed-in pages are never cached by anything shared.
        assert.match(r.headers.get('cache-control'), /private/);
    });

    await check('folders: made from the form, browsed, and never two of the same name in one place', async () => {
        const made = await t.get('/folders', { as: kim, form: { name: 'Taxes 2026' }, headers: SAME });
        assert.strictEqual(made.status, 303);
        const folder = (await t.get('/api/v1/folders', { as: kim })).json().folders.find((f) => f.name === 'Taxes 2026');
        assert.ok(folder, 'the folder exists');

        const twice = await t.get('/folders', { as: kim, form: { name: 'taxes 2026' }, headers: SAME });
        assert.strictEqual(twice.status, 409);
        assert.ok(twice.text.includes('already have a folder called'), twice.text.slice(0, 300));

        const file = (await upload(t, kim, bytes(80, 'taxes'), { name: 'return.pdf', contentType: 'application/pdf', folder: folder.id })).json().file;
        const inside = await t.get(`/files?folder=${folder.id}`, { as: kim });
        assert.ok(inside.text.includes('return.pdf'), 'the file is in the folder');
        assert.ok(inside.text.includes('Taxes 2026'), 'and the page is the folder');
        const root = await t.get('/files', { as: kim });
        assert.ok(!root.text.includes('return.pdf'), 'and not in the root');
        assert.ok(root.text.includes('Taxes 2026'), 'where the folder is listed');
        assert.strictEqual((await t.get(`/files/${file.id}`, { as: kim })).status, 200);
    });

    await check('everything a person typed is escaped, everywhere it is shown', async () => {
        const nastyName = '<script>alert("x")</script>.txt';
        const nastyFolder = '<img src=x onerror="alert(1)">';
        const folder = (await t.get('/api/v1/folders', { as: kim, headers: SAME, json: { name: nastyFolder } })).json().folder;
        const file = (await upload(t, kim, bytes(50, 'nasty'), { name: nastyName, contentType: 'text/plain', folder: folder.id })).json().file;
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        // Reported once, so the share (and with it the typed name) is in the staff queue too.
        const reporter = t.network.addUser('nia');
        await t.get(`/s/${slug}/report`, { as: reporter, form: { reason: 'malware', note: '<b>not bold</b>' }, headers: SAME });

        for (const [where, path, as] of [
            ['the drive', `/files?folder=${folder.id}`, kim],
            ['the file page', `/files/${file.id}`, kim],
            ['the share page', `/s/${slug}`, sam],
            ['the report queue', '/staff', t.network.addUser('root', { role: 'admin' })],
        ]) {
            const r = await t.get(path, { as });
            assert.strictEqual(r.status, 200, `${where}: ${r.text.slice(0, 200)}`);
            assert.ok(!r.text.includes(nastyName), `${where} renders the file name raw`);
            assert.ok(!r.text.includes(nastyFolder), `${where} renders the folder name raw`);
            assert.ok(r.text.includes('&lt;script&gt;') || r.text.includes('&lt;img src=x'), `${where} does not show it at all`);
        }

        // A report note is text somebody typed, and it is escaped where staff read it.
        const queue = await t.get('/staff', { as: t.network.addUser('mod', { role: 'global_mod' }) });
        assert.ok(queue.text.includes('&lt;b&gt;not bold&lt;/b&gt;'), 'the note is escaped in the queue');
        assert.ok(!queue.text.includes('<b>not bold</b>'), 'and not rendered as markup');
    });

    await check('a person\'s own share link is listed with its state, and staff see who shared it', async () => {
        const file = (await upload(t, kim, bytes(40, 'listed'), { name: 'listed.bin' })).json().file;
        const slug = (await share(t, kim, { file_id: file.id, hours: 1 })).json().share.slug;
        const page = await t.get(`/files/${file.id}`, { as: kim });
        assert.ok(page.text.includes(`/s/${slug}`), 'the file page lists its link');
        assert.ok(/expires <time/.test(page.text), 'with when it expires');
        const drive = await t.get('/files', { as: kim });
        assert.ok(drive.text.includes(`/s/${slug}`), 'and so does the drive');
    });

    await check('the update log and the crawl artifacts still work, and a guest can read the rules', async () => {
        assert.strictEqual((await t.get('/updates')).status, 200);
        const robots = await t.get('/robots.txt');
        for (const d of ['/auth/', '/api/', '/files', '/s/', '/staff']) assert.ok(robots.text.includes(`Disallow: ${d}`), `robots disallows ${d}`);
        assert.ok(!robots.text.includes('Disallow: /safety'), '/safety is not swallowed by the /s/ rule');
        const sitemap = await t.get('/sitemap.xml');
        assert.ok(sitemap.text.includes('https://openvibe.download/safety'), 'the rules are in the sitemap');
        assert.ok(!sitemap.text.includes('/files'), 'and the drive is not');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
