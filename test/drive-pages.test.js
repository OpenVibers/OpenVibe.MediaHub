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
        for (const p of ['/files', '/files/bin', '/files/fil_01JABCDEFGHJKMNPQRSTVWXYZ0', '/staff', '/s/abcdefghijklmnopqrstuvwx']) {
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

    await check('the home page says what this is, the rules, the free space, and that uploading needs an account', async () => {
        const home = await t.get('/');
        assert.ok(home.text.includes('private drive'), 'it says what it is');
        assert.ok(home.text.includes('Uploading needs a signed-in OpenVibe account'), 'uploads are account-only');
        assert.ok(home.text.includes('25 GB free') && home.text.includes('public download page'), 'the free space and the public links');
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
        // Folders and no loose files: one slim drop line under the folders, never the big empty card or a blank band.
        const lea = t.network.addUser('lea');
        await t.get('/folders', { as: lea, form: { name: 'Photos' }, headers: SAME });
        const only = await t.get('/files', { as: lea });
        assert.ok(only.text.includes('Photos'), 'her folder is listed');
        assert.ok(only.text.includes('class="dr-empty is-slim"') && only.text.includes('No loose files here'), 'with the slim drop line');
        assert.ok(!only.text.includes('Your drive is empty'), 'not the empty-drive card');
    });

    await check('the file page carries one Share button, with the file page\'s own address', async () => {
        const file = (await upload(t, kim, bytes(80, 'shared'), { name: 'shared.txt', contentType: 'text/plain' })).json().file;
        const r = await t.get(`/files/${file.id}`, { as: kim });
        assert.strictEqual(r.status, 200);
        const buttons = r.text.match(/<button[^>]*data-ov-share-sheet[^>]*>/g) || [];
        assert.strictEqual(buttons.length, 1, 'one Share button: ' + buttons.join(' | '));
        assert.ok(buttons[0].includes(`data-url="https://openvibe.download/files/${file.id}"`), buttons[0]);
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

        // The file page's Ask your agent chip (openvibe-shared 4.135.0): the typed name is escaped, and no link is in it.
        const filePage = await t.get(`/files/${file.id}`, { as: kim });
        const asks = filePage.text.match(/<button[^>]*data-ov-ask[^>]*>/g) || [];
        assert.strictEqual(asks.length, 1, 'one Ask your agent chip: ' + asks.join(' | '));
        assert.ok(asks[0].includes('data-ov-ask="About my file “&lt;script&gt;alert(&quot;x&quot;)') && asks[0].includes('” (Document, 50 B): "'), asks[0]);
        assert.ok(!asks[0].includes('<script>'), 'the file name is escaped in the chip');
        assert.ok(!asks[0].includes('http') && !asks[0].includes('/files/'), 'no link to the file in the chip');
        assert.ok(asks[0].includes('class="ovk-ask ovk-btn'), 'the shared kit chip');

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

    await check('full controls: rename, move, search, folders inside folders, and only an empty folder is deleted', async () => {
        const lee = t.network.addUser('lee');
        assert.strictEqual((await t.get('/folders', { as: lee, form: { name: 'Work' }, headers: SAME })).status, 303);
        const work = (await t.get('/api/v1/folders', { as: lee })).json().folders.find((f) => f.name === 'Work');
        // A folder made on a folder's page goes inside it (the form names the folder it is on).
        const madeInside = await t.get('/folders', { as: lee, form: { name: 'Invoices', folder: work.id }, headers: SAME });
        assert.strictEqual(madeInside.status, 303);
        assert.strictEqual(madeInside.headers.get('location'), `/files?folder=${work.id}`);
        const invoices = (await t.get('/api/v1/folders', { as: lee })).json().folders.find((f) => f.name === 'Invoices');
        assert.strictEqual(invoices.parent_id, work.id, 'inside Work');

        const file = (await upload(t, lee, bytes(60, 'draft'), { name: 'draft.txt', contentType: 'text/plain' })).json().file;
        const renamed = await t.get(`/files/${file.id}/rename`, { as: lee, form: { name: 'final.txt', from: 'file' }, headers: SAME });
        assert.strictEqual(renamed.status, 303);
        assert.strictEqual(renamed.headers.get('location'), `/files/${file.id}`);
        assert.ok((await t.get(`/files/${file.id}`, { as: lee })).text.includes('final.txt'), 'the new name shows');
        assert.strictEqual((await t.get(`/files/${file.id}/rename`, { as: lee, form: { name: '   ' }, headers: SAME })).status, 422, 'an empty name is refused');

        const moved = await t.get(`/files/${file.id}/move`, { as: lee, form: { to: invoices.id }, headers: SAME });
        assert.strictEqual(moved.status, 303);
        assert.ok((await t.get(`/files?folder=${invoices.id}`, { as: lee })).text.includes('final.txt'), 'the file is in Invoices');
        assert.ok(!(await t.get('/files', { as: lee })).text.includes('final.txt'), 'and no longer at the top');
        // Somebody else's folder is not a place to move to, and somebody else's file cannot be moved at all.
        assert.strictEqual((await t.get(`/files/${file.id}/move`, { as: lee, form: { to: 'fld_01JABCDEFGHJKMNPQRSTVWXYZ0' }, headers: SAME })).status, 404);
        assert.strictEqual((await t.get(`/files/${file.id}/move`, { as: sam, form: { to: '' }, headers: SAME })).status, 404);

        const found = await t.get('/files?q=fina', { as: lee });
        assert.ok(found.text.includes('final.txt'), 'search finds it in any folder');
        assert.ok(found.text.includes('Work / Invoices'), 'and says where it is');
        assert.ok(!(await t.get('/files?q=100%25', { as: lee })).text.includes('final.txt'), 'a % is a character, not a wildcard');

        const renamedFolder = await t.get(`/folders/${invoices.id}/rename`, { as: lee, form: { name: 'Bills' }, headers: SAME });
        assert.strictEqual(renamedFolder.status, 303);
        assert.ok((await t.get(`/files?folder=${work.id}`, { as: lee })).text.includes('Bills'));

        const notEmpty = await t.get(`/folders/${invoices.id}/delete`, { as: lee, form: {}, headers: SAME });
        assert.strictEqual(notEmpty.status, 409, 'a folder with a file in it stays');
        assert.ok(notEmpty.text.includes('still has files or folders'), notEmpty.text.slice(0, 300));
        await t.get(`/files/${file.id}/delete`, { as: lee, form: {}, headers: SAME });
        const gone = await t.get(`/folders/${invoices.id}/delete`, { as: lee, form: {}, headers: SAME });
        assert.strictEqual(gone.status, 303, 'an empty one goes');
        assert.strictEqual(gone.headers.get('location'), `/files?folder=${work.id}`, 'back to where it was');
        assert.ok(!(await t.get('/api/v1/folders', { as: lee })).json().folders.some((f) => f.id === invoices.id));
    });

    await check('a deleted file waits in the bin, and the drive links it there with a count', async () => {
        const file = (await upload(t, kim, bytes(70, 'bin-page'), { name: 'bin-page.txt', contentType: 'text/plain' })).json().file;
        const page = await t.get(`/files/${file.id}`, { as: kim });
        assert.ok(page.text.includes('goes to the bin for 30 days'), 'the file page says where a delete goes');
        assert.ok(page.text.includes('share links stop working at once'), 'and what happens to its links');
        const deleted = await t.get(`/files/${file.id}/delete`, { as: kim, form: {}, headers: SAME });
        assert.strictEqual(deleted.status, 303);
        assert.strictEqual((await t.get(`/files/${file.id}`, { as: kim })).status, 404);
        const drive = await t.get('/files', { as: kim });
        assert.match(drive.text, /href="\/files\/bin"[^\n]*<em>1<\/em>/, 'the sidebar counts it');
        const bin = await t.get('/files/bin', { as: kim });
        assert.strictEqual(bin.status, 200);
        assert.ok(bin.text.includes('bin-page.txt'), 'the bin lists it');
        assert.ok(bin.text.includes(`action="/files/${file.id}/restore"`) && bin.text.includes(`action="/files/${file.id}/purge"`), 'with Restore and Delete forever');
        assert.ok(bin.text.includes('action="/files/bin/empty"'), 'and a way to empty it');
        await t.get(`/files/${file.id}/restore`, { as: kim, form: {}, headers: SAME });
        assert.strictEqual((await t.get(`/files/${file.id}`, { as: kim })).status, 200, 'restored to the drive');
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
