# OpenVibe.MediaHub

> Your files, shared on your terms.

**Status:** alpha. One process serves **openvibe.download** (a private drive with share links and folder backup through
sync keys), **openvibe.video** (uploads and browser recordings with AI captions, chapters and the AI cut, watch pages and
playlists, and OpenVibe.Live's stream recordings and clips) and **openvibe.pics** (picture hosting with resize, convert
and alt text, 2026-10-15), chosen by Host header.
**Port:** 4990 · **Service id:** `media-hub` · **Env prefix:** `MEDIAHUB` · **License:** AGPL-3.0.

## Purpose

OpenVibe.MediaHub is the network's file service: it serves **openvibe.download** as a private drive where a
signed-in person can upload, organise, share and delete their own files. The bytes live in OpenVibe.Media; MediaHub
keeps the metadata, the per-person limits, the share links and the report queue. It also answers OpenVibe.Network's
account export and deletion events (ADR-033). The same process serves **openvibe.video**, the public watch pages for
OpenVibe.Live's stream recordings and clips (OpenVibe.Video v1, step A), and **openvibe.pics**, OpenVibe.Pics (below).

## Owns

The drive's own tables, and it is the authority for them (`migrations/0002_mediahub.sql`; `migrations/0001_initial.sql`
creates none):

- `mh_files` — one row per file the person uploaded, naming its `med_…` object in Media (a soft delete keeps the row
  until the bytes are gone).
- `mh_folders` — the person's folders and their nesting.
- `mh_shares` — the share links: slug, expiry, allow-list, download count, report high-water mark, revocation and
  suspension.
- `mh_reports` — one report per person per share.
- `mh_usage` — the per-person upload count for the UTC day.
- `mh_uploads` — an in-flight chunked upload session (Media's multipart id, the parts expected, the expiry).
- `account_data_events` — the once-per-event record of applied account export and deletion deliveries
  (openvibe-sdk/account-data, ADR-033).
- `video_playlists` and `video_playlist_items` — the person's playlists and their ordered Live items
  (`migrations/0003_video_playlists.sql`); the items cascade from their playlist.
- `pics_images`, `pics_albums`, `pics_album_images`, `pics_reports`, `pics_blocklist`, `pics_usage`
  (`migrations/0006_pics.sql`) — OpenVibe.Pics: each picture (its Media object and thumbnail, size, hashes, state and
  report count; a signed-out upload's delete key only as its sha256), albums and their order, one report per reporter
  per picture, the takedown blocklist (sha256 and difference hashes) and uploads per uploader per day.
- `telemetry_samples` (`migrations/0005_telemetry.sql`) — requests aggregated by route template, method and status class,
  never by raw URL; `/shared`, static assets, health, readiness, `/metrics` not counted; one `http.request` sample per key each
  minute plus active-requests, p95 latency and event-loop-lag gauges (openvibe-sdk 0.46, `platform.telemetry-sample@1`); 14-day
  rows pruned daily. `server/app.js` builds it (`createHttpTelemetry`); `server/index.js` flushes it every minute and on stop.

## Does not own

- The bytes are **OpenVibe.Media**'s: MediaHub stores an object id and asks Media to create, read and delete the
  object; Media's own retention decides when the bytes actually go.
- Identity, usernames and canonical account subjects are **OpenVibe.Network**'s, resolved through Network's
  `identity.subject.resolve`.
- Event delivery, and the account export/deletion topics, are **OpenVibe.Events**': MediaHub only creates its
  subscriptions and consumes the two deliveries.
- **CSAM hash-matching against known material** (PhotoDNA, NCMEC hash lists): that needs the owner's NCMEC / Cloudflare
  CSAM Scanning Tool account. Pics matches only its own takedown blocklist, and child-safety reports hide at once.

## Depends on

- **OpenVibe.Network** — SSO (OAuth 2 with PKCE S256, client id `media-hub`) and its JWKS: `OV_NETWORK_URL`,
  `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `OV_OAUTH_REDIRECT_URI`,
  `MEDIAHUB_AUDIENCE`. It calls `identity.subject.resolve` on the internal URL with a service token of its own.
- **OpenVibe.Media** — where the bytes live: `MEDIAHUB_MEDIA_URL`, `MEDIAHUB_MEDIA_APP`
  (and `MEDIAHUB_MEDIA_TIMEOUT_MS`). Media calls use the service's Network service token. Grant
  `[media-hub, media.object.upload, openvibe.media]` and `[media-hub, media.object.read, openvibe.media]`
  on namespace `media-hub`.
- **OpenVibe.Live** — where the recordings and clips come from. openvibe.video reads Live's public JSON API
  server-side, signed out (`MEDIAHUB_LIVE_URL`, `MEDIAHUB_LIVE_PUBLIC_URL`).
- **OpenVibe.Events** — `MEDIAHUB_EVENTS_URL` (the two subscriptions are created at boot) and
  `MEDIAHUB_EVENTS_SECRET` (the v2 signature on `POST /internal/events`).
- **PostgreSQL** and **Valkey** — `DATABASE_URL` / `DATABASE_DIRECT_URL`, `VALKEY_URL` / `VALKEY_PREFIX`, read
  through openvibe-sdk/db and openvibe-sdk/valkey.
- **Packages** — openvibe-contracts, openvibe-sdk and openvibe-shared (versions below), with express, helmet,
  cookie-parser and express-rate-limit.

## Capabilities

The service manifest (openvibe-contracts, `manifests/services/media-hub.json`) lists ten capabilities it owns —
`video.vod.read`, `video.playlist.read`, `video.playlist.manage`, `pics.image.read`, `pics.image.upload`,
`pics.album.read`, `pics.album.manage`, `download.file.read`, `download.file.upload`, `download.share.create`.
The two playlist capabilities are registered in `server/http/principal.js` and guarded on the video host's API
(see **Playlist API**): `video.playlist.read` lets an app, agent or service list and read the playlists it owns and
any public or unlisted playlist by id, and `video.playlist.manage` lets it create, edit, reorder and delete its own.
Every other `/api/v1` route still requires a signed-in person, never an app, agent or service token.

On other services it calls:

- OpenVibe.Network `identity.subject.resolve` — to turn the usernames a share names into canonical account subjects.
- OpenVibe.Events `events.subscription.manage` — to create its account export/deletion subscriptions at boot.
- OpenVibe.Events `events.event.publish` — its own events, in the namespace `mediahub.*` (an event type has no hyphen):
  `mediahub.video.published` (an upload's first time public and ready: upload, owner, title, url; public; once, by
  `video_uploads.published_at`) and `mediahub.picture.uploaded` (a signed-in person's picture: picture, owner; internal,
  without the link or title; signed-out pictures emit nothing). Written to `event_outbox` (migration 0016) in the
  change's own transaction by [server/events-outbox.js](server/events-outbox.js) and relayed by the SDK; off without
  `MEDIAHUB_EVENTS_URL`/`EVENTS_URL` and the client secret. OpenVibe.Quest credits "Publish a video" and "Share a picture".
- OpenVibe.Search `search.document.write` — OpenVibe.Video's public, ready uploads as Search documents (owner
  `media-hub`, type `video`, `/u/<id>`) through the owner API ([server/video/search-index.js](server/video/search-index.js),
  `MEDIAHUB_SEARCH_URL`; a minute after boot, hourly, and 30 s after an edit; a private, hidden or removed upload is
  tombstoned; `video_search_state`, migration 0013).

## Why v1 is narrow

Public file hosting is the riskiest surface on the network: OpenVibe.Media has no malware or CSAM scanning yet. So
OpenVibe.Download v1 is a **private drive**, not a public host:

- Every upload and every file page needs a signed-in OpenVibe person, or a **sync key** that person made for their own
  backups (below). Apps, agents and anonymous callers cannot upload.
- Files are private to their owner: another person's file id answers 404.
- A share link (`/s/<slug>`, 24 random url-safe characters) expires in 1 hour to 30 days (7 by default), can be revoked,
  counts downloads, and is one of three kinds: for anyone **signed in** with the link (the default), for **named**
  OpenVibe accounts, or **public** (`public: true`, migration `0007_public_shares.sql`; the owner's Q10, MediaFire-style):
  its page and its downloads open for anyone with the link, no account needed. Named accounts are resolved through
  OpenVibe.Network to account subjects, and only subjects are matched, because a username can change hands; a name no
  account has is refused, and a public link cannot also name accounts.
- Every share page has a Report form (malware, illegal content, copyright, something else). Three distinct reports,
  or any report of illegal content, suspend the share at once. Staff (Network role `admin` or `global_mod`) then
  restore it, or remove the file, which also deletes the object in Media.
- Downloads are always attachments, with `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox` and a real `Content-Type` only for a short safe list (images
  except SVG, audio, video, PDF, plain text, zip). HTML, SVG and anything executable come back as
  `application/octet-stream`. The name survives in any script (`filename*=UTF-8''…`) and can never break the header.
- **Previews** (`/files/:id/preview?w=96|640`, and `/s/:slug/preview` for a single-file share):
  - An image (JPEG, PNG, WebP, GIF or AVIF, never SVG) shows a picture of itself in the list (96 px) and on its page
    and share page (640 px).
  - OpenVibe.Media makes it as a signed WebP variant of the private object, and MediaHub passes it through: `nosniff`,
    a sandbox CSP, `private, max-age=300`, never an attachment and never counted as a download.
  - Only the owner gets one, or whoever may open the share. Other files show their extension.
- Per-person limits, all from the environment: 25 GB stored and 2 GB per file (the owner's Q10 for free accounts), 50
  uploads a day, 20 live share links.

## How it works

Bytes live in **OpenVibe.Media** (`MEDIAHUB_MEDIA_URL`, app `media-hub`). MediaHub uses its Network service token and
calls Media server-side only, naming the person with `X-OV-Subject`, and never hands a browser a Media URL:

- **Small files:** the plain form (`POST /files/upload`, no JavaScript needed) streams the file to a temp file with
  its sha256, then into Media. The ceiling is `MEDIAHUB_SINGLE_UPLOAD_BYTES`, 256 MB.
- **Big files:** the page's small script uploads in parts (`/api/v1/uploads/:id/parts/:n`, 8 MB each) that can
  resume after a dropped connection.
- **Downloads:** MediaHub checks access, then streams from Media with its own headers. Range requests pass through,
  so downloads resume.

MediaHub owns the drive: `mh_files`, `mh_folders`, `mh_shares`, `mh_reports`, `mh_usage` (migrations/0002_mediahub.sql).

## OpenVibe.Pics (openvibe.pics)

An open, ad-free picture host: drop a picture, get a link to share or embed. Built in [server/pics/](server/pics/).

- **Upload:** a signed-in person uploads JPEG, PNG, GIF, WebP or AVIF (20 MB, 100 megapixels): the plain form at `/`
  works without JavaScript; [public/js/pics.js](public/js/pics.js) adds drag-and-drop, paste and several files at once
  through the API. Limits: 200 a day, 5 GB a person (`MEDIAHUB_PICS_*`).
- **Every picture is re-encoded** ([server/pics/images.js](server/pics/images.js), sharp/libvips): it must decode as
  one of those formats (a renamed script, an SVG or a truncated file is refused), the EXIF orientation is applied and
  every metadata block is dropped (GPS position, camera serial, XMP, IPTC), animations keep their frames, colour goes
  to sRGB, and a 640-pixel WebP thumbnail is made. Nothing is ever served as it was uploaded.
- **Storage and serving:** the picture and its thumbnail are **private** OpenVibe.Media objects (`MEDIAHUB_MEDIA_APP`).
  `/i/<slug>.<ext>` (the direct link) and `/i/<slug>/thumb.webp` read them from Media and serve them with `nosniff`, a
  sandboxing CSP, `Access-Control-Allow-Origin: *` and a 10-minute public cache, so the Media id never reaches a
  browser and a hidden picture leaves shared caches within minutes.
- **Resize and convert** ([server/pics/variants.js](server/pics/variants.js)): `/i/<slug>/w/<width>.<webp|avif|jpg|png>`
  at 320, 640, 1280, 1920 or 2560 px (never wider than the picture), made here with sharp from the stored copy
  (Media's own variants stop at 640 px), kept in a 64 MB LRU and served with the direct link's 10-minute cache; an
  animated picture keeps its frames as WebP. The picture page lists them; `pics.image.variant` budgets the misses.
- **Alt text** ([server/pics/describe.js](server/pics/describe.js)): what a screen reader says for a picture, used in
  its page, the thumbnails and every embed snippet (the title when there is none). The uploader writes it, or presses
  "Write alt text with AI": only then does the 640-pixel thumbnail go to OpenVibe.AI's `pics.describe_image` (which
  may use an outside model provider and keeps only the image's hash), and the draft (alt text, a caption labelled
  "Described by AI", tags) is kept until the uploader edits it. At most `MEDIAHUB_PICS_AI_PER_DAY` (300) pictures a
  day for the site, `pics.image.describe` per person; off with `MEDIAHUB_PICS_AI=off` or without `OV_AI_INTERNAL_URL`.
  Network grants `media-hub` the `pics.describe_image` namespace on `ai.run.create`.
- **Unlisted:** `/i/<slug>` (8 random characters) is reachable by its link only, noindex, never listed; robots.txt
  disallows `/i/` and `/a/`. The page has the links to share and embed: the page, the direct link, Markdown, BBCode
  and HTML.
- **Albums** (`/albums`, `/a/<slug>`): a person's own, shown to anyone with the link (hidden pictures left out).
- **Reports and takedown:** anyone may report a picture once (signed out: counted by a keyed hash of the address).
  A child-safety report hides it at once; any other reason hides it at 3 distinct reports. Hidden is 404 for everyone
  but its uploader and staff. Staff (`/staff`, Network `admin`/`global_mod`) restore, hide, or take down: a takedown
  deletes the bytes in Media and puts the picture's sha256 (uploaded and served) and its 64-bit difference hash on
  `pics_blocklist`, so the same picture, or a resized, re-compressed or retouched copy (within 10 bits: measured on
  real photos, such copies land 0–10 bits away and different photos 23–42), cannot be uploaded again.
- **Signed out** (`MEDIAHUB_PICS_ANONYMOUS=1`, **off**): uploads up to 10 MB, 20 a day per address, each with a delete
  key shown once and stored only as its sha256; a picture nobody has viewed for 30 days is deleted by an hourly sweep.
  It stays off until the owner registers the DMCA designated agent and the CSAM hash-matching account (NCMEC /
  Cloudflare CSAM Scanning Tool): plan T10's gate.
- **Legal:** `/terms`, `/privacy` and `/dmca` name openvibe.pics (openvibe-shared/legal, the `ugc` profile).

API on the pics host (`/api/v1`, a person; app, agent and service tokens are refused):

| Route | |
|---|---|
| `POST /images` | upload: the picture is the body (`Content-Type: image/*`; optional `X-Title`, `X-Filename`, URI-encoded); 201 with the links |
| `GET /images/:slug` | metadata and links (hidden: uploader and staff only; 410 when taken down) |
| `PATCH /images/:slug` | the uploader: `{ title, description, alt }` |
| `POST /images/:slug/describe` | the uploader: OpenVibe.AI drafts the alt text, a caption and tags (the picture goes to OpenVibe.AI only on this call) |
| `DELETE /images/:slug` | the uploader (signed out: `X-Delete-Key`) |
| `POST /images/:slug/reports` | anyone: `{ reason, note }`; `reason` one of `child_safety`, `illegal`, `copyright`, `sexual`, `violence`, `harassment`, `private_info`, `spam`, `other` |
| `GET /me/images` | your pictures, newest first, with your usage |
| `GET /albums`, `POST /albums` | your albums; create one `{ title, description }` |
| `GET /albums/:slug` | an album and its pictures |
| `POST /albums/:slug/images`, `DELETE /albums/:slug/images/:image`, `DELETE /albums/:slug` | the owner adds or takes out a picture, or deletes the album (the pictures stay) |

## OpenVibe.Video (openvibe.video)

OpenVibe.Video serves watch pages for videos people upload here, and for the recordings and clips people already
made public on OpenVibe.Live, plus playlists. Live's media files stay on OpenVibe.Media (`playback_url`), and the
pages read Live's public JSON API server-side, signed out (Live already applies visibility: a private item answers
404, an unlisted one is reachable by id but noindex and never listed).

**Uploads** (since 2026-10-15; `server/video/uploads.js`, `upload-routes.js`, migration `0008_video_uploads.sql`).
- **Who and what:** a signed-in person uploads at `/upload`. MP4, WebM and MKV are accepted; MOV and M4V are the same
  container and go to Media as MP4.
- **Limits:** `VIDEO_UPLOAD_MAX_BYTES` (2 GB) a file, `VIDEO_UPLOAD_QUOTA_BYTES` (20 GB) a person,
  `VIDEO_UPLOADS_PER_DAY` (10).
- **How the bytes travel:**
  - `public/js/video-upload.js` sends the file in 8 MB parts, in order: `POST /api/v1/videos`, then
    `PUT /api/v1/videos/:id/parts/:n` (nginx allows 9 MB on that route only), then `POST …/complete`. Every call is
    same-origin and signed in.
  - Each part is appended to one **OpenVibe.Media VOD** in this tenant (`/api/v1/media-hub/vods`, the
    `media.object.upload` grant). The video therefore gets what a Live recording gets: probe, thumbnail, seekable file,
    HLS timeline and renditions.
  - Completion runs in the background: the upload is *processing* until Media is done. The watch page says so and
    reloads itself (`Refresh: 15`), and a restart is recovered by asking Media again when the page or "Your videos" is
    read.
- **Where it shows:** the watch page is `/u/<id>`. A public, ready video is on the person's channel (`/@username`,
  as **Videos**), on the home page's **Latest uploads** and in the sitemap. Unlisted videos open by link only;
  private ones only for the owner and staff.
- **Owner tools:** the owner edits the title, description and visibility (Media's title and visibility follow) and
  deletes (Media's VOD is deleted). `/me/videos` lists their uploads with their state.
- **Reports:** anyone who can see a video may report it, once per person or per keyed address. A child-safety report
  hides it at once, and three reports hide it until staff decide; the owner still sees it, labelled.
- **Account deletion:** erases the rows and deletes the VODs in Media.
- **Recording** (`/record`, `public/js/video-record.js`):
  - Record from the camera or the screen (with the microphone) in the browser. It is never live.
  - MediaRecorder hands over a piece every 4 seconds, and each piece goes up in order
    (`POST /api/v1/videos/recordings`, then `PUT /api/v1/videos/:id/chunks/:n`, up to 9 MB each) to the same kind of
    Media VOD.
  - Stop completes it like an upload. Size and quota are checked as it grows, and a recording is private by default.
- **AI edit** (`server/video/ai-edit.js`, migration `0009_video_ai.sql`):
  - Every few minutes, OpenVibe.AI's `media.analyze` runs on each finished upload or recording. It reads the video
    through Media's signed URL (private ones too), runs locally (whisper.cpp, the local model) and never uses a paid
    model (`allow_paid: false`).
  - The transcript becomes captions (`/u/:id/captions.vtt`, a track) and a transcript panel; the highlights become
    chapters (`/u/:id/chapters.vtt` and a list); the overview becomes an "About this video" summary, labelled as AI,
    which the owner can make the description in one click.
  - A run still going is joined again by its key; a failure retries with backoff, 4 attempts at most.
  - Needs `OV_AI_INTERNAL_URL` and the Network grant `[media-hub, ai.run.create, openvibe.ai, ['media.analyze']]`;
    `VIDEO_AI_ANALYSIS=off` turns it off.
- **AI cut** (`server/video/cut.js`, migration `0015_video_cuts.sql`): the owner's "AI edit" panel on a finished upload
  makes an edited copy and never touches the original.
  - **Cut the pauses** (pauses of 1.5 s or more become half a second, lead-in and tail silence go), **cut tight** (0.7 s
    or more become 0.3 s), or a **highlights reel** (the best six moments the AI edit found, at most 3 minutes; older
    AI edits fall back to the chapter starts).
  - One cut at a time on the host, under `nice 19` with two threads: ffmpeg reads the original through Media's signed
    URL on `MEDIAHUB_MEDIA_URL`, finds the pauses (`silencedetect` at -40 dB, sound only), re-encodes the kept ranges
    (trim and concat, H.264 veryfast and AAC, at most 1080 lines; a browser recording may have one keyframe in minutes,
    so it is not cut on keyframes) as fragmented MP4 on stdout, and sends it to Media in 8 MB pieces as it is made: no
    file on MediaHub's disk.
  - The copy is a new private upload of the same person (`video_uploads.edited_from`) through the recording path, so
    it gets Media's processing, its own AI captions and chapters, and counts toward the daily uploads and the quota.
  - One waiting or running cut per person, `VIDEO_CUTS_PER_DAY` (5) a day, originals up to
    `VIDEO_CUTS_MAX_SOURCE_SECONDS` (3 h); a cut a restart interrupted loses its partial copy and is retried once.
    `POST /u/:id/cut`, `POST /api/v1/videos/:id/cuts` `{ mode }`, `GET …/cuts`; `VIDEO_CUTS=off` turns it off.

The player plays Media's segment timeline (`hls_url`, HLS) when the recording has one: natively where the browser
plays HLS, otherwise through hls.js, self-hosted at `public/vendor/hls.light.min.js` (hls.js 1.7.3, Apache-2.0, loaded
only then). The file stays the fallback: a recording without a timeline plays it, and a playlist that fails falls
back to it once at the same position. When playback starts, the page sends one beacon from the viewer's browser to
Live's `POST /api/views/:kind/:id`, so Live counts the view for the viewer's own address (the server-side reads all
come from the loopback address). The CSP allows Media's hosts (openvibe.media, its shield edge.openvibe.media and
the presigned R2/B2 hosts it may redirect a file to) and Live's origin for the beacon.

**Structured data.** A public recording's page carries a schema.org `VideoObject` (name, description, thumbnail, upload
time, ISO 8601 duration, the file, the view count, the channel as author) with its chapters as `Clip` parts (Google's
key moments, each a `?t=` link); a clip's page has its own `VideoObject`, `isPartOf` its recording; a public
playlist's page an `ItemList`. The thumbnail is the page's share image (`og:image`, `og:type` `video.other`). AI clips
stay out of search as on Live (noindex, no structured data), and so do a recording in progress and an owner's private
view.

**Owner tools.** A recording's channel, and a clip's maker or channel, see a "Manage" panel on the watch page: title,
description (recordings), visibility and delete. Each change is a same-origin web form that openvibe.video sends to
OpenVibe.Live's own API as the signed-in person (their Network token as a Bearer, refreshed once if it expired), so
Live's rules decide who may do what and its refusal is shown as it is; the cached reads of the item and of the lists
are dropped after a change. A private item is shown to its owner only (noindex, never cached).

**Make a clip.** Any signed-in viewer of a finished recording cuts a clip of up to 60 seconds from its page (start and
end as m:ss or h:mm:ss; "Start here" / "End here" mark the player's position). openvibe.video sends it to Live's own
`POST /api/vods/clips` as the person, with their address in `X-Forwarded-For` (Live limits clip-making per person and
per address), so Live's rules, limits and channel settings apply; the new clip's page says it is being cut, and
checks again by itself, until Media has cut it.

The VOD page also shows a chat replay of the stream (from OpenVibe.Chat) and read-only comments with a link to
the OpenVibe.Community thread. The video host signs in through the same Network SSO as the drive, with its own
callback URI (`https://openvibe.video/auth/callback`); each host's session cookie is host-only, so signing in on one
does not sign in on the other.

| Path | Who | What |
|---|---|---|
| `/` | anyone | what OpenVibe.Video is, then the latest recordings and clips |
| `/v/:id` | anyone | a VOD watch page: player, AI chapters and captions, chat replay, comments, its clips, add-to-playlist |
| `/c/:id` | anyone | a clip watch page: player, attribution, the full-recording link, add-to-playlist |
| `POST /v/:id/clip` | any signed-in viewer (Live decides) | cut a clip `{ start, end, title? }` of up to 60 seconds |
| `POST /v/:id/manage`, `POST /v/:id/delete` | the recording's channel (Live decides) | edit title, description and visibility; delete (a ticked box) |
| `POST /c/:id/manage`, `POST /c/:id/delete` | the clip's maker or channel (Live decides) | edit title and visibility; delete |
| `/@:username` | anyone | a channel's recordings (and clips), newest first, 24 per page |
| `/playlists` | the owner | their playlists: create, rename, change visibility, delete |
| `/playlists/:id` | anyone with the link | one playlist: public and unlisted are open by link (unlisted noindex), private only to the owner |
| `/v/:id/captions.vtt` | anyone | the AI transcript as WebVTT captions |
| `/v/:id/chapters.vtt` | anyone | the AI moments as WebVTT chapters |
| `/v/:id/download/:file` | whoever may see the recording (a private one: its owner) | the Download menu's files: `video` (OpenVibe.Media's file as an attachment, through Live's download link), `thumbnail`, `transcript.{txt,srt,vtt,json}`, `chat.{txt,csv,json}` (every message, in the recording's own time), `chapters.{txt,vtt,json}` (TXT is the lines a YouTube description takes), `info.json`, `all.zip` (everything but the video); named `<title> - <channel> - <date>.<what>.<ext>` ([server/video/downloads.js](server/video/downloads.js)) |
| `/c/:id/download/:file` | whoever may see the clip | `video`, `thumbnail`, `transcript.{txt,srt,vtt,json}`, `info.json`, `all.zip` |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt` | anyone | crawl artifacts for the video host |
| `/<INDEXNOW_KEY>.txt` | anyone | IndexNow's key file, only with a key: every 10 minutes a sweep of Live's public feed sends new watch pages, their channel pages and the sitemap to search engines ([server/video/indexnow.js](server/video/indexnow.js)) |

Configuration: `MEDIAHUB_VIDEO_URL` (default `https://openvibe.video`; its hostname is the video host),
`MEDIAHUB_LIVE_URL` (default `https://openvibe.live`; production points it at the loopback address),
`MEDIAHUB_LIVE_PUBLIC_URL` (default `https://openvibe.live`; links people click) and `MEDIAHUB_CHAT_URL`
(default `https://openvibe.live`, which proxies `/api/chat/` to OpenVibe.Chat; production points it at the loopback
address). The video host is chosen by `Host` header in `server/app.js`, so the drive's pages, API and legal pages
never answer there. Only https URLs from Live (player source, thumbnails, the thread link) reach a page; anything
else is dropped.

Playlists: 100 per owner and 500 items per playlist, from `MEDIAHUB_VIDEO_PLAYLISTS_MAX` and
`MEDIAHUB_VIDEO_PLAYLIST_ITEMS_MAX`. A playlist holds a kind and a number: a Live id (`vod` or `clip`) or an upload's number (`upload`, the `seq` of
`video_uploads`, migration 0010); the
watch pages fetch the cards through the cached Live client, and an item Live no longer answers is "No longer
available" to the owner and hidden for everyone else. "Play all" starts the first item with `?list=<id>`, and each
watch page opened with `?list=` shows "Up next" and advances when the video ends. A playlist may also be owned by
an app, agent or service through the API below; its public page attributes it "Curated by an app".

A channel page (`/@user`) lists that person's public playlists (newest twelve). An upload's watch page has the same
"Save to playlist" form (a ready video that is not private) and the same "Up next" panel; an upload that is made
private, hidden or removed drops out of everyone's playlists (its owner's list shows "No longer available").

## Pages

| Path | Who | What |
|---|---|---|
| `/` | anyone | openvibe.download's home: what it is, the safety rules, sign in. (openvibe.video is served by this same app; openvibe.pics is parked in nginx) |
| `/files`, `/files/:id` | the owner | your drive: folders, files, the usage bar, upload, share, delete |
| `/s/:slug` | a signed-in person | a share page: the name, the size, who shared it (their username), the expiry, Download, Report |
| `/staff` | staff | the reports queue: restore or remove |
| `/safety` | anyone | what is not allowed, how reports work, abuse@openvibe.network |
| `/updates` | anyone | what shipped |

## Uploads without an account (drops, off)

The owner's Q10 (MediaFire-style), built and **off** until the DMCA designated agent and the CSAM hash-matching account
exist (plan T10, the same gate as Pics' signed-out uploads): `MEDIAHUB_DOWNLOAD_ANONYMOUS=1` turns it on.

- The home page (signed out) gets an upload box ([public/js/drop.js](public/js/drop.js)): `POST /api/v1/drops`
  answers a session and a token, the parts are `PUT /api/v1/drops/:id/parts/:n` with `X-Drop-Token`, and
  `POST /api/v1/drops/:id/complete` answers the public page `/d/<slug>` and a delete link shown once (the key's sha256 is
  kept). The token, not the address, holds the session, so a phone that changes network keeps uploading.
- Up to 2 GB a file, 10 files and 10 GB a day per address (`MEDIAHUB_DROP_*`), an ownerless OpenVibe.Media object,
  kept 30 days after the last download (an hourly sweep deletes the rest). `mh_drops`, migration 0012.
- `/d/<slug>`: name, size, downloads, Download (an attachment with the drive's headers), and a Report form. Any report
  of illegal content, or three distinct ones, suspends it; staff restore it or take it down from `/staff`, and a
  taken-down drop's sha256 goes on `mh_drop_blocklist`, so the same bytes are refused (451 `drop.blocked`).

## Backups: sync keys and `openvibe-download`

A person keeps a folder on their computer backed up in their drive with the `openvibe-download` command
(openvibe-sdk 0.49.0, `openvibe-sdk/download`): `openvibe-download sync ~/Documents --to Backups/laptop` sends what is
new or changed (same size and sha256 is skipped), keeps the folder tree, and with `--delete` removes drive files whose
local copy is gone. It authenticates with a **sync key** made on `/sync` (`OPENVIBE_DOWNLOAD_KEY`):

- `ovdl_` and 43 url-safe characters, shown once; only its sha256 is stored (`mh_sync_keys`, migration 0011), with
  the first 12 characters to tell keys apart. 10 live keys per person (`MEDIAHUB_SYNC_KEYS_MAX`).
- It acts for its owner on the drive's `/api/v1` only (the router checks it before the shared principal): files,
  folders, uploads and usage. Share links answer 403 `sync_key.not_allowed`, and Pics and Video never see it.
- Its uploads have their own daily cap (`MEDIAHUB_SYNC_UPLOADS_PER_DAY`, 1,000, against the browser's 50) and their
  own request budgets (`media-hub.sync.upload.start|complete`, 120 a minute, 1,000 an hour); storage and the per-file
  size are capped the same. A revoked or unknown key is 401 `sync_key.invalid`.
- The account export lists keys without their hashes; deleting the account deletes them.

## API (`/api/v1`, a signed-in person, or their sync key)

| Route | |
|---|---|
| `GET /files`, `POST /files`, `GET /files/:id`, `DELETE /files/:id` | your files |
| `GET /folders`, `POST /folders` | your folders |
| `POST /shares`, `DELETE /shares/:slug` | make (`{ file_id \| folder_id, hours, usernames? }`) and revoke share links |
| `GET /uploads/:id`, `PUT /uploads/:id/parts/:n`, `POST /uploads/:id/complete`, `DELETE /uploads/:id` | resumable uploads |
| `GET /usage` | your usage against the limits |

On the video host (openvibe.video), the playlist API accepts a person Bearer token, an app/agent/service token
with the right capability, or (for public reads) no token — see **Playlist API** below. The drive's `/api/v1`
routes are unchanged and remain a signed-in person only.

## Playlist API

The video host's playlist API is `/api/v1/video/*`. The caller is the existing principal
(`server/http/principal.js`): a person's own Network token as `Authorization: Bearer` works exactly like the
session, an app/agent/service token needs the capability the route names, and public reads are open to anyone.

| Route | Who | What |
|---|---|---|
| `GET /api/v1/video/playlists` | person, or app with `video.playlist.read` | the caller's own playlists, newest first |
| `POST /api/v1/video/playlists` | person, or app with `video.playlist.manage` | create one from `{ title, description?, visibility? }` |
| `GET /api/v1/video/playlists/:id` | owner (private too); anyone for public/unlisted; app with `video.playlist.read` for others' public/unlisted | one playlist and its items |
| `PATCH /api/v1/video/playlists/:id` | owner, or app with `video.playlist.manage` | rename / describe / change visibility |
| `DELETE /api/v1/video/playlists/:id` | owner, or app with `video.playlist.manage` | delete it (its items go with it) |
| `POST /api/v1/video/playlists/:id/items` | owner, or app with `video.playlist.manage` | add one `{ kind: 'vod'|'clip'|'upload', id }` |
| `PATCH /api/v1/video/playlists/:id/items` | owner, or app with `video.playlist.manage` | reorder: the full ordered list `{ items: [{ kind, id }, …] }` |
| `DELETE /api/v1/video/playlists/:id/items/:kind/:itemId` | owner, or app with `video.playlist.manage` | remove one |
| `GET /api/v1/video/users/:username/playlists` | anyone | that person's public playlists, newest first, `limit` (default 20, max 50) and an opaque `cursor` |

An app/agent/service owns a playlist under its requester (`app:app_…`, `agent:agt_…`, `service:<slug>`) and the
playlist records its `project_id`. Its Network token is minted for the media hub's audience, `openvibe.download`, as
for the drive (one service, one audience). A person's session-cookie writes must be same-origin; a person Bearer token needs
no capability. A private playlist answers `404 playlist.not_found` to anyone but its owner (never 403). Errors are
RFC 9457 problem+json with a stable code (`token.required`, `capability.denied`, `playlist.not_found`, and the
playlist validation codes).

Create with an app token:

```bash
curl -sS https://openvibe.video/api/v1/video/playlists \
  -H 'Authorization: Bearer <app token>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Clipped moments","visibility":"unlisted"}'
```

A public read (no token) returns the playlist and its items:

```bash
curl -sS https://openvibe.video/api/v1/video/playlists/<id>
```

```json
{
  "playlist": {
    "id": "vpl_…", "title": "…", "description": "…", "visibility": "unlisted",
    "owner": { "kind": "user", "username": "kim" },
    "item_count": 2, "created_at": "…", "updated_at": "…"
  },
  "items": [{ "kind": "vod", "id": 101, "position": 0, "added_at": "…" }]
}
```

`owner` is `{ kind: 'user', username }` for a person, or `{ kind: 'app' | 'agent' | 'service' }` otherwise. Items
are Live ids (`vod`, `clip`) or upload numbers (`upload`); the watch pages resolve their display fields lazily, through
the cached Live client for Live's and from `video_uploads` for uploads.

## Account export and deletion (ADR-033)

`POST /internal/events` (v2 signature under `MEDIAHUB_EVENTS_SECRET`, loopback only; nginx answers `/internal/` with 404)
takes `network.account.export_requested` and `network.account.deleted`, and the subscriptions are created at boot
(`MEDIAHUB_EVENTS_URL`).

- **Export:** the person's files, folders, shares, the reports they made and their usage; their playlists; and their
  OpenVibe.Pics pictures, albums (with their pictures' order), the reports they filed and their upload counts.
- **Deletion:** all of it is erased, and each object (a file, a picture and its thumbnail) is deleted in Media too.
  The takedown blocklist is staff's record, not the person's, and stays.

## Configuration

Every name is in [.env.example](.env.example): the Network client (`OV_OAUTH_CLIENT_ID=media-hub`, secret, internal
URL), PostgreSQL and Valkey (written by the host's data role), Media (`MEDIAHUB_MEDIA_URL`, `MEDIAHUB_MEDIA_APP`),
Live (`MEDIAHUB_LIVE_URL`, `MEDIAHUB_LIVE_PUBLIC_URL`), Video (`MEDIAHUB_VIDEO_URL`), Pics (`MEDIAHUB_PICS_URL` and the
`MEDIAHUB_PICS_*` limits, `MEDIAHUB_PICS_ANONYMOUS`),
Events, and the limits (`MEDIAHUB_QUOTA_BYTES`, `MEDIAHUB_MAX_FILE_BYTES`,
`MEDIAHUB_UPLOADS_PER_DAY`, `MEDIAHUB_MAX_SHARES`, `MEDIAHUB_SINGLE_UPLOAD_BYTES`, `MEDIAHUB_PART_BYTES`).

## Development

```bash
npm install
cp .env.example .env
npm run dev        # http://127.0.0.1:4990, PGlite under data/
npm test           # every test/*.test.js on PGlite, with stand-ins for Network and Media
```

## Acceptance

`npm test` ([test/run.js](test/run.js)) runs every `test/*.test.js` in its own process on a temporary PGlite
database, with in-process stand-ins for OpenVibe.Network and OpenVibe.Media. The main files:

- `auth-ops.test.js`, `auth-jwks.test.js` — sign-in redirects with PKCE S256 and cookies, truthful readiness, and
  JWKS fetch/verify through an outage.
- `drive-upload.test.js` — the plain form and the chunked path, resume after a dropped part, and the 512 MB / 2 GB /
  50-a-day caps.
- `drive-download.test.js` — every download is an attachment with nosniff and a sandbox CSP, the real type only for
  the safe list, and Range resumes.
- `drive-shares.test.js` — a share is 24 random characters, expires in 1 hour to 7 days, is revocable, counted and
  sign-in only, and matches its allow-list on subjects.
- `drive-reports.test.js` — one report per person per share, three distinct reports or one illegal report suspend
  it, and staff restore or remove.
- `drive-pages.test.js` — every page renders without JavaScript and everything typed is escaped everywhere shown.
- `form-upload.test.js` — the multipart reader streams to disk and refuses an over-long field, a second file and a
  cut-off body.
- `account-data.test.js` — signed export and deletion on the loopback route, with the Media objects deleted.
- `caller-limits.test.js` — one caller's 429 arrives before the route runs, another caller still passes, and the
  window reopens on the clock.
- `security-secrets.test.js`, `security-session.test.js`, `no-internal-key.test.js`, `open-redirect.test.js` —
  secrets never leave in a body, header or log, the session cookie holds a person's Network session, no
  `X-Internal-Key` path exists, and the sign-in `next` never leaves the site.
- `nginx-auth-limit.test.js`, `nginx-parked-domains.test.js` — the nginx rate zones and the parked-domain redirects.
- `discovery.test.js`, `layout.test.js`, `asset-cache.test.js`, `perf-budget.test.js`, `service-kit.test.js` — crawl
  artifacts, page layout, asset cache headers, home-page size budgets and the graceful stop.

## Deploy

`sudo ovhost deploy media-hub` on the host (unit [deploy/systemd/openvibe-media-hub.service](deploy/systemd/openvibe-media-hub.service),
env `/etc/openvibe/media-hub.env`). The vhost [deploy/nginx/openvibe.download.conf](deploy/nginx/openvibe.download.conf)
serves openvibe.download and openvibe.video (both proxy to the app on 127.0.0.1:4990) and parks openvibe.pics with a
302 to `https://openvibe.network/` (each name with its own certificate); it is installed with `ov-vhost-install`.
Uploads stream through nginx unbuffered; downloads are not buffered either.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Uploads are account-only and files are private. A share link needs a signed-in downloader unless its owner made it
  public; a public link's page takes reports from anyone (a signed-out reporter is a keyed hash of the address, never
  the address), and three reports, or one of illegal content, suspend it. No download renders as a page.
- The form reader streams files to disk. A text field over 64 KB, a second file, or a body cut off before its last
  boundary is refused.
- Session tokens are httpOnly cookies. Secrets live only in the env file, and no secret or request body is logged.
- Next, before Pics or Download take signed-out uploads: scanning (hash lists, malware), a DMCA agent, and abuse intake
  shared with OpenVibe.Media's holds. Signed-in uploads are open on all three sites.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.214.0
- openvibe-sdk: v0.65.0
- openvibe-shared: v4.14.0
<!-- versions:end -->
