# Contributing to .snapframe

Thanks for wanting to help! Here's everything you need to get started.

## Running Locally

```bash
git clone https://github.com/soreavis/snapframe.git
cd snapframe
npm install
npx playwright install chromium
npm start
```

The app runs at `http://localhost:3000` by default.

## Submitting a PR

1. Fork the repo and create a branch (`feature/your-thing` or `fix/your-bug`).
2. Make your changes and test them locally.
3. Keep commits small and use conventional commit messages (`feat:`, `fix:`, `docs:`, etc.).
4. Open a pull request with a clear description of what changed and why.

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
