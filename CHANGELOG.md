# Changelog

What changed in OpenVibe.MediaHub, newest first. Each site also publishes its patch notes at /updates.

## Unreleased

- openvibe.video's search basics (2026-10-20). A watch page nobody wrote about gets a description of its own (who,
  how long, when, its first words) instead of the site tagline. A recording under two minutes with nothing written
  about it is noindex and out of the sitemap: 118 of 785 were under a minute, mostly test streams. The sitemap lists
  every recording and clip (it stopped at 150 of each) with a video entry each (openvibe-shared 4.5.0) and is kept
  ten minutes. Structured data and the sitemap name Media's file with `?raw=1`, since Media answers crawlers a page
  otherwise.
- MediaHub reaches OpenVibe.Media with its Network service token (audience `openvibe.media`, grants
  `media.object.upload` and `media.object.read` on namespace `media-hub`). `MEDIAHUB_MEDIA_APP_KEY` is gone
  (compatibility register C-71).
- OpenVibe.Video step A: openvibe.video now serves public, read-only watch pages for OpenVibe.Live's stream
  recordings and clips (`/v/:id`, `/c/:id`, `/@:username`, WebVTT captions and chapters), reading Live's public
  JSON API server-side, signed out. No uploads and no new storage.
- OpenVibe.Video step B: the VOD watch page now shows a chat replay of the stream (read from OpenVibe.Chat,
  oldest first, the first 1,000 messages) and read-only comments with the OpenVibe.Community thread link, plus the
  `MEDIAHUB_CHAT_URL` setting.
- OpenVibe.Video step C: playlists. Signed-in people can save recordings and clips into playlists (100 playlists per
  person, 500 items each), share them by link (public/unlisted), and watch them back with the `?list=` up-next flow.
  Sign-in now works on the video host with its own callback URI, and the playlists are part of account export and
  deletion.
- openvibe.pics is still parked: its vhost answers 302 to https://openvibe.network/ and proxies nothing. The app
  no longer has "coming" pages or host-based brand handling.

## 0.1.0 — 2026-10-08

- openvibe.download v1, a private drive. Account-only uploads go into OpenVibe.Media: a plain form, or resumable
  parts. Files and folders are private, with per-person limits.
- Share links that expire, need a signed-in downloader and can name accounts (matched by subject; unknown names refused).
- Reports, suspension and a staff queue.
- Sandboxed attachment downloads.
- openvibe.pics and openvibe.video answer with honest "coming" pages.
- Account export and deletion (ADR-033) with openvibe-sdk/account-data.
- Pins: openvibe-contracts v0.118.0, openvibe-sdk v0.36.0, openvibe-shared v2.15.0.
