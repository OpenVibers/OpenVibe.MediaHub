'use strict';

/**
 * Resolving the OpenVibe usernames a person names on a share link to canonical subjects, through
 * OpenVibe.Network's identity.subject.resolve (network/identity/internal-routes.js):
 *
 *   GET {OV_NETWORK_INTERNAL_URL}/internal/identity/resolve?system=&type=&id=
 *
 * A service token with audience openvibe.network and scope identity.subject.resolve is required, so it only runs
 * where the OAuth client is configured. Network keys a subject by its id or by a service-local (system, type, id)
 * pair; a username is asked for as type=username, and when Network does not know that key the answer is 404 and the
 * name stays unresolved.
 *
 * That is not a dead end: a share's allow-list holds both the subjects we could resolve and the names as typed, and
 * a download is allowed when the signed-in person's own *subject* is in the resolved list or their Network
 * *username claim* is in the typed one. The claim is signed by Network, so matching on it needs no directory at
 * all — the resolve call only sharpens the list (it survives a rename and reaches guests, who have no username).
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

    /** One username → its subject, or null when Network does not know it (or cannot be asked). */
    async function resolveUsername(username) {
        if (!tokens) return null;
        try {
            const res = await fetchImpl(
                `${config.networkInternalUrl}/internal/identity/resolve?system=network&type=username&id=${encodeURIComponent(username)}`,
                { headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(5000) });
            if (res.status === 401 && tokens.invalidate) tokens.invalidate();
            if (res.status === 404) return null;
            if (!res.ok) {
                log.warn(`[MediaHub] identity.resolve answered ${res.status} for @${username.slice(0, 40)}`);
                return null;
            }
            const data = await res.json().catch(() => null);
            const id = data && data.subject && data.subject.id;
            return typeof id === 'string' && id.startsWith('usr_') ? id : null;
        } catch (err) {
            log.warn('[MediaHub] identity.resolve failed:', (err && err.message) || '');
            return null;
        }
    }

    /**
     * names → { subjects: ['usr_…'], names: ['kim'], unresolved: ['kim'] }.
     * `names` keeps every typed username (matched against the viewer's claim); `unresolved` is what Network could
     * not turn into a subject, which the caller reports back to the owner without refusing the share.
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

    return { configured, resolveUsername, resolveUsernames };
}

module.exports = { createIdentity };
