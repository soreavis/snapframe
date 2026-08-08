# Changelog

All notable changes to this project are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `-h` now shows help instead of setting `--height`. It previously consumed the next argument, so a bare `snapframe -h` set the height to `Number(undefined)` — `NaN` — and carried on. `--height` is unchanged as the long form; scripts passing `-h 900` must switch to `--height 900`.

### Fixed

- Help text lists `--output-dir` and the `--fullpage` alias, which the parser accepted but never documented. The README points at `--help` as the full flag list, so the omission made that claim false.

### Added
- Headless CLI (`snapframe`) for scripting and agentic tool usage — single capture, multi-viewport batch, PDF, and `serve` subcommand.
- Built-in preset names for the CLI (`yt-thumb`, `linkedin-post`, `desktop`, `mobile`, etc.) matching the web UI's social presets.
- `lib/capture.js` — transport-agnostic core shared by the HTTP server and CLI.
- `--strip` flag (CLI) / `strip=true` query param (server) — aggressive chrome removal for clean content screenshots. Hides page `<header>` and `<nav>`, AccessiBe / UserWay / EqualWeb accessibility widgets, Intercom / Drift / Crisp / Tawk / HubSpot / Tidio / Zendesk / LiveChat / Facebook Messenger chat widgets, and floating back-to-top / CTA buttons. Composes with `--clean`.

### Changed
- `server.js` refactored into a thin Express/SSE wrapper around `lib/capture.js`. API surface and frontend behavior are unchanged.
- Port prompt on startup is skipped when stdin is non-interactive (CI / piped), defaulting to `3005`.

## [1.0.0] - 2026-03-15

### Added
- Multi-viewport capture — desktop, tablet, mobile in one go
- Social presets — YouTube, LinkedIn, X, Facebook, Instagram ready
- PNG, JPEG, WebP output — download in any format, convert on the fly
- PDF export — full-page pageless PDF with a single click
- Batch mode — capture multiple viewports at once
- Cookie cleanup — auto-dismiss consent banners and overlays
- Animation reveal — force-show scroll-triggered hidden elements
- Live preview — tabbed results with sticky toolbar
- Local-only — your URLs never leave your machine

[Unreleased]: https://github.com/soreavis/snapframe/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/soreavis/snapframe/releases/tag/v1.0.0
