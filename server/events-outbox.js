'use strict';

/**
 * MediaHub's own events (contracts 0.196.0), written to event_outbox (migration 0016) in the change's own transaction
 * and sent to OpenVibe.Events by the SDK relay with MediaHub's service token (events.event.publish). The source is
 * `media-hub` and the namespace `mediahub.*` (an event type has no hyphen; Events#91).
 *
 *   mediahub.video.published   a person's upload is public and ready for the first time (public)
 *   mediahub.picture.uploaded  a signed-in person's picture on OpenVibe.Pics (internal: no link, no title)
 *
 * The relay is off (rows wait) without MEDIAHUB_EVENTS_URL/EVENTS_URL and the OAuth client secret.
 */
const contracts = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');

const EVENT_TYPES = ['mediahub.video.published', 'mediahub.picture.uploaded'];
const subjectOf = (owner) => String(owner || '').replace(/^user:/, '');

function createEventsOutbox({ s, config, log = console, fetchImpl = null }) {
    const out = createServiceOutbox({
        db: s.db, source: 'media-hub',
        eventsUrl: config.events.url || null, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        log, eventTypes: EVENT_TYPES, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        validate: (env) => {
            const e = contracts.validate('events.event-envelope@1', env);
            if (!e.valid) return e;
            return contracts.validate(`${env.event_type}@${env.version}`, env.payload);
        },
    });
    const videoUrl = String(config.video.url).replace(/\/+$/, '');

    return {
        EVENT_TYPES,
        /** Inside the transaction that stores the picture; signed-out pictures emit nothing. */
        async pictureUploaded(row) {
            const owner = subjectOf(row.owner);
            if (!/^usr_/.test(owner)) return null;
            return await out.emit({
                event_type: 'mediahub.picture.uploaded', version: 1,
                actor: { type: 'user', id: owner }, subject: { type: 'picture', id: row.id }, visibility: 'internal',
                payload: { picture: row.id, owner: { type: 'user', id: owner }, uploaded_at: row.created_at },
            });
        },
        /** Inside the transaction that first makes an upload public and ready. */
        async videoPublished(row, publishedAt) {
            const owner = subjectOf(row.owner);
            if (!/^usr_/.test(owner)) return null;
            return await out.emit({
                event_type: 'mediahub.video.published', version: 1,
                actor: { type: 'user', id: owner }, subject: { type: 'video', id: row.id }, visibility: 'public',
                payload: { upload: row.id, owner: { type: 'user', id: owner }, title: String(row.title || 'Video').slice(0, 120), url: `${videoUrl}/u/${row.id}`, published_at: publishedAt },
            });
        },
        start: () => out.start(),
        stop: () => out.stop(),
        kick: () => out.kick(),
        status: () => out.status(),
    };
}

module.exports = { createEventsOutbox, EVENT_TYPES };
