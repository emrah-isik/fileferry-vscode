# Contributing to FileFerry

Thanks for taking the time. Bug reports and small, focused pull requests are both very
welcome — FileFerry's first external contribution was a one-line fix that turned out to
close three bugs at once.

## Reporting a bug

Open an issue with:

- What you did, what happened, what you expected
- Your OS (Windows / macOS / Linux) and whether the server is SFTP, FTP, or FTPS
- The relevant lines from the **FileFerry** output channel (`View → Output → FileFerry`)

Please redact hostnames, usernames, and anything secret-shaped before pasting logs.

## Getting set up

```sh
npm ci
```

Press `F5` in VS Code to launch an Extension Development Host with FileFerry loaded.

## Before you open a pull request

Run all three. CI runs exactly these on **Ubuntu and Windows**, and both must pass:

```sh
npm test          # unit tests (jest)
npx tsc --noEmit  # typecheck
npm run lint      # eslint
```

There is also an opt-in integration suite that talks to a real SFTP container. It is not
part of `npm test` and CI does not run it:

```sh
npm run test:integration
```

## Conventions

**Write the test first.** This project works test-first: add a failing test that
demonstrates the bug or describes the feature, watch it fail, then make it pass. A pull
request that changes behaviour without a test will usually get a request for one — though
if you've sent a small fix and would rather not wrestle with the harness, say so and a
maintainer will add the test for you. Don't let it stop you contributing.

**Never hardcode a path separator.** This is the single most common source of bugs here.
`path.relative()` and `path.join()` return `\`-separated paths on Windows, and a backslash
is a *legal filename character* on Linux and macOS. So:

- In source: normalise with `.split(path.sep).join('/')` when a path is about to be
  compared against a glob, matched against a mapping, or turned into a **remote** path.
  Remote paths are always `/`-separated. Never use a blanket `.replace(/\\/g, '/')`.
- In tests: derive expectations from the same call the source makes (`path.join`,
  `path.resolve`, `path.normalize`) rather than writing a `/`-separated literal. A test
  that hardcodes `/` passes on Linux and fails on Windows.

**Webview code has no automated tests.** Anything under `webview-ui/` (plain JS + CSS, no
bundler) must be checked by hand in the Extension Development Host. Mention in the PR what
you exercised.

**Naming.** Spell words out. `response`, not `resp`; `matches`, not `m`. Loop counters
(`i`, `j`) and well-known acronyms (`id`, `url`, `db`) are fine.

**Commits.** Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `ci:`, `docs:`,
`chore:`. Explain *why* in the body, not just what.

**Don't bump the version or edit `CHANGELOG.md`.** Releases are cut by the maintainer;
changes accumulate on `main` and get a version at release time. You'll be credited in the
changelog entry.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | Extension host code (TypeScript) |
| `src/test/` | Jest unit tests, mirroring `src/` |
| `webview-ui/` | Settings/history panels — plain JS + CSS, no bundler, no tests |
| `schema/fileferry-schema.json` | JSON Schema for `.vscode/fileferry.json` |
| `docs/CONFIG.md` | Reference for every config field |

If you add or change a field on `ProjectServer` / `ProjectConfig`, update **both** the
schema and `docs/CONFIG.md`.

## Security

Please don't open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
