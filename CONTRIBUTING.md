# Contributing to .snapframe

Thanks for wanting to help! Here's everything you need to get started.

## Running Locally

```bash
git clone https://github.com/soreavis/snapframe.git
cd snapframe
npm install
npx playwright install chromium
```

Then pick one:

```bash
npm start              # web UI at http://localhost:3005
npm run cli -- --help  # headless CLI, no server needed
npm link               # installs `snapframe` globally so you can run it from anywhere
```

## Submitting a PR

1. Fork the repo and create a branch (`feature/your-thing` or `fix/your-bug`).
2. Make your changes and test them locally.
3. Keep commits small and use conventional commit messages (`feat:`, `fix:`, `docs:`, etc.).
4. Open a pull request with a clear description of what changed and why.

## Architecture

`.snapframe` has **one source of truth** and **two frontends**:

```
lib/capture.js      ← all Playwright + Sharp + validation logic lives here
├─ server.js        ← thin Express/SSE wrapper (web UI)
└─ bin/snapframe.js ← thin argv wrapper (CLI)
```

When adding a feature:

- **Behavior change** (new capture option, validation rule, consent selector, etc.) → edit `lib/capture.js`. Both frontends pick it up automatically.
- **Web UI change** → edit `public/index.html` and the route in `server.js` that feeds it.
- **CLI change** → edit `bin/snapframe.js` — flag parsing, file I/O, exit codes.

**Do not** put Playwright or Sharp calls in `server.js` or `bin/snapframe.js`. If you catch yourself writing one, it belongs in the library.

## Code Style

- Plain JavaScript, no frameworks — keep it simple.
- Small functions, small files.
- Use `const` and `let`, never `var`.
- Descriptive variable names over comments.

## Reporting Issues

Open an issue and include:

- What you expected to happen.
- What actually happened.
- Steps to reproduce.
- Your Node.js version and OS.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md).

That's it. Every contribution matters — thank you!
