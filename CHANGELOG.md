# Changelog

What changed in OpenVibe.MediaHub, newest first. Each site also publishes its patch notes at /updates.

## Unreleased

- openvibe.pics and openvibe.video are parked: their vhosts answer 302 to https://openvibe.network/ and proxy
  nothing. The app no longer has "coming" pages or host-based brand handling.

## 0.1.0 — 2026-10-08

- openvibe.download v1, a private drive. Account-only uploads go into OpenVibe.Media: a plain form, or resumable
  parts. Files and folders are private, with per-person limits.
- Share links that expire, need a signed-in downloader and can name accounts (matched by subject; unknown names refused).
- Reports, suspension and a staff queue.
- Sandboxed attachment downloads.
- openvibe.pics and openvibe.video answer with honest "coming" pages.
- Account export and deletion (ADR-033) with openvibe-sdk/account-data.
- Pins: openvibe-contracts v0.118.0, openvibe-sdk v0.36.0, openvibe-shared v2.15.0.
