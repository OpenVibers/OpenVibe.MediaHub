# OpenVibe.MediaHub

> Your files, shared on your terms.

**Status:** alpha. **openvibe.download** (a private drive, live in v1) is the one domain this service serves.
**openvibe.pics** and **openvibe.video** are parked: they redirect to `https://openvibe.network/` until Pics and
Video are built, so no request for either host reaches the app.
**Port:** 4990 · **Service id:** `media-hub` · **Env prefix:** `MEDIAHUB` · **License:** AGPL-3.0.

## Purpose

OpenVibe.MediaHub is the network's file service: it serves **openvibe.download** as a private drive where a
signed-in person can upload, organise, share and delete their own files. The bytes live in OpenVibe.Media; MediaHub
keeps the metadata, the per-person limits, the share links and the report queue. It also answers OpenVibe.Network's
account export and deletion events (ADR-033). openvibe.pics and openvibe.video are parked in nginx and redirect to
openvibe.network, so v1 is the drive and nothing else.

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

## Does not own

- The bytes are **OpenVibe.Media**'s: MediaHub stores an object id and asks Media to create, read and delete the
  object; Media's own retention decides when the bytes actually go.
- Identity, usernames and canonical account subjects are **OpenVibe.Network**'s, resolved through Network's
  `identity.subject.resolve`.
- Event delivery, and the account export/deletion topics, are **OpenVibe.Events**': MediaHub only creates its
  subscriptions and consumes the two deliveries.
- The **openvibe.pics** and **openvibe.video** products (image hosting, albums, video watch pages) are not built
  here yet: those domains are parked in nginx. Previews and thumbnails are not built either.

## Depends on

- **OpenVibe.Network** — SSO (OAuth 2 with PKCE S256, client id `media-hub`) and its JWKS: `OV_NETWORK_URL`,
  `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `OV_OAUTH_REDIRECT_URI`,
  `MEDIAHUB_AUDIENCE`. It calls `identity.subject.resolve` on the internal URL with a service token of its own.
- **OpenVibe.Media** — where the bytes live: `MEDIAHUB_MEDIA_URL`, `MEDIAHUB_MEDIA_APP`, `MEDIAHUB_MEDIA_APP_KEY`
  (and `MEDIAHUB_MEDIA_TIMEOUT_MS`).
- **OpenVibe.Events** — `MEDIAHUB_EVENTS_URL` (the two subscriptions are created at boot) and
  `MEDIAHUB_EVENTS_SECRET` (the v2 signature on `POST /internal/events`).
- **PostgreSQL** and **Valkey** — `DATABASE_URL` / `DATABASE_DIRECT_URL`, `VALKEY_URL` / `VALKEY_PREFIX`, read
  through openvibe-sdk/db and openvibe-sdk/valkey.
- **Packages** — openvibe-contracts, openvibe-sdk and openvibe-shared (versions below), with express, helmet,
  cookie-parser and express-rate-limit.

## Capabilities

The service manifest (openvibe-contracts, `manifests/services/media-hub.json`) lists ten capabilities it owns —
`video.vod.read`, `video.playlist.read`, `video.playlist.manage`, `pics.image.read`, `pics.image.upload`,
`pics.album.read`, `pics.album.manage`, `download.file.read`, `download.file.upload`, `download.share.create` — but
no route guards one yet: `CAPABILITIES` in `server/http/principal.js` is empty, and every `/api/v1` route requires a
signed-in person, never an app, agent or service token.

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

Bytes live in **OpenVibe.Media** (`MEDIAHUB_MEDIA_URL`, app `media-hub`, app key `MEDIAHUB_MEDIA_APP_KEY`). MediaHub
calls Media server-side only, naming the person with `X-OV-Subject`, and never hands a browser a Media URL:

- **Small files:** the plain form (`POST /files/upload`, no JavaScript needed) streams the file to a temp file with
  its sha256, then into Media. The ceiling is `MEDIAHUB_SINGLE_UPLOAD_BYTES`, 256 MB.
- **Big files:** the page's small script uploads in parts (`/api/v1/uploads/:id/parts/:n`, 8 MB each) that can
  resume after a dropped connection.
- **Downloads:** MediaHub checks access, then streams from Media with its own headers. Range requests pass through,
  so downloads resume.

MediaHub owns the drive: `mh_files`, `mh_folders`, `mh_shares`, `mh_reports`, `mh_usage` (migrations/0002_mediahub.sql).

## Pages

| Path | Who | What |
|---|---|---|
| `/` | anyone | openvibe.download's home: what it is, the safety rules, sign in. (openvibe.pics and openvibe.video are parked in nginx, not served here) |
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

Session-cookie writes must be same-origin. Errors are RFC 9457 problem+json with a stable `code`.

## Account export and deletion (ADR-033)

`POST /internal/events` (v2 signature under `MEDIAHUB_EVENTS_SECRET`, loopback only; nginx answers `/internal/` with 404)
takes `network.account.export_requested` and `network.account.deleted`, and the subscriptions are created at boot
(`MEDIAHUB_EVENTS_URL`).

- **Export:** the person's files, folders, shares, the reports they made and their usage.
- **Deletion:** all of it is erased, and each object is deleted in Media too.

## Configuration

Every name is in [.env.example](.env.example): the Network client (`OV_OAUTH_CLIENT_ID=media-hub`, secret, internal
URL), PostgreSQL and Valkey (written by the host's data role), Media (`MEDIAHUB_MEDIA_URL`, `MEDIAHUB_MEDIA_APP`,
`MEDIAHUB_MEDIA_APP_KEY`), Events, and the limits (`MEDIAHUB_QUOTA_BYTES`, `MEDIAHUB_MAX_FILE_BYTES`,
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
serves openvibe.download and parks openvibe.pics and openvibe.video with a 302 to `https://openvibe.network/` (each
name with its own certificate); it is installed with `ov-vhost-install`. Uploads stream through nginx unbuffered;
downloads are not buffered either.

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
- openvibe-contracts: v0.126.0
- openvibe-sdk: v0.36.0
- openvibe-shared: v2.20.3
<!-- versions:end -->
