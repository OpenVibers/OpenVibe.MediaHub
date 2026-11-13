# AGENTS.md — OpenVibe.MediaHub

## Project Overview

OpenVibe.MediaHub is the network's file service. One process serves three hosts, chosen by Host header:

- **openvibe.download** — a private drive: upload, folders, share links, resumable uploads, sync keys, agent grants.
- **openvibe.video** — OpenVibe.Video: uploads and browser recordings, AI captions/chapters/cuts, watch pages,
  playlists, and OpenVibe.Live's stream recordings and clips.
- **openvibe.pics** — OpenVibe.Pics: picture hosting with resize/convert, alt text, albums, the public gallery and a
  takedown blocklist.

- **Port:** 4990 · **Service id:** `media-hub` · **Env prefix:** `MEDIAHUB`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [.env.example](.env.example).

**Network context:** subjects, usernames and JWKS are OpenVibe.Network (OAuth client `media-hub`). The **bytes** are
OpenVibe.Media objects (`med_…`); MediaHub stores ids and metadata and asks Media to create/read/delete. Live's public
JSON API supplies recordings/clips (`MEDIAHUB_LIVE_URL`). Comments on videos and pictures are OpenVibe.Community
threads through `server/comments/`. Sharing is `openvibe-sdk/share`. Events go through `event_outbox` to
OpenVibe.Events; account export/deletion arrives at `/internal/events`; public ready videos go to OpenVibe.Search.
Nothing here is identity, media bytes, money or event delivery.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
cp .env.example .env           # development names/values
npm run dev                    # http://127.0.0.1:4990, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js on PGlite with stand-ins for Network/Media
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- video-             # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: pages are server-rendered; browser code is plain JS under [public/js/](public/js/) plus the vendored
HLS player [public/vendor/hls.light.min.js](public/vendor/hls.light.min.js).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry flush/retention, Events subscriptions; graceful
  stop in `createLifecycle()`. `MEDIAHUB_DRILL` keeps boot-time work off.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP, SSO, **host routing** (`videoHost`, `picsHost`; every
  other host is the drive), `/auth`, `/internal/events`, `/shared` + static, `/api/v1`, the agent layer, pages, 404 and
  error handler. Tests build `createApp({ store, fetchImpl, ... })`.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/media-hub.env`.
- **Drive:** [server/drive/](server/drive/) — `service.js`, `store.js`, `upload.js` (chunked/resumable),
  `syncKeys.js`, `drops.js`, `ui.js`; API [server/http/api.js](server/http/api.js). Bytes: [server/media/](server/media/).
- **Video:** [server/video/](server/video/) — `pages.js`, `uploads.js`, `playlists.js`, `ai-edit.js` (captions,
  chapters, cut/trim), `cut.js`, `downloads.js`, `watch-ui.js`, `studio.js`, `search-index.js`, `comments-client.js`;
  watch routes and `/u/` owner pages.
- **Pics:** [server/pics/](server/pics/) — `service.js`, `pages.js`, `api.js`, `store.js`, `describe.js` (AI alt text),
  `gallery.js`, `policy.js`, `variants.js`, `images.js`, `resumable.js`; [server/comments/](server/comments/)
  (`form.js`, `inline.js`) for Community threads.
- **Radio:** [server/radio/routes.js](server/radio/routes.js) — the shared radio tracks/listener.
- **Auth:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js),
  [server/http/principal.js](server/http/principal.js) (person, sync key, app/agent/service capability).
- **Frontend:** server-rendered through [server/render/](server/render/) and `openvibe-shared/shell|frame`, with
  assets [public/css/](public/css/) (`app`, `drive`, `video`, `pics`, `comments`, `labels`, `radio`) and
  [public/js/](public/js/) (`upload`, `video`, `video-upload`, `video-record`, `pics`, `pics-gallery`, `drop`,
  `comments`, `my-videos`, `video-home`). Pages work without JavaScript; the one drive script is a progress meter.
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/) — drive (`mh_files`, `mh_folders`,
  `mh_shares`, `mh_reports`, `mh_usage`, `mh_uploads`, `mh_sync_keys`, `mh_drops`, `mh_agent_grants`,
  `mh_share_defaults`, `mh_drop_reports`, `mh_drop_blocklist`), video (`video_uploads`, `video_playlists`,
  `video_playlist_items`, `video_cuts`, `video_likes`, `video_search_state`, `video_upload_ai`,
  `video_upload_reports`, `video_usage`), pics (`pics_images`, `pics_albums`, `pics_album_images`, `pics_reports`,
  `pics_blocklist`, `pics_usage`, `pics_views`, `pics_likes`, `pics_uploads`, `pics_upload_chunks`), radio,
  sharing (`shares`, `share_*`), `event_outbox`, `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-media-hub.service](deploy/systemd/openvibe-media-hub.service)
  (`/etc/openvibe/media-hub.env`, `/opt/openvibe.download`) and
  [deploy/nginx/openvibe.download.conf](deploy/nginx/openvibe.download.conf) — one vhost for openvibe.download and
  openvibe.video (both proxy to 127.0.0.1:4990), openvibe.pics parked with a 302 to `https://openvibe.network/`;
  uploads and downloads stream unbuffered. `sudo ovhost deploy media-hub`; database `ov_media_hub`.

## Ownership and Boundaries

MediaHub owns the drive's metadata, share links, sync keys, agent grants, upload sessions, reports and usage; the
video upload/playlist/cut metadata and search state; the pics metadata, albums, gallery, labels and blocklist; the
radio tracks; its share rows and outbox. It does **not** own the bytes (Media), identity (Network), Live's channels or
recordings (Live), comments (Community), event delivery (Events), or the search index (Search). CSAM hash matching
against NCMEC/PhotoDNA is not implemented: Pics matches only its own takedown blocklist, and child-safety reports hide
at once. Never claim otherwise in UI or docs.

## Auth and Capabilities

The Contracts manifest lists ten capabilities: `video.vod.read`, `video.playlist.read`, `video.playlist.manage`,
`pics.image.read`, `pics.image.upload`, `pics.album.read`, `pics.album.manage`, `download.file.read`,
`download.file.upload`, `download.share.create`. The two playlist capabilities are registered in
[server/http/principal.js](server/http/principal.js). `download.file.read` is agent-only and requires that agent's
active per-file grant — a capability never lists the drive or replaces the grant. Every other drive write is a
signed-in person or the owner's scoped sync key.

- Cookie-authenticated writes must be same-origin. Uploads and downloads take the same per-caller budgets as the API
  route they stand for, so a plain form is never a way round a limit.
- Outbound: `identity.subject.resolve` (Network), Media `media.object.upload|read` on namespace `media-hub`,
  `events.subscription.manage` + `events.event.publish` (`mediahub.video.published`, `mediahub.picture.uploaded`),
  `search.document.write`.
- Errors are RFC 9457 problem+json with stable codes; never leak Media's internals or a person's email/subject.

## API (drive, `/api/v1`)

`GET /files`, `POST /files`, `GET|DELETE /files/:id`, `GET /folders`, `POST /folders`,
`POST /shares`, `DELETE /shares/:slug`, `GET|POST /agent-grants`, `DELETE /agent-grants/:id`,
`GET /agent/files/:id/content` (agent + grant, byte ranges), `GET|PUT|POST|DELETE /uploads/:id[/parts/:n|/complete]`,
`GET /usage`. Video and Pics have their own APIs on their hosts (`/api/v1/videos`, playlists, pics/images,
albums, gallery, comments), plus public reads, `/llms.txt`, sitemaps and IndexNow for openvibe.video. Machine
endpoints `/api/health`, `/api/ready`, `/release.json`, `/metrics` are loopback only.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async handlers through the router so a
  rejection reaches the error handler.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Prefix tables by product (`mh_`, `pics_`,
  `video_`) and keep the 40+ existing numbers' order.
- Never render a file's bytes into a page; escape every owner-supplied name with the `html` template.
- CSP: add every external origin to the `helmet` directives in [server/app.js](server/app.js) (Media images, Live HLS,
  Community, Events, Search). Do not widen `frameAncestors`/`objectSrc`. The HLS player is vendored on purpose.
- **No Font Awesome** — use `openvibe-shared/glyphs` and `openvibe-shared/brands`; the no-FA guard
  checks every page and stylesheet, and a new `fa-` name must be one the glyphs/brands draw.
- **No looks filter** — `openvibe-sdk/no-looks` is gone; AI text may describe people. Only sex acts/porn stay gated
  ([test/no-looks-guard.test.js](test/no-looks-guard.test.js)).
- Phone first: watch, drive, pics and gallery pages must fit 390 px; the video mini-player and the watch page are
  first-class phone surfaces.
- "Calm reduces, only Off removes": audience/share preferences de-emphasize, they do not silently delete. Only the
  explicit Off/delete path removes.
- Empty states use the shared kit (`ovk-empty`), not bespoke markup ([test/empty-states.test.js](test/empty-states.test.js)).

## Key Pitfalls

- **Host header is the product switch.** openvibe.video and openvibe.pics must never serve drive pages/API and vice
  versa; add new routes to the right host router in [server/app.js](server/app.js).
- **Bytes are Media's.** Never write a media file to local disk as the source of truth; Media controls retention, and
  a soft-deleted drive row stays until its object is gone.
- **Streaming:** uploads and downloads must not be buffered by nginx or by the app; the vhost is deliberately
  `proxy_request_buffering off`/`proxy_buffering off`. Range requests must keep working for the player and downloads.
- **Share links** have expiry, allow-lists and a report high-water mark; revocation is immediate. Agent grants expire
  after 1–720 h and cover one file — do not turn one into a listing right.
- **Pics policy:** signed-out uploads exist only with `MEDIAHUB_PICS_ANONYMOUS`; the anonymous delete key is stored as
  its sha256; the blocklist matches sha256 and difference hashes, not perceptual guesses. Reports hide first, review
  later.
- **Video imports** from Live are public-API reads (signed out); a recording in progress is handled by Media, and a
  stale/private upload is tombstoned from Search. Never call Media's private routes with a person's token.
- **Drill mode** (`MEDIAHUB_DRILL`) keeps the backfills, search sync, indexnow and timers off; add new background work
  there.
- **`event_outbox`** needs its rejected partial index ([migrations/0025_outbox_rejected_index.sql](migrations/0025_outbox_rejected_index.sql)).
- Nginx parks openvibe.pics with a 302 today; do not "fix" that without the Pics deployment decision.

## Testing

`npm test` runs each file in its own process on PGlite with Network/Media stand-ins. The suite covers drive
upload/share/download/range, sync keys, agent grants, drops, video upload/record/playlists/AI/cut/trim/search/comments,
pics upload/gallery/album/labels/policy/sharing/rotate, radio, sharing, account data, host routing, no Font Awesome,
no-looks, empty states, phone/contrast, secret-leak/redirect and size budgets. Run the narrowest file first, then the
suite; `npm run test:pg` for the PostgreSQL path. Always `node --check` changed files.

## Documentation

- [README.md](README.md) — three products in one process, owns/does-not-own, capabilities, drive/video/pics pages,
  sync keys, API, playlists, account data, configuration, acceptance, deploy, security notes.
- [docs/screenshots/](docs/screenshots/) — recorded UI states.
- [STATUS.json](STATUS.json) — stage, deployed flag, features and not-yet list.
- [.env.example](.env.example) — variable names only; never commit values.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
