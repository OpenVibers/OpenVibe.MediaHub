'use strict';

/**
 * Who is OpenVibe staff at MediaHub, exactly as at OpenVibe.Help and OpenVibe.Rent: the Network role claim on the
 * person's session (server/auth/sso.js puts `role` on req.viewer; http/principal.js puts it on req.principal). The
 * roles are OpenVibe.Network's (manifests/policy/staff-roles.json): `global_mod` and `admin` may read the report
 * queue and restore or remove what was reported.
 *
 * One place decides staff, so the pages and the API cannot drift apart. Anonymous, an app token and an unlisted
 * role are not staff.
 */
const STAFF_ROLES = ['admin', 'global_mod'];

const roleOf = (who) => (typeof who === 'string' ? who : (who && typeof who.role === 'string' ? who.role : null));

function isStaff(who) {
    if (who && typeof who === 'object' && who.kind && who.kind !== 'user') return false;
    return STAFF_ROLES.includes(roleOf(who));
}

module.exports = { isStaff, STAFF_ROLES };
