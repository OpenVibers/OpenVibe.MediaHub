# OpenVibe.MediaHub

> Your files, shared on your terms.

**Status:** alpha. One service behind three domains: **openvibe.download** (a private drive, live in v1),
**openvibe.pics** and **openvibe.video** (honest "coming" pages: no uploads until the safety tooling exists).
**Port:** 4990 · **Service id:** `media-hub` · **Env prefix:** `MEDIAHUB` · **License:** AGPL-3.0.

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
| `/` | anyone | openvibe.download's home: what it is, the safety rules, sign in. On openvibe.pics and openvibe.video, their "coming" pages |
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

## Deploy

`sudo ovhost deploy media-hub` on the host (unit [deploy/systemd/openvibe-media-hub.service](deploy/systemd/openvibe-media-hub.service),
env `/etc/openvibe/media-hub.env`). The vhost [deploy/nginx/openvibe.download.conf](deploy/nginx/openvibe.download.conf)
serves all three domains, each with its own certificate, and is installed with `ov-vhost-install`. Uploads stream
through nginx unbuffered; downloads are not buffered either.

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
- openvibe-contracts: v0.118.0
- openvibe-sdk: v0.36.0
- openvibe-shared: v2.15.0
<!-- versions:end -->
