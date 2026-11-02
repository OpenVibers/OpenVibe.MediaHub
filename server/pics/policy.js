'use strict';

/**
 * OpenVibe.Pics' three policy pages, the ones the site's own promises rest on:
 *
 *   /exif            what happens to a picture's hidden data (server/pics/images.js does the work)
 *   /content-policy  what may be put on the site, and what happens when it is (server/pics/service.js, the staff queue)
 *   /ai-training     what we do with pictures and AI (server/pics/describe.js is the only path to a model)
 *
 * Rules for the words here:
 *   - Every number comes from the service's own configuration (config.pics) or from the rules the code
 *     enforces (the report reasons, the blocklist). Nothing is typed in by hand.
 *   - Every claim is one the code can back. Where the code cannot promise something (the stripping happens
 *     after the file arrives; a promise about AI is not a lock), the page says so.
 *   - The pages are plain HTML from the OpenVibe Kit (openvibe-shared/kit): they work without JavaScript,
 *     they fit a phone, and they wear the site's theme.
 *
 *   policyPage(kind, { cfg, reasons, reasonText }) → { path, title, description, body }
 */
const kit = require('openvibe-shared/kit');
const { formatBytes } = require('../drive/rules');

const PATHS = ['/exif', '/content-policy', '/ai-training'];

const size = (b) => formatBytes(b).replace(/\.0 /, ' ');
const mega = (px) => `${Math.round(px / 1e6)} megapixels`;

/** A paragraph of the page. */
const p = (text) => `<p>${kit.esc(text)}</p>`;
/** A paragraph with a link or two in it (the words are ours; the markup is written by hand). */
const pm = (markup) => `<p>${markup}</p>`;
/** A part of the page: its name, and the body under it. */
const sec = (title, body, note = '') => kit.section({ title, note, body: `<div class="ovp-policy-body">${body}</div>` });
/** The rows of a part, as one list without a frame of its own (the part is the frame). */
const rows = (items) => kit.list(items, { flush: true });

/** The steps of the EXIF page: what happens to a file, in order. */
function exifSteps(cfg) {
    return [
        ['Your browser sends the file', 'It goes to OpenVibe.Pics over HTTPS, whole, with everything inside it. Nobody can strip what they never receive, so the file with its GPS reaches us first.'],
        ['We check what it really is', `It has to decode as a JPEG, PNG, GIF, WebP or AVIF picture, within ${size(cfg.maxImageBytes)} and ${mega(cfg.maxPixels)}. A renamed script, an SVG or a half-written file is refused, and nothing is stored.`],
        ['We make a new picture from it', 'The picture is decoded and saved again in the same format. The EXIF orientation is applied, so a photo taken sideways is shown upright, and the colour profile becomes sRGB. Every metadata block — EXIF with its GPS and camera, XMP, IPTC, comments — is dropped on the way out. The file we keep has none of them.'],
        ['We keep the new picture, not your file', 'The new picture is stored as a private object in OpenVibe.Media, with a 640-pixel thumbnail beside it. Your uploaded file is never stored. One thing of it is kept: a SHA-256 hash, so that a picture which was taken down cannot be uploaded again — even resized or re-compressed.'],
        ['Every other size comes from the new picture', 'The other widths and formats are made from the picture we keep, so they carry no metadata either.'],
    ];
}

/** What we keep about a picture, once the metadata is gone. */
function exifKept() {
    return [
        ['The picture itself', 'The bytes we made from your file, and a 640-pixel thumbnail.'],
        ['What you wrote', 'The title, the description and the alt text, and who wrote them.'],
        ['What the file is', 'Its size, its format, its width and height, and whether it moves.'],
        ['Its hashes', 'The hash of the picture we keep, the hash of your file, and a difference hash used to spot near-copies.'],
        ['When it arrived', 'The time it was uploaded, and when it was last looked at.'],
        ['Who put it here', 'Your OpenVibe account, for a signed-in upload. For a signed-out upload, a keyed hash of the address, used only to count the uploads a day.'],
    ];
}

/** The content policy: what is not allowed, and what the site does about it. The titles are the report reasons the
 *  code itself offers (server/pics/service.js), so the page and the report form always say the same thing. */
function contentRules(reasons, reasonText) {
    const why = {
        child_safety: 'It is hidden the moment it is reported, taken down, and reported to NCMEC\'s CyberTipline.',
        illegal: 'Where you are, or in the United States, where our servers are.',
        copyright: 'A copyright owner sends a notice through the DMCA page, and we take the picture down.',
        sexual: 'Including anyone else\'s private pictures.',
        violence: 'A real threat of harm, or a picture of violence with no other purpose.',
        harassment: 'Targeting a person with abuse, or content that attacks people for who they are.',
        private_info: 'Addresses, phone numbers, documents, number plates: things people did not choose to publish.',
        spam: 'The same picture over and over, adverts dressed as pictures, links to a fraud.',
        other: 'Anything else that breaks the terms: report it, and a person looks at it.',
    };
    return reasons.map((r) => [reasonText[r] || r, why[r] || '']);
}

/**
 * The three pages.
 *
 * @param kind 'exif' | 'content-policy' | 'ai-training'
 * @param ctx { cfg (config.pics), reasons, reasonText } — the service's own numbers and rules
 */
function policyPage(kind, { cfg, reasons = [], reasonText = {} } = {}) {
    if (kind === 'exif') {
        const body = [
            kit.head({
                title: 'What happens to your picture',
                sub: 'The hidden data: the GPS position, the camera, the time it was taken',
                back: { href: '/', label: 'Home' },
            }),
            sec('The short answer', pm('We take it out. Your picture arrives here with its metadata — the GPS position, the camera, the lens, the time it was taken — and we remove all of it before anyone sees the picture. '
                + 'The file you uploaded is not kept: only the picture we make from it, and a hash of your file, so that a picture taken down cannot come back.')),
            sec('Step by step', rows(exifSteps(cfg).map(([title, sub]) => kit.row({ title, sub })))),
            sec('What we keep once the metadata is gone', rows(exifKept().map(([title, sub]) => kit.row({ title, sub })))),
            kit.fold({
                title: 'What we cannot do',
                body: [
                    p('We cannot show you the GPS of a picture you uploaded: we never keep it, so there is nothing left to show. Nor can we put the camera back.'),
                    p('And the stripping happens after your file reaches us — it is not a shield for the moment of upload. If the location matters to you, take it out on your own device before you upload, or keep the picture where the metadata stays on purpose.'),
                ].join(''),
            }),
            kit.notice({ kind: 'info', text: 'This page describes what the code does. A test uploads a JPEG carrying a camera name and a GPS position, and checks that the picture served back has neither.' }),
            sec('The other policies', rows([
                kit.row({ href: '/content-policy', title: 'What you may put here', sub: 'The content policy, and what happens when a rule is broken' }),
                kit.row({ href: '/ai-training', title: 'Pictures and AI', sub: "We don't train AI on your content; here is the one thing that asks a model" }),
                kit.row({ href: '/terms', title: 'Terms of service', sub: 'The rules of the network, in plain language' }),
                kit.row({ href: '/privacy', title: 'Privacy', sub: 'What this service collects, and why' }),
            ])),
        ].join('');
        return {
            path: '/exif',
            title: 'What happens to a picture: the GPS position, the camera, the rest',
            description: 'OpenVibe.Pics removes the metadata from every picture before anyone sees it: the GPS position, the camera, the time it was taken. The file you upload is not kept.',
            body,
        };
    }

    if (kind === 'content-policy') {
        const body = [
            kit.head({
                title: 'What you may put here',
                sub: 'The content policy, and what happens when a rule is broken',
                back: { href: '/', label: 'Home' },
            }),
            sec('The short answer', pm('OpenVibe.Pics is a link, not a gallery. A picture is reachable by anyone who has its link and by nobody else, so what you put here is what you are willing to share with the people you send it to. '
                + 'Most of the site works without an account, and nothing you upload is listed, ranked or shown to a search engine.')),
            sec('Not allowed here', rows(contentRules(reasons, reasonText).map(([title, sub]) => kit.row({ title, sub }))), 'These are the reasons a picture can be reported for. Each one is a rule, not a suggestion.'),
            sec('How a rule is enforced', rows([
                kit.row({ title: 'Every picture has a report form', sub: 'Whoever has the link can report it with one of the reasons above. One report per person, so a single reader cannot hide a picture on their own.' }),
                kit.row({ title: 'A child-safety report hides the picture at once', sub: 'It stops being visible to everyone but its owner and staff, while people look at it.' }),
                kit.row({ title: `${cfg.reportsToHide} reports hide a picture`, sub: 'Reports from different people count together. A hidden picture is not found by anybody but its owner and staff.' }),
                kit.row({ title: 'Staff decide what happens next', sub: 'They can show it again, keep it hidden, or take it down. A taken-down picture has its bytes deleted and its hashes put on a blocklist, so the same picture — or a resized, re-compressed copy of it — cannot be uploaded again.' }),
                kit.row({ title: 'You can delete your own, at any time', sub: 'Every picture you own has a delete button, and an album can be deleted in one action. The picture is gone from this site; copies other sites already loaded can show for up to ten minutes.' }),
            ])),
            sec('What this site does not do', rows([
                kit.row({ title: 'No feed to scroll', sub: 'There is no list of other people\'s pictures, no ranking, and no gallery of what was uploaded today.' }),
                kit.row({ title: 'No counts to chase', sub: 'No likes, no followers, no numbers of how a picture is doing. There is nothing to count, because nothing is ranked.' }),
                kit.row({ title: 'No adverts, nothing sold', sub: 'No advertising trackers, and your pictures are not sold or used for anyone else\'s advertising.' }),
                kit.row({ title: 'No app to install', sub: 'Every picture and album opens in a browser, signed in or not. There is no app and no account gate in front of the link.' }),
            ])),
            sec('Copyright and the law', pm('A copyright owner can send a notice through the <a href="/dmca">DMCA page</a>, and we take the picture down. The rules of the network itself are in the <a href="/terms">terms of service</a>; what this service collects is in the <a href="/privacy">privacy policy</a>.')),
            sec('The other policies', rows([
                kit.row({ href: '/exif', title: 'What happens to your picture', sub: 'The metadata: the GPS position, the camera, the time it was taken' }),
                kit.row({ href: '/ai-training', title: 'Pictures and AI', sub: "We don't train AI on your content; here is the one thing that asks a model" }),
            ])),
        ].join('');
        return {
            path: '/content-policy',
            title: 'What you may put on OpenVibe.Pics',
            description: 'The content policy for OpenVibe.Pics: what is not allowed, how a rule is enforced, and what this site does not do.',
            body,
        };
    }

    if (kind === 'ai-training') {
        const body = [
            kit.head({
                title: 'Pictures and AI',
                sub: "We don't train AI on your content",
                back: { href: '/', label: 'Home' },
            }),
            sec('The short answer', pm("We don't train AI on your content. If that ever changes, it'll be your choice, and it starts off. Nothing about it is sold. "
                + 'There is exactly one thing on this site that asks a model about a picture, and it only happens when you ask for it.')),
            sec('The one path to a model', rows([
                kit.row({ title: 'You press “Write alt text with AI”', sub: 'On a picture you own, that sends the picture’s 640-pixel thumbnail to OpenVibe.AI, which may hand it to an outside model provider, and writes back alt text, a caption and a few tags. The draft is marked as AI’s until you change it.' }),
                kit.row({ title: 'The run keeps a hash, not the picture', sub: 'OpenVibe.AI’s run for a picture is not shared between callers, and keeps only the picture’s hash, not the picture (cache_mode none).' }),
                kit.row({ title: `At most ${cfg.aiPerDay} drafts a day`, sub: 'OpenVibe.Pics asks OpenVibe.AI for no more than this many drafts a day for the whole site.' }),
                kit.row({ title: 'Nothing else calls a model', sub: 'Storing, serving, resizing, converting and deleting a picture are all done by this service itself.' }),
            ])),
            kit.fold({
                title: 'A promise, not a lock',
                body: [
                    p('This is a promise about what we do, not a lock on what anybody else can do. Anyone who can see your picture can copy it, and a copy can end up in a training set somewhere else — no host can prevent that, and pretending otherwise would be dishonest.'),
                    p('What we can offer is the plain part: we keep no metadata, so a copy of your picture carries no camera, no GPS and no time. The picture itself is reachable only by the link you share, and you can delete it at any time.'),
                    pm('A host that keeps EXIF on purpose, and a host that offers a “do not train on this” tag, are different promises. We do not offer that tag yet; this page is what we can stand behind today. See also the <a href="/exif">metadata page</a>.'),
                ].join(''),
            }),
            sec('What we do with a picture otherwise', rows([
                kit.row({ title: 'We store it and serve it', sub: 'As a private object in OpenVibe.Media, and to the people who have the link.' }),
                kit.row({ title: 'We show it where it is meant to go', sub: 'A picture embedded in a forum post, a chat message or a page of your own loads from this host, as the file itself.' }),
                kit.row({ title: 'We delete it when you delete it', sub: 'Your pictures have a delete button, and an album can be deleted in one action.' }),
                kit.row({ title: 'We do not profile you', sub: 'No adverts, no advertising trackers, and no data about your pictures is sold.' }),
            ])),
            sec('The other policies', rows([
                kit.row({ href: '/exif', title: 'What happens to your picture', sub: 'The metadata: the GPS position, the camera, the time it was taken' }),
                kit.row({ href: '/content-policy', title: 'What you may put here', sub: 'The content policy, and what happens when a rule is broken' }),
                kit.row({ href: '/privacy', title: 'Privacy', sub: 'What this service collects, and why' }),
            ])),
        ].join('');
        return {
            path: '/ai-training',
            title: 'Pictures and AI on OpenVibe.Pics',
            description: 'OpenVibe.Pics does not train AI models on the pictures you upload. The one thing that asks a model about a picture is the alt text you can ask for, and it keeps a hash, not the picture.',
            body,
        };
    }

    return null;
}

module.exports = { PATHS, policyPage };
