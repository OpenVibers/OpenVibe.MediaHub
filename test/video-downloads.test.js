'use strict';
/**
 * Downloads on openvibe.video (server/video/downloads.js; owner, 2026-10-26: "easy and intuitive ways for downloading
 * stuff like the transcripts, chat replay, chapters, etc … a generic download button").
 *
 * - The watch page has a Download button whose menu lists what the item has (video with its size, transcript, chat
 *   replay, chapters, cover picture, details, everything), each in its formats; the panels carry their own links.
 * - Each file: the right type, an attachment named "<title> - <channel> - <date>.<what>.<ext>", noindex.
 *   Transcript TXT/SRT/VTT/JSON; chat TXT/CSV (formula-safe)/JSON with every message, in the recording's own time
 *   (a part of a stream starts later); chapters as YouTube lines (from 0:00), VTT and JSON; details JSON; a .zip of all.
 * - The video is Live's download link (Media's attachment), as the person for their private recording; a private
 *   item is missing to anyone else, its files included.
 */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { boot, check, done } = require('./helpers/boot');
const dl = require('../server/video/downloads');

const usernameOf = (auth) => {
    const tok = String(auth || '').replace(/^Bearer /, '');
    try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).username || null; } catch { return null; }
};

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://media.test/t/')) return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return realFetch(url, opts);
};

function startLive() {
    const transcript = JSON.stringify([{ start: 11, end: 14.5, text: 'What is up, "guys"' }, { start: 20, end: 22, text: 'Bird drama' }]);
    const vods = {
        6026: { id: 6026, stream_id: 2795, title: 'BIRD DRAMA (Part 2)', duration_seconds: 1921, file_size: 570688809, created_at: '2026-10-26 21:05:28',
            stream_started_at: '2026-10-26 20:53:39', stream_ended_at: '2026-10-26 21:37:29', stream_offset_sec: 709, part: 2,
            playback_url: 'https://openvibe.media/v/6026', file_url: 'https://openvibe.media/v/6026', thumbnail_url: 'https://media.test/t/vod-6026.jpg',
            visibility: 'public', username: 'Maticus', display_name: 'Maticus', ai_transcript_json: transcript, stream_category: 'outdoors' },
        6030: { id: 6030, title: 'Kept to myself', duration_seconds: 60, created_at: '2026-10-25 10:00:00', visibility: 'private', username: 'Maticus', display_name: 'Maticus',
            playback_url: 'https://openvibe.media/v/6030', ai_transcript_json: JSON.stringify([{ start: 1, end: 2, text: 'secret' }]) },
    };
    const clips = {
        505: { id: 505, vod_id: 6026, title: 'Clip from stream', start_time: 871.5, duration_seconds: 30, created_at: '2026-10-26 21:20:31', status: 'ready',
            playback_url: 'https://openvibe.media/c/505', visibility: 'public', username: 'goosely', source_streamer_username: 'Maticus', thumbnail_url: 'https://media.test/t/clip-505.jpg' },
    };
    const memories = { 6026: [{ offset_seconds: 30, description: 'Birds at the feeder — heard: "look"' }, { offset_seconds: 900, description: 'A robot drives by' }], 6030: [{ offset_seconds: 5, description: 'Private moment' }] };
    // Chat replay for stream 2795: stream time 709 s + 12 s is 12 s into part 2.
    const at = (sec) => new Date(Date.parse('2026-10-26T20:53:39Z') + sec * 1000).toISOString();
    const messages = [
        { message_type: 'chat', timestamp: at(100), username: 'early', display_name: 'Early', message: 'in part one' },
        { message_type: 'chat', timestamp: at(721), username: 'viewer1', display_name: 'Viewer One', message: 'hello, "world"' },
        { message_type: 'chat', timestamp: at(735), username: 'mallory', display_name: 'Mallory', message: '=HYPERLINK("http://x")' },
        { message_type: 'chat', timestamp: at(740), username: 'gone', message: 'deleted', is_deleted: 1 },
    ];
    const calls = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const who = usernameOf(req.headers.authorization);
        calls.push({ path: url.pathname + url.search, who });
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        let m = /^\/api\/chat\/(\d+)\/replay$/.exec(url.pathname);
        if (m) return json(200, { messages: m[1] === '2795' ? messages : [] });
        if (url.pathname === '/api/streams/2795/history') {
            return json(200, { stream_id: 2795, parts: [{ part: 1, vod_id: 6025, at: 28, end: 708 }, { part: 2, vod_id: 6026, at: 709, end: 1930 }], shapes: [], reconnects: [] });
        }
        m = /^\/api\/(vods|clips)\/(\d+)(\/memories|\/download-url)?$/.exec(url.pathname);
        if (!m) return json(404, { error: 'not found' });
        const item = (m[1] === 'vods' ? vods : clips)[m[2]];
        if (!item || (item.visibility === 'private' && who !== item.username)) return json(404, { error: 'not found' });
        if (m[3] === '/memories') return json(200, { memories: memories[m[2]] || [] });
        if (m[3] === '/download-url') {
            const signed = item.visibility === 'private' ? 'exp=1&sig=s&' : '';
            return json(200, { url: `https://openvibe.media/${m[1] === 'vods' ? 'v' : 'c'}/${m[2]}?${signed}download=1&name=${encodeURIComponent(url.searchParams.get('name'))}` });
        }
        return json(200, m[1] === 'vods' ? { vod: item, clips: [] } : { clip: item });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

/** Files of a .zip (stored or deflated), checked against their CRC. */
function unzip(buf) {
    const out = {};
    let o = 0;
    while (buf.readUInt32LE(o) === 0x04034b50) {
        const method = buf.readUInt16LE(o + 8);
        const crc = buf.readUInt32LE(o + 14);
        const size = buf.readUInt32LE(o + 18);
        const nameLen = buf.readUInt16LE(o + 26);
        const extra = buf.readUInt16LE(o + 28);
        const name = buf.toString('utf8', o + 30, o + 30 + nameLen);
        const body = buf.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + size);
        const data = method === 8 ? zlib.inflateRawSync(body) : body;
        assert.strictEqual(dl.crc32(data), crc, `${name}: CRC`);
        out[name] = data;
        o += 30 + nameLen + extra + size;
    }
    assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'an end of central directory');
    return out;
}

(async () => {
    // Pure pieces.
    await check('names, times and CSV cells', async () => {
        assert.strictEqual(dl.fileBase({ title: 'BIRD DRAMA (Part 2)', display_name: 'Maticus', created_at: '2026-10-26 21:05:28' }, 'vod'), 'BIRD DRAMA (Part 2) - Maticus - 2026-10-26');
        assert.strictEqual(dl.fileBase({ title: 'a/b: "c"?', username: 'x' }, 'clip'), 'a b c - x');
        assert.ok(dl.fileBase({ title: 'w'.repeat(300), display_name: 'M', created_at: '2026-10-26' }, 'vod').length <= 120);
        assert.strictEqual(dl.srtTime(3725.5), '01:02:05,500');
        assert.strictEqual(dl.clockLabel(75), '1:15');
        assert.strictEqual(dl.clockLabel(75, true), '0:01:15');
        assert.strictEqual(dl.csvCell('=SUM(A1)'), "'=SUM(A1)");
        assert.strictEqual(dl.csvCell('a "b", c'), '"a ""b"", c"');
        assert.strictEqual(dl.sizeLabel(570688809), '571 MB');
        assert.strictEqual(dl.disposition('Ünïcode "x".txt'), 'attachment; filename="_n_code _x_.txt"; filename*=UTF-8\'\'%C3%9Cn%C3%AFcode%20%22x%22.txt');
    });

    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url } });
    const maticus = t.network.addUser('Maticus');
    const sam = t.network.addUser('sam');
    // On the video host (its pages answer only there), signed in with `as`.
    const vget = (path, { as } = {}) => new Promise((resolve, reject) => {
        const u = new URL(t.base + path);
        const headers = { Host: 'openvibe.video' };
        if (as) headers.cookie = t.signIn(as);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const text = buffer.toString('utf8');
                resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null }, buffer, text, json: () => JSON.parse(text) });
            });
        });
        req.on('error', reject);
        req.end();
    });
    t.get = vget;
    const base = 'BIRD DRAMA (Part 2) - Maticus - 2026-10-26';
    const named = (res) => decodeURIComponent((/filename\*=UTF-8''(.+)$/.exec(res.headers.get('content-disposition') || '') || [])[1] || '');

    await check('the watch page: a Download menu of what the recording has, and each panel\'s links', async () => {
        const r = await t.get('/v/6026');
        assert.strictEqual(r.status, 200);
        const menu = r.text.slice(r.text.indexOf('<details class="ovv-dl"'), r.text.indexOf('</details>', r.text.indexOf('<details class="ovv-dl"')));
        assert.ok(menu.includes('> Download</summary>'));
        for (const href of ['/v/6026/download/video', '/v/6026/download/transcript.txt', '/v/6026/download/transcript.srt', '/v/6026/download/transcript.vtt',
            '/v/6026/download/transcript.json', '/v/6026/download/chat.txt', '/v/6026/download/chat.csv', '/v/6026/download/chat.json',
            '/v/6026/download/chapters.txt', '/v/6026/download/chapters.vtt', '/v/6026/download/chapters.json', '/v/6026/download/thumbnail',
            '/v/6026/download/info.json', '/v/6026/download/all.zip']) assert.ok(menu.includes(`href="${href}"`), href);
        assert.ok(menu.includes('The whole recording · 571 MB'), 'the video with its size');
        assert.ok(menu.includes('2 lines, written by AI') && menu.includes('2 messages') && menu.includes('2 chapters'), 'what each holds');
        assert.ok(/rel="nofollow"/.test(menu) && /download rel/.test(menu), 'download links, not followed by crawlers');
        // Each tab's own download menu sits in its corner (one quiet icon), with Copy for YouTube on the chapters.
        const panel = (key) => { const i = r.text.indexOf(`data-ovv-tp="${key}"`); return r.text.slice(i, r.text.indexOf('</section>', i)); };
        assert.ok(panel('chat').includes('class="ovv-mini"') && panel('chat').includes('href="/v/6026/download/chat.csv"'), 'the chat panel\'s corner menu');
        assert.ok(panel('transcript').includes('href="/v/6026/download/transcript.srt"'), 'the transcript panel\'s corner menu');
        assert.ok(panel('chapters').includes('data-ovv-copy="/v/6026/download/chapters.txt"') && panel('chapters').includes('href="/v/6026/download/chapters.vtt"'), 'the chapters panel\'s, with Copy for YouTube');
        assert.ok(!r.text.includes('ovv-panel-dl'), 'no line of links under a panel any more');
        // The layout: tabs beside the player, one action row, the stream's parts in About.
        assert.strictEqual((r.text.match(/role="tab"/g) || []).length, 3, 'Chat, Chapters, Transcript');
        assert.ok(r.text.includes('data-ovv-share="https://openvibe.video/v/6026"') && r.text.includes('aria-label="More"'), 'Share and More');
        assert.ok(r.text.includes('<a href="/v/6025">Part 1</a>') && r.text.includes('<b>Part 2 (this one)</b>'), 'the other part of the stream');
        // Chat replay sits in the part's own time: 12 s in, not 721 s.
        assert.ok(r.text.includes('data-ovv-at="12"') && !r.text.includes('in part one'), 'chat in part 2\'s time');
    });

    await check('transcript: TXT, SRT, VTT and JSON', async () => {
        const txt = await t.get('/v/6026/download/transcript.txt');
        assert.strictEqual(txt.status, 200);
        assert.strictEqual(txt.headers.get('content-type'), 'text/plain; charset=utf-8');
        assert.strictEqual(named(txt), `${base}.transcript.txt`);
        assert.ok(/^attachment; filename="BIRD DRAMA \(Part 2\) - Maticus - 2026-10-26.transcript.txt"/.test(txt.headers.get('content-disposition')));
        assert.strictEqual(txt.headers.get('x-robots-tag'), 'noindex');
        assert.ok(txt.text.startsWith('BIRD DRAMA (Part 2)\nMaticus · 2026-10-26 · 32:01\nhttps://openvibe.video/v/6026\nTranscript (AI)\n\n[0:11] What is up, "guys"\n[0:20] Bird drama\n'), txt.text);
        const srt = await t.get('/v/6026/download/transcript.srt');
        assert.strictEqual(srt.headers.get('content-type'), 'application/x-subrip; charset=utf-8');
        assert.strictEqual(srt.text, '1\n00:00:11,000 --> 00:00:14,500\nWhat is up, "guys"\n\n2\n00:00:20,000 --> 00:00:22,000\nBird drama\n');
        const vtt = await t.get('/v/6026/download/transcript.vtt');
        assert.strictEqual(vtt.headers.get('content-type'), 'text/vtt; charset=utf-8');
        assert.ok(vtt.text.startsWith('WEBVTT\n\n00:00:11.000 --> 00:00:14.500\nWhat is up, "guys"\n'), vtt.text.slice(0, 80));
        const json = (await t.get('/v/6026/download/transcript.json')).json();
        assert.deepStrictEqual(json, { recording_id: 6026, title: 'BIRD DRAMA (Part 2)', url: 'https://openvibe.video/v/6026', transcript: [{ start: 11, end: 14.5, text: 'What is up, "guys"' }, { start: 20, end: 22, text: 'Bird drama' }] });
    });

    await check('chat replay: every message in the recording\'s time; CSV is safe for spreadsheets', async () => {
        const txt = await t.get('/v/6026/download/chat.txt');
        assert.ok(txt.text.endsWith('[0:12] Viewer One: hello, "world"\n[0:26] Mallory: =HYPERLINK("http://x")\n'), txt.text);
        assert.ok(!txt.text.includes('deleted') && !txt.text.includes('in part one'));
        const csv = await t.get('/v/6026/download/chat.csv');
        assert.strictEqual(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
        const lines = csv.text.trim().split('\r\n');
        assert.strictEqual(lines[0], 'time,seconds,sent_at,username,display_name,message');
        assert.strictEqual(lines[1], '0:12,12,2026-10-26T21:05:40.000Z,viewer1,Viewer One,"hello, ""world"""');
        assert.strictEqual(lines[2], '0:26,26,2026-10-26T21:05:54.000Z,mallory,Mallory,"\'=HYPERLINK(""http://x"")"');
        const json = (await t.get('/v/6026/download/chat.json')).json();
        assert.deepStrictEqual(json.messages.map((m) => [m.seconds, m.username, m.message]), [[12, 'viewer1', 'hello, "world"'], [26, 'mallory', '=HYPERLINK("http://x")']]);
    });

    await check('chapters: YouTube lines from 0:00, VTT, JSON', async () => {
        const txt = await t.get('/v/6026/download/chapters.txt');
        assert.strictEqual(txt.text, '0:00 Start\n0:30 Birds at the feeder\n15:00 A robot drives by\n');
        const vtt = await t.get('/v/6026/download/chapters.vtt');
        assert.ok(vtt.text.includes('00:00:30.000 --> 00:15:00.000\nBirds at the feeder'), vtt.text);
        const json = (await t.get('/v/6026/download/chapters.json')).json();
        assert.deepStrictEqual(json.chapters, [{ start: 30, end: 900, title: 'Birds at the feeder' }, { start: 900, end: 1921, title: 'A robot drives by' }]);
    });

    await check('details, the cover picture and everything in a .zip', async () => {
        const info = (await t.get('/v/6026/download/info.json')).json();
        assert.strictEqual(info.recording_id, 6026);
        assert.deepStrictEqual(info.stream, { id: 2795, started_at: '2026-10-26 20:53:39', ended_at: '2026-10-26 21:37:29', part: 2, starts_at_second: 709 });
        assert.strictEqual(info.files.video, 'https://openvibe.video/v/6026/download/video');
        assert.strictEqual(info.files['chat.csv'], `${base}.chat.csv`);
        const pic = await t.get('/v/6026/download/thumbnail');
        assert.strictEqual(pic.status, 200);
        assert.strictEqual(pic.headers.get('content-type'), 'image/jpeg');
        assert.strictEqual(named(pic), `${base}.jpg`);
        assert.ok(pic.buffer.equals(JPEG));
        const z = await t.get('/v/6026/download/all.zip');
        assert.strictEqual(z.headers.get('content-type'), 'application/zip');
        assert.strictEqual(named(z), `${base}.zip`);
        const files = unzip(z.buffer);
        assert.deepStrictEqual(Object.keys(files).sort(), [
            'chapters.json', 'chapters.txt', 'chapters.vtt', 'chat.csv', 'chat.json', 'chat.txt', 'info.json', 'jpg',
            'transcript.json', 'transcript.srt', 'transcript.txt', 'transcript.vtt',
        ].map((x) => (x === 'jpg' ? `${base}/${base}.jpg` : `${base}/${base}.${x}`)).sort());
        assert.strictEqual(files[`${base}/${base}.chapters.txt`].toString(), '0:00 Start\n0:30 Birds at the feeder\n15:00 A robot drives by\n');
    });

    await check('the video: Live\'s download link (Media\'s attachment), named', async () => {
        const v = await t.get('/v/6026/download/video');
        assert.strictEqual(v.status, 302);
        assert.strictEqual(v.headers.get('location'), `https://openvibe.media/v/6026?download=1&name=${encodeURIComponent(base)}`);
        assert.strictEqual(v.headers.get('cache-control'), 'private, no-store');
    });

    await check('a clip: its menu and files', async () => {
        const page = await t.get('/c/505');
        assert.ok(page.text.includes('href="/c/505/download/video"') && page.text.includes('href="/c/505/download/all.zip"'));
        assert.ok(!page.text.includes('/c/505/download/transcript.txt'), 'no transcript row without one');
        const info = (await t.get('/c/505/download/info.json')).json();
        assert.deepStrictEqual([info.clip_id, info.recording.id, info.recording.from_second, info.recording.url], [505, 6026, 871.5, 'https://openvibe.video/v/6026']);
        assert.strictEqual((await t.get('/c/505/download/chat.txt')).status, 404, 'no chat file for a clip');
        assert.strictEqual((await t.get('/c/505/download/transcript.txt')).status, 404, 'nothing to transcribe');
        const v = await t.get('/c/505/download/video');
        assert.strictEqual(v.headers.get('location'), `https://openvibe.media/c/505?download=1&name=${encodeURIComponent('Clip from stream - Maticus - 2026-10-26')}`);
    });

    await check('a private recording: its owner downloads it (a signed link), anyone else finds nothing', async () => {
        assert.strictEqual((await t.get('/v/6030/download/transcript.txt')).status, 404);
        assert.strictEqual((await t.get('/v/6030/download/video', { as: sam })).status, 404);
        const mine = await t.get('/v/6030/download/transcript.txt', { as: maticus });
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store');
        assert.ok(mine.text.includes('[0:01] secret'));
        const chs = await t.get('/v/6030/download/chapters.txt', { as: maticus });
        assert.strictEqual(chs.text, '0:00 Start\n0:05 Private moment\n', 'its chapters, read from Live as the owner');
        const v = await t.get('/v/6030/download/video', { as: maticus });
        assert.ok(/^https:\/\/openvibe\.media\/v\/6030\?exp=1&sig=s&download=1/.test(v.headers.get('location')), v.headers.get('location'));
        const page = await t.get('/v/6030', { as: maticus });
        assert.ok(page.text.includes('Private moment'), 'the owner\'s page shows its chapters too');
    });

    await check('an unknown file or id is a 404', async () => {
        assert.strictEqual((await t.get('/v/6026/download/secrets.txt')).status, 404);
        assert.strictEqual((await t.get('/v/6026/download/..%2Fetc')).status, 404);
        assert.strictEqual((await t.get('/v/99999/download/info.json')).status, 404);
    });

    await t.close();
    await live.close();
    done();
})();
