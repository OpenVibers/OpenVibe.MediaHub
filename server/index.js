'use strict';

/**
 * OpenVibe.MediaHub — process entry. `node server/index.js`
 * Listens on PORT (4990) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the JWKS refresher stops and the store closes.
 * Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.MediaHub', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, () => ctx.keys.client.stop(), async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); }, () => ctx.s.close(), ...extra],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.MediaHub] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    // telemetry_samples rows older than 14 days go: a minute after start, then daily (openvibe-sdk/telemetry).
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    // The request collector aggregates in memory and has no timer of its own (openvibe-sdk 0.46 createHttpTelemetry):
    // this tick writes each minute's samples; the stop clears it and flushes once more.
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    ctx.keys.client.start();

    // Subscribe to the two ADR-033 topics at OpenVibe.Events (idempotent; off without MEDIAHUB_EVENTS_URL and
    // MEDIAHUB_EVENTS_SECRET). The consumer itself is mounted in server/app.js.
    const subscriptions = require('./events-consumer').startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '' });
    // New watch pages on openvibe.video reach search engines (server/video/indexnow.js; off without INDEXNOW_KEY).
    const { createVideoIndexNow } = require('./video/indexnow');
    const { createLiveClient } = require('./video/live-client');
    const videoIndexNow = createVideoIndexNow({ config, live: createLiveClient({ config, fetchImpl: ctx.fetchImpl, log: ctx.log }), indexnow: ctx.indexnow, log: ctx.log });
    videoIndexNow.start();
    // OpenVibe.Pics: signed-out pictures nobody has viewed for MEDIAHUB_PICS_ANONYMOUS_IDLE_DAYS go, hourly (only while
    // signed-out uploads are on; account pictures stay until their owner deletes them).
    const timers = [];
    if (config.pics.anonymous) {
        const sweep = setInterval(() => { ctx.pics.sweep().then((n) => { if (n) console.log(`[OpenVibe.Pics] deleted ${n} idle signed-out picture(s)`); }).catch((err) => console.warn('[OpenVibe.Pics] sweep failed:', err && err.message)); }, 3_600_000);
        sweep.unref();
        timers.push(sweep);
    }
    // Drops (uploads without an account) nobody downloaded for MEDIAHUB_DROP_IDLE_DAYS go, hourly, while drops are on.
    if (config.drops.enabled) {
        const dropSweep = setInterval(() => { ctx.drops.sweep().then((n) => { if (n) console.log(`[OpenVibe.Download] deleted ${n} idle drop(s)`); }).catch((err) => console.warn('[OpenVibe.Download] drop sweep failed:', err && err.message)); }, 3_600_000);
        dropSweep.unref();
        timers.push(dropSweep);
    }
    // OpenVibe.Video's AI edit (server/video/ai-edit.js): captions, chapters and a summary for finished uploads.
    if (ctx.videoAi.enabled) {
        const aiTimer = setInterval(() => { ctx.videoAi.sweep().catch((err) => console.warn('[OpenVibe.Video] AI sweep failed:', err && err.message)); }, 3 * 60_000);
        aiTimer.unref();
        timers.push(aiTimer);
    }
    // The AI cut (server/video/cut.js): one edited copy at a time; a cut a restart interrupted is retried once.
    if (ctx.videoCuts.enabled) {
        ctx.videoCuts.recover().catch((err) => console.warn('[OpenVibe.Video] cut recovery failed:', err && err.message));
        const cutTimer = setInterval(() => { ctx.videoCuts.sweep().catch((err) => console.warn('[OpenVibe.Video] cut sweep failed:', err && err.message)); }, 30_000);
        cutTimer.unref();
        timers.push(cutTimer);
    }
    // Public uploads in OpenVibe.Search (server/video/search-index.js; off without MEDIAHUB_SEARCH_URL).
    ctx.videoSearch.start();
    createLifecycle({ server, ctx, timers, extra: [() => videoIndexNow.stop(), () => ctx.videoSearch.stop(), () => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.MediaHub] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
