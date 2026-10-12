# OpenVibe.MediaHub

> Your files, shared on your terms.

**Status:** alpha. One process serves **openvibe.download** (a private drive, live in v1) and
**openvibe.video** (public watch pages and playlists for OpenVibe.Live's stream recordings and clips), chosen by Host
header. **openvibe.pics** is still parked: it redirects to `https://openvibe.network/` until Pics is built.
**Port:** 4990 · **Service id:** `media-hub` · **Env prefix:** `MEDIAHUB` · **License:** AGPL-3.0.

## Purpose

OpenVibe.MediaHub is the network's file service: it serves **openvibe.download** as a private drive where a
signed-in person can upload, organise, share and delete their own files. The bytes live in OpenVibe.Media; MediaHub
keeps the metadata, the per-person limits, the share links and the report queue. It also answers OpenVibe.Network's
account export and deletion events (ADR-033). The same process serves **openvibe.video**, the public watch pages for
OpenVibe.Live's stream recordings and clips (OpenVibe.Video v1, step A). openvibe.pics is parked in nginx and redirects
to openvibe.network.

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

## Does not own

- The bytes are **OpenVibe.Media**'s: MediaHub stores an object id and asks Media to create, read and delete the
  object; Media's own retention decides when the bytes actually go.
- Identity, usernames and canonical account subjects are **OpenVibe.Network**'s, resolved through Network's
  `identity.subject.resolve`.
- Event delivery, and the account export/deletion topics, are **OpenVibe.Events**': MediaHub only creates its
  subscriptions and consumes the two deliveries.
- The **openvibe.pics** product (image hosting and albums) is not built here yet: that domain is parked in nginx.
  Previews and thumbnails are not built either.

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

## Why v1 is narrow

Public file hosting is the riskiest surface on the network: OpenVibe.Media has no malware or CSAM scanning yet. So
OpenVibe.Download v1 is a **private drive**, not a public host:

- Every upload and every file page needs a signed-in OpenVibe person. Apps, agents and anonymous callers cannot upload.
- Files are private to their owner: another person's file id answers 404.
- A share link (`/s/<slug>`, 24 random url-safe characters) expires in 1 hour to 7 days (7 by default), can be revoked,
  counts downloads, and **needs the downloader to be signed in**. It may be limited to named OpenVibe accounts. The names
  are resolved through OpenVibe.Network to account subjects, and only subjects are matched, because a username can
  change hands. A name no account has is refused.
- Every share page has a Report form (malware, illegal content, copyright, something else). Three distinct reports,
  or any report of illegal content, suspend the share at once. Staff (Network role `admin` or `global_mod`) then
  restore it, or remove the file, which also deletes the object in Media.
- Downloads are always attachments, with `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox` and a real `Content-Type` only for a short safe list (images
  except SVG, audio, video, PDF, plain text, zip). HTML, SVG and anything executable come back as
  `application/octet-stream`. The name survives in any script (`filename*=UTF-8''…`) and can never break the header.
- Per-person limits, all from the environment: 2 GB stored, 512 MB per file, 50 uploads a day, 20 live share links.

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

## OpenVibe.Video (openvibe.video)

OpenVibe.Video is public and read-only: it serves watch pages for the recordings and clips people already made
public on OpenVibe.Live, plus playlists. There are no uploads and no new storage — the media files stay on
OpenVibe.Media (`playback_url`), and the pages read Live's public JSON API server-side, signed out (Live already
applies visibility: a private item answers 404, an unlisted one is reachable by id but noindex and never listed).

The player plays Media's segment timeline (`hls_url`, HLS) when the recording has one: natively where the browser
plays HLS, otherwise through hls.js, self-hosted at `public/vendor/hls.light.min.js` (hls.js 1.7.3, Apache-2.0, loaded
only then). The file stays the fallback: a recording without a timeline plays it, and a playlist that fails falls
back to it once at the same position. When playback starts, the page sends one beacon from the viewer's browser to
Live's `POST /api/views/:kind/:id`, so Live counts the view for the viewer's own address (the server-side reads all
come from the loopback address). The CSP allows Media's hosts (openvibe.media, its shield edge.openvibe.media and
the presigned R2/B2 hosts it may redirect a file to) and Live's origin for the beacon.

The VOD page also shows a chat replay of the stream (from OpenVibe.Chat) and read-only comments with a link to
the OpenVibe.Community thread. The video host signs in through the same Network SSO as the drive, with its own
callback URI (`https://openvibe.video/auth/callback`); each host's session cookie is host-only, so signing in on one
does not sign in on the other.

| Path | Who | What |
|---|---|---|
| `/` | anyone | what OpenVibe.Video is, then the latest recordings and clips |
| `/v/:id` | anyone | a VOD watch page: player, AI chapters and captions, chat replay, comments, its clips, add-to-playlist |
| `/c/:id` | anyone | a clip watch page: player, attribution, the full-recording link, add-to-playlist |
| `/@:username` | anyone | a channel's recordings (and clips), newest first, 24 per page |
| `/playlists` | the owner | their playlists: create, rename, change visibility, delete |
| `/playlists/:id` | anyone with the link | one playlist: public and unlisted are open by link (unlisted noindex), private only to the owner |
| `/v/:id/captions.vtt` | anyone | the AI transcript as WebVTT captions |
| `/v/:id/chapters.vtt` | anyone | the AI moments as WebVTT chapters |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt` | anyone | crawl artifacts for the video host |

Configuration: `MEDIAHUB_VIDEO_URL` (default `https://openvibe.video`; its hostname is the video host),
`MEDIAHUB_LIVE_URL` (default `https://openvibe.live`; production points it at the loopback address),
`MEDIAHUB_LIVE_PUBLIC_URL` (default `https://openvibe.live`; links people click) and `MEDIAHUB_CHAT_URL`
(default `https://openvibe.live`, which proxies `/api/chat/` to OpenVibe.Chat; production points it at the loopback
address). The video host is chosen by `Host` header in `server/app.js`, so the drive's pages, API and legal pages
never answer there. Only https URLs from Live (player source, thumbnails, the thread link) reach a page; anything
else is dropped.

Playlists: 100 per owner and 500 items per playlist, from `MEDIAHUB_VIDEO_PLAYLISTS_MAX` and
`MEDIAHUB_VIDEO_PLAYLIST_ITEMS_MAX`. A playlist holds Live ids only (`vod` or `clip` plus the numeric id); the
watch pages fetch the cards through the cached Live client, and an item Live no longer answers is "No longer
available" to the owner and hidden for everyone else. "Play all" starts the first item with `?list=<id>`, and each
watch page opened with `?list=` shows "Up next" and advances when the video ends. A playlist may also be owned by
an app, agent or service through the API below; its public page attributes it "Curated by an app".

A channel page (`/@user`) lists that person's public playlists (newest twelve). Not built yet: uploads.

## Pages

| Path | Who | What |
|---|---|---|
| `/` | anyone | openvibe.download's home: what it is, the safety rules, sign in. (openvibe.video is served by this same app; openvibe.pics is parked in nginx) |
| `/files`, `/files/:id` | the owner | your drive: folders, files, the usage bar, upload, share, delete |
| `/s/:slug` | a signed-in person | a share page: the name, the size, who shared it (their username), the expiry, Download, Report |
| `/staff` | staff | the reports queue: restore or remove |
| `/safety` | anyone | what is not allowed, how reports work, abuse@openvibe.network |
| `/updates` | anyone | what shipped |

## API (`/api/v1`, a signed-in person only)

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
| `POST /api/v1/video/playlists/:id/items` | owner, or app with `video.playlist.manage` | add one `{ kind: 'vod'|'clip', id }` |
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
are Live ids only; the watch pages resolve their display fields lazily through the cached Live client.

## Account export and deletion (ADR-033)

`POST /internal/events` (v2 signature under `MEDIAHUB_EVENTS_SECRET`, loopback only; nginx answers `/internal/` with 404)
takes `network.account.export_requested` and `network.account.deleted`, and the subscriptions are created at boot
(`MEDIAHUB_EVENTS_URL`).

- **Export:** the person's files, folders, shares, the reports they made and their usage.
- **Deletion:** all of it is erased, and each object is deleted in Media too.

## Configuration

Every name is in [.env.example](.env.example): the Network client (`OV_OAUTH_CLIENT_ID=media-hub`, secret, internal
URL), PostgreSQL and Valkey (written by the host's data role), Media (`MEDIAHUB_MEDIA_URL`, `MEDIAHUB_MEDIA_APP`),
Live (`MEDIAHUB_LIVE_URL`, `MEDIAHUB_LIVE_PUBLIC_URL`) and Video (`MEDIAHUB_VIDEO_URL`),
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

- Uploads are account-only, files are private, and share links need a signed-in downloader. Every download is
  attributable, and none renders as a page.
- The form reader streams files to disk. A text field over 64 KB, a second file, or a body cut off before its last
  boundary is refused.
- Session tokens are httpOnly cookies. Secrets live only in the env file, and no secret or request body is logged.
- Next, before Pics or Video take uploads: scanning (hash lists, malware), a DMCA agent, and abuse intake shared
  with OpenVibe.Media's holds.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.143.0
- openvibe-sdk: v0.44.0
- openvibe-shared: v4.0.2
<!-- versions:end -->
