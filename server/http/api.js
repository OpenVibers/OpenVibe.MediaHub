'use strict';

/**
 * /api/v1 — OpenVibe.MediaHub's API.
 *
 *   GET  /ping   public   liveness: { ok: true, service }
 *
 * The product adds its own routes here. Every route that reads or changes a person's data names the capability it
 * needs (`principal.requireCapability('<media-hub>.thing.read')`, listed in CAPABILITIES in ./principal.js) and takes
 * its per-caller numbers (`limits.reads('<media-hub>.thing.read')` or `limits.budget('<name>')`, ./caller-limits.js).
 * A refusal is an RFC 9457 problem+json with a stable code.
 */
const express = require('express');
const { asyncRouter } = require('./router');

function createApi(ctx) {
    const { config, principal, limits } = ctx;
    const r = asyncRouter();

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // The one route the skeleton ships. It is public and counted per caller with the default read numbers.
    r.get('/ping', limits.reads('media-hub.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    return r;
}

module.exports = { createApi };
