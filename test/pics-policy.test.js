'use strict';

/**
 * OpenVibe.Pics' policy pages (server/pics/policy.js): what happens to a picture's hidden data (/exif), what may be
 * put on the site (/content-policy), and what we do with pictures and AI (/ai-training). They are built from the
 * service's own configuration and from the rules the code enforces, so a number on a page is the configured one —
 * this file boots the service with other limits and checks that the page follows them.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

/** The same client as pics.test.js: a request with a Host header (Node's fetch drops one). */
function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const text = buf.toString('utf8');
                resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] || null }, text, buffer: buf, json() { return JSON.parse(text); } });
            });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

const PICS = { Host: 'openvibe.pics' };
const PAGES = ['/exif', '/content-policy', '/ai-training'];

(async () => {
    const t0 = await boot();
    const t = { ...t0, get: hostClient(t0) };
    try {
        await check('the three policy pages answer, are for search engines, and load the kit', async () => {
            for (const path of PAGES) {
                const page = await t.get(path, { headers: PICS });
                assert.strictEqual(page.status, 200, path);
                assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), `${path} is indexable`);
                assert.ok(page.text.includes('/shared/kit.css'), `${path} wears the kit`);
                assert.ok(page.text.includes('/shared/kit-web.js'), `${path} has the kit's behaviour`);
                assert.ok(page.text.includes('class="ovk-head'), `${path} starts with the kit's head`);
                assert.ok(page.text.includes('class="ovk-list'), `${path} has the kit's lists`);
                assert.strictEqual((page.text.match(/<h1[\s>]/g) || []).length, 1, `${path} has one heading`);
            }
        });

        await check('the EXIF page says what happens to the metadata, and what we cannot do', async () => {
            const page = (await t.get('/exif', { headers: PICS })).text;
            assert.ok(page.includes('the GPS position'), 'it names the GPS position');
            assert.ok(page.includes('Your uploaded file is never stored'), 'the file itself is not kept');
            assert.ok(page.includes('The file we keep has none of them'), 'the metadata is dropped');
            assert.ok(page.includes('not a shield for the moment of upload'), 'it says the stripping happens after the upload');
            assert.ok(page.includes('What we cannot do'), 'the fold says what it cannot do');
            assert.ok(page.includes('OpenVibe.Media'), 'it names where the bytes live');
            assert.ok(page.includes('/content-policy') && page.includes('/ai-training'), 'it links the other policies');
        });

        await check('the content policy lists the report reasons the code offers, and the configured number of reports', async () => {
            const page = (await t.get('/content-policy', { headers: PICS })).text;
            for (const reason of ['Child sexual abuse or exploitation', 'Other illegal content', 'Copyright infringement', 'Sexual content shared without consent', 'Graphic violence or threats', 'Harassment or hate', 'private information', 'Spam or a scam']) {
                assert.ok(page.includes(reason), `the page says: ${reason}`);
            }
            assert.ok(page.includes(`${t.config.pics.reportsToHide} reports hide a picture`), 'the number of reports is the configured one');
            assert.ok(page.includes('No feed to scroll'), 'it says there is no feed');
            assert.ok(page.includes('No counts to chase'), 'it says there are no counts');
            assert.ok(page.includes('/dmca'), 'it points at the DMCA page');
        });

        await check('the AI page says we do not train, and that a promise is not a lock', async () => {
            const page = (await t.get('/ai-training', { headers: PICS })).text;
            assert.ok(page.includes('We do not train AI models on the pictures people upload here'), 'the stance is stated');
            assert.ok(page.includes('A promise, not a lock'), 'it says a promise is not a lock');
            assert.ok(page.includes('Write alt text with AI'), 'it names the one path to a model');
            assert.ok(page.includes(`At most ${t.config.pics.aiPerDay} drafts a day`), 'the cap is the configured one');
            assert.ok(page.includes('cache_mode none'), 'it says the run keeps a hash, not the picture');
        });

        await check('the home says in one line what happens to the metadata, and links the three policies', async () => {
            const home = (await t.get('/', { headers: PICS })).text;
            assert.ok(home.includes('The hidden data is removed by us'), 'the home says who removes the metadata');
            assert.ok(home.includes('href="/exif"'), 'and links the page that explains it');
            for (const path of PAGES) assert.ok(home.includes(`href="${path}"`), `the home links ${path}`);
            assert.ok(home.includes('no counts to chase'), 'the home says why there is no feed');
            // The line sits under the upload, not above it: the page's main job comes first.
            assert.ok(home.indexOf('data-pics-upload') < home.indexOf('The hidden data is removed by us'), 'the upload comes first');
            assert.ok(home.indexOf('The hidden data is removed by us') < home.indexOf('>How it works</h2>'), 'and the line before the rest');
        });

        await check('the policies are in the sitemap and in llms.txt, and not blocked for crawlers', async () => {
            const map = (await t.get('/sitemap.xml', { headers: PICS })).text;
            for (const path of PAGES) assert.ok(map.includes(`<loc>https://openvibe.pics${path}</loc>`), `the sitemap lists ${path}`);
            const llms = (await t.get('/llms.txt', { headers: PICS })).text;
            for (const path of PAGES) assert.ok(llms.includes(`https://openvibe.pics${path}`), `llms.txt names ${path}`);
            const robots = (await t.get('/robots.txt', { headers: PICS })).text;
            for (const path of PAGES) assert.ok(!robots.includes(`Disallow: ${path}`), `robots.txt does not block ${path}`);
        });

        await check('a signed-in person sees the same policy pages', async () => {
            const kim = t.network.addUser('kim');
            for (const path of PAGES) {
                const page = await t.get(path, { headers: PICS, as: kim });
                assert.strictEqual(page.status, 200, path);
                assert.ok(page.text.includes('class="ovk-head'), `${path} is the same page`);
            }
        });
    } finally { await t0.close(); }

    // ── The numbers on the pages are the configured ones ──
    const t10 = await boot({ env: { MEDIAHUB_PICS_MAX_IMAGE_BYTES: '3145728', MEDIAHUB_PICS_REPORTS_TO_HIDE: '7', MEDIAHUB_PICS_AI_PER_DAY: '42' } });
    const t2 = { ...t10, get: hostClient(t10) };
    try {
        await check('a limit on a policy page is the configured one, not a number typed in', async () => {
            const exif = (await t2.get('/exif', { headers: PICS })).text;
            assert.ok(exif.includes('3 MB'), 'the largest picture is the configured one');
            assert.ok(!exif.includes('20 MB'), 'and not the default');
            const content = (await t2.get('/content-policy', { headers: PICS })).text;
            assert.ok(content.includes('7 reports hide a picture'), 'the reports that hide a picture are the configured ones');
            const ai = (await t2.get('/ai-training', { headers: PICS })).text;
            assert.ok(ai.includes('At most 42 drafts a day'), 'the daily drafts are the configured ones');
        });
    } finally { await t10.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
