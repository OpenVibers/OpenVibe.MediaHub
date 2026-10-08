'use strict';

/**
 * OpenVibe.MediaHub — process entry. `node server/index.js`
 * Listens on PORT (4990) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the JWKS refresher stops and the store closes.
 * Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.MediaHub', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, () => ctx.keys.client.stop(), () => ctx.s.close(), ...extra],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.MediaHub] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.keys.client.start();

    // Subscribe to the two ADR-033 topics at OpenVibe.Events (idempotent; off without MEDIAHUB_EVENTS_URL and
    // MEDIAHUB_EVENTS_SECRET). The consumer itself is mounted in server/app.js.
    const subscriptions = require('./events-consumer').startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '' });
    createLifecycle({ server, ctx, extra: [() => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.MediaHub] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
