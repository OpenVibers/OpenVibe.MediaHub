'use strict';
// openvibe.download's home draws its own picture (MOTION-1, 2026-11-02): the drive in miniature (a file, its share
// link, who may open it, when it ends, its downloads, Take back), not the generic aura the showcase draws by default.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the home\'s hero is the drive in miniature, hidden from assistive tech, and no aura', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<div class="dl-scene" aria-hidden="true">/);
            assert.match(r.text, /holiday-cut\.mp4[\s\S]*?Take back/);
            assert.ok(!/sc-aura-glow/.test(r.text), 'no generic aura');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
