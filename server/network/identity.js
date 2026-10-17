'use strict';

/**
 * Resolving the OpenVibe usernames a person names on a share link to canonical subjects, through
 * OpenVibe.Network's identity.subject.resolve (network/identity/internal-routes.js):
 *
 *   GET {OV_NETWORK_INTERNAL_URL}/internal/identity/resolve?username=<name>   (any case; the person's current name)
 *
 * A service token with audience openvibe.network and scope identity.subject.resolve is required, so it only runs
 * where the OAuth client is configured. A name Network does not know (404) is unresolved, and a share naming it is
 * refused: an allow-list holds subjects only. Matching on a typed name would hand the link to whoever registers that
 * name later, or takes it after a rename.
 */
const { serviceAuth } = require('openvibe-contracts');

function createIdentity({ config, fetchImpl = globalThis.fetch, log = console }) {
    const configured = Boolean(config.oauth.clientSecret);
    const tokens = configured ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve',
        fetchImpl,
    }) : null;

    /**
     * One username → { status: 'found', id } | { status: 'unknown' } (Network answered 404) | { status: 'error' } (not
     * configured, or Network could not be asked). Only 'unknown' says nobody has the name.
     */
    async function lookup(username) {
        if (!tokens) return { status: 'error' };
        try {
            const res = await fetchImpl(
                `${config.networkInternalUrl}/internal/identity/resolve?username=${encodeURIComponent(username)}`,
                { headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(5000) });
            if (res.status === 401 && tokens.invalidate) tokens.invalidate();
            if (res.status === 404) return { status: 'unknown' };
            if (!res.ok) {
                log.warn(`[MediaHub] identity.resolve answered ${res.status} for @${username.slice(0, 40)}`);
                return { status: 'error' };
            }
            const data = await res.json().catch(() => null);
            const id = data && data.subject && data.subject.id;
            return typeof id === 'string' && id.startsWith('usr_') ? { status: 'found', id } : { status: 'error' };
        } catch (err) {
            log.warn('[MediaHub] identity.resolve failed:', (err && err.message) || '');
            return { status: 'error' };
        }
    }

    /** One username → its subject, or null when Network does not know it (or cannot be asked). */
    async function resolveUsername(username) {
        const r = await lookup(username);
        return r.status === 'found' ? r.id : null;
    }

    /**
     * names → { subjects: ['usr_…'], names: ['kim'], unresolved: ['kim'] }.
     * `names` keeps every typed username (shown to the owner, never matched); `unresolved` is what Network could not
     * turn into a subject, and the caller refuses a share that names any.
     */
    async function resolveUsernames(list) {
        const names = [];
        const subjects = [];
        const unresolved = [];
        for (const name of list) {
            // Sequential on purpose: a share names a handful of people, and one call each keeps the token client simple.
            const subject = await resolveUsername(name);
            if (subject) subjects.push(subject);
            else unresolved.push(name);
            names.push(name);
        }
        return { subjects: [...new Set(subjects)], names: [...new Set(names)], unresolved };
    }

    return { configured, lookup, resolveUsername, resolveUsernames };
}

module.exports = { createIdentity };
