# .snapframe

[![CI](https://github.com/soreavis/snapframe/actions/workflows/ci.yml/badge.svg)](https://github.com/soreavis/snapframe/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green?logo=nodedotjs&logoColor=white)

**Capture any webpage in every viewport with one click.**

![.snapframe demo](demo.gif)

---

## Why .snapframe?

Stop resizing your browser manually. Paste a URL, pick your viewports, and get pixel-perfect screenshots in seconds.

## Features

- **Multi-viewport capture** — desktop, tablet, mobile in one go
- **Social presets** — YouTube, LinkedIn, X, Facebook, Instagram ready
- **PNG, JPEG, WebP** — download in any format, convert on the fly
- **PDF export** — full-page pageless PDF with a single click
- **Batch mode** — capture multiple viewports at once
- **Cookie cleanup** — auto-dismiss consent banners and overlays
- **Animation reveal** — force-show scroll-triggered hidden elements
- **Live preview** — tabbed results with sticky toolbar
- **Runs locally** — your URLs never leave your machine

## Quick Start

```bash
# 1. Clone
git clone https://github.com/soreavis/snapframe.git
cd snapframe

# 2. Install
npm install && npx playwright install chromium

# 3. Run
npm start
```

Open `http://localhost:3000` and start capturing.

## Social Presets

| Preset | Viewport | Use case |
|--------|----------|----------|
| YT Banner | 2560 x 1440 | YouTube channel art |
| YT Thumb | 1280 x 720 | YouTube thumbnail |
| LinkedIn Post | 1200 x 627 | LinkedIn feed image |
| LinkedIn Cover | 1584 x 396 | LinkedIn profile banner |
| X Post | 1600 x 900 | Twitter/X card image |
| X Header | 1500 x 500 | Twitter/X profile banner |
| FB Cover | 820 x 312 | Facebook cover photo |
| FB Post | 1200 x 630 | Facebook feed image |
| IG Post | 1080 x 1080 | Instagram square post |
| IG Story | 1080 x 1920 | Instagram story |

## Tech Stack

| Tool | Role |
|------|------|
| Playwright | Browser automation |
| Sharp | Image conversion (WebP, JPEG) |
| Express | Local web server |
| Vanilla JS | Frontend — no frameworks |

## Contributing

We'd love your help! Check out [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE) — Built by [Julian Soreavis](https://github.com/soreavis) with [Claude Code](https://claude.ai/claude-code)
