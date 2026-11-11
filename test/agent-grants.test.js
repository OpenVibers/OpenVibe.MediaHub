'use strict';

/** Per-file agent access: an owner grants one agent a bounded read, range reads stream from Media, and revocation wins. */
const assert = require('assert');
const crypto = require('crypto');
const { ids, serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { bytes, upload, SAME } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('owner');
    const fileBytes = bytes(512, 'granted file');
    const file = (await upload(t, owner, fileBytes, { name: 'agent-input.bin' })).json().file;
    const agentSubject = `agent:${ids.newId('agent')}`;
    const projectId = ids.newId('project');
    const hostId = ids.newId('app');
    const tokenFor = (caps) => serviceAuth.signServiceToken({
        iss: t.network.url, sub: agentSubject, actor_type: 'agent', aud: ['openvibe.download'],
        project_id: projectId, env: 'production', ns: [projectId], on_behalf_of: owner.subject, act: { sub: `app:${hostId}` },
        cap: caps, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, t.network.privatePem);
    const agentBearer = tokenFor(['download.file.read']);

    await check('a capability alone cannot list or read the owner drive', async () => {
        assert.strictEqual((await t.get('/api/v1/files', { bearer: agentBearer })).status, 403);
        assert.strictEqual((await t.get(`/api/v1/agent/files/${file.id}/content`, { bearer: agentBearer })).status, 404);
    });

    await check('the owner grants a single file, range reads work, and revocation takes effect', async () => {
        const created = await t.get('/api/v1/agent-grants', {
            as: owner, headers: SAME, json: { file_id: file.id, agent_subject: agentSubject, hours: 24 },
        });
        assert.strictEqual(created.status, 201, created.text);
        const grant = created.json().grant;
        assert.strictEqual(grant.agent_subject, agentSubject);
        assert.strictEqual(grant.file_id, file.id);

        const range = await t.get(`/api/v1/agent/files/${file.id}/content`, {
            bearer: agentBearer, headers: { range: 'bytes=8-23' },
        });
        assert.strictEqual(range.status, 206, `${range.text}\n${t.logs()}`);
        assert.deepStrictEqual(range.buffer, fileBytes.subarray(8, 24));
        assert.strictEqual(range.headers.get('content-range'), `bytes 8-23/${fileBytes.length}`);

        const list = await t.get('/api/v1/agent-grants', { as: owner });
        assert.ok(list.json().grants.some((g) => g.id === grant.id));
        assert.strictEqual((await t.get(`/api/v1/agent-grants/${grant.id}`, { as: owner, method: 'DELETE', headers: SAME })).status, 204);
        assert.strictEqual((await t.get(`/api/v1/agent/files/${file.id}/content`, { bearer: agentBearer })).status, 404);
    });

    await check('a non-owner cannot grant access to another person\'s file', async () => {
        const stranger = t.network.addUser('stranger');
        const r = await t.get('/api/v1/agent-grants', {
            as: stranger, headers: SAME, json: { file_id: file.id, agent_subject: agentSubject },
        });
        assert.strictEqual(r.status, 404);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
