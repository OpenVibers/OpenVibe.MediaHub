'use strict';

/**
 * This service's share of a person's account export and deletion (ADR-033), through openvibe-sdk/account-data.
 *
 *   network.account.export_requested   the person's files, folders, shares, reports and upload counts, as JSON
 *   network.account.deleted            the same rows erased, and every Media object they held deleted
 *
 * The events arrive signed on POST /internal/events (loopback only). `apply` is wrapped here for one reason: an
 * erasure has to tell OpenVibe.Media to delete each object, and the object ids only exist *before* the rows are
 * gone — extraErase runs after the tables are erased, so the ids are read on the way in and handed to it.
 *
 * A Media deletion that fails does not fail the erasure: the person's rows are gone here either way, and Media's
 * own retention decides when the bytes go. It is logged, not swallowed silently.
 */
const { createAccountData, createNetworkSender } = require('openvibe-sdk/account-data');
const { parseDelivery } = require('openvibe-sdk/events');

/**
 * The tables that hold a person's own data. `file` names the export file; null leaves a table out of it. Every
 * subject column here stores the requester form (`user:usr_…`), so `value` maps the plain subject Network names.
 */
const AS_REQUESTER = (usr) => `user:${usr}`;
// The order matters: mh_shares and mh_reports cascade from mh_files (the foreign keys), so they are erased first —
// otherwise the rows would be gone by the cascade and the counts would read as nothing was erased.
const TABLES = [
    { table: 'mh_reports', subject: 'reporter', value: AS_REQUESTER, file: 'reports.json' },
    { table: 'mh_shares', subject: 'owner', value: AS_REQUESTER, file: 'shares.json' },
    { table: 'mh_usage', subject: 'owner', value: AS_REQUESTER, file: 'usage.json' },
    { table: 'mh_files', subject: 'owner', value: AS_REQUESTER, file: 'files.json' },
    { table: 'mh_folders', subject: 'owner', value: AS_REQUESTER, file: 'folders.json' },
    // An upload that never finished is this service's own state, not something the person made: it is erased with
    // the account but is not part of the export.
    { table: 'mh_uploads', subject: 'owner', value: AS_REQUESTER, file: null },
];

function createAccount({ db, config, media, log = console }) {
    /** The object ids of a deletion, read before the rows go (extraErase runs after them). */
    let pendingObjects = [];

    const accountData = createAccountData({
        db,
        service: 'media-hub',
        tables: TABLES,
        note: 'OpenVibe.MediaHub: your files, folders, share links, the reports you filed and your upload counts. The bytes of your files live in OpenVibe.Media.',
        extraErase: async () => {
            const ids = pendingObjects;
            pendingObjects = [];
            for (const id of ids) {
                const out = await media.remove(id);
                if (!out.ok && out.status !== 404 && out.status !== 410) {
                    log.warn(`[MediaHub] account deletion: Media refused to delete ${id}: ${out.status} ${out.code}`);
                }
            }
        },
        log,
    });

    /** The subjects a deletion names, as this service stores them: the account, and any account merged into it. */
    const subjectsOf = (payload) => [payload.subject, ...(Array.isArray(payload.aliases) ? payload.aliases : [])]
        .filter((x) => typeof x === 'string' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(x))
        .map((x) => `user:${x}`);

    /** One envelope → an outcome (see openvibe-sdk/account-data); throws so Events redelivers. */
    async function apply(ev, { send }) {
        if (ev && ev.event_type === 'network.account.deleted' && ev.source === 'network') {
            const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
            // Read the media objects first: the erase deletes the rows that name them.
            pendingObjects = (await db.many('SELECT object_id FROM mh_files WHERE owner = ANY($1::text[])', [subjectsOf(payload)]))
                .map((r) => r.object_id).filter(Boolean);
        }
        return await accountData.apply(ev, { send });
    }

    /**
     * POST /internal/events — signed with MEDIAHUB_EVENTS_SECRET, loopback only. It is mounted before any body
     * parser because the signature covers the raw bytes.
     */
    function consumer({ send }) {
        const reply = (res, status, body) => {
            res.statusCode = status;
            res.setHeader('Content-Type', status < 300 ? 'application/json' : 'application/problem+json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
        };
        const problem = (res, status, code, detail) => reply(res, status, { type: 'about:blank', title: code, status, code, detail });
        const secrets = (config.events.secrets || []).filter((k) => typeof k === 'string' && k.length >= 32);
        return async function handle(req, res) {
            if (req.method !== 'POST') return problem(res, 405, 'method_not_allowed', 'POST only');
            // Loopback only: a request that came through a proxy is not Network's.
            if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
                return problem(res, 403, 'media-hub.internal_only', 'internal route');
            }
            if (!secrets.length) return problem(res, 503, 'media-hub.events_disabled', 'no events secret is configured');
            const raw = await new Promise((resolve, reject) => {
                const chunks = [];
                let size = 0;
                req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
                req.on('end', () => resolve(Buffer.concat(chunks)));
                req.on('error', reject);
            }).catch(() => null);
            if (!raw) return problem(res, 413, 'request.too_large', 'unreadable or oversized body');
            let delivery = null;
            for (const secret of secrets) { delivery = parseDelivery(raw, req.headers, secret, { requireV2: true }); if (delivery) break; }
            if (!delivery || !delivery.event) return problem(res, 401, 'media-hub.bad_signature', 'X-OpenVibe-Signature-V2 does not verify');
            try {
                const outcome = await apply(delivery.event, { send });
                return reply(res, 200, { event_id: delivery.event.event_id, outcome });
            } catch (err) {
                log.warn(`[MediaHub] ${delivery.event.event_type} failed: ${(err && err.message) || err}`);
                return problem(res, 503, 'media-hub.retry', 'not applied; Events will retry');
            }
        };
    }

    return { accountData, apply, consumer, TABLES };
}

/**
 * The Network sender the account events are answered with (our own client-credentials token). Without the OAuth
 * client there is nothing to sign with: every send answers 503, which the consumer turns into "Events will retry"
 * rather than a crash at boot (a development process has no client secret).
 */
function createSender({ config, fetchImpl }) {
    if (!config.oauth.clientSecret) {
        return async () => ({ ok: false, status: 503, json: async () => ({}) });
    }
    return createNetworkSender({
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        fetch: fetchImpl || globalThis.fetch,
    });
}

module.exports = { createAccount, createSender, TABLES };
