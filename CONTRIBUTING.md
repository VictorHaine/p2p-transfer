# Contributing

This project handles cryptography, local files, and network handshakes. Keep changes small, testable, and explicit about security impact.

## Local Setup

```sh
pnpm install --frozen-lockfile
pnpm verify:local
```

Use Node.js 22.22.3 or 24.13.1, matching the CI matrix.

## Required Checks

Before opening a pull request:

```sh
pnpm check:install-state
pnpm build
pnpm check
pnpm test:unit
pnpm smoke:native
pnpm smoke:packed
```

For release-sensitive or protocol-sensitive changes, also run:

```sh
pnpm smoke:release-artifact
pnpm smoke:docker-policy
pnpm test:e2e
pnpm test:browser
pnpm security:audit
pnpm security:signatures
```

Before creating or pushing a release tag, run the full release gate and external
release prerequisite preflight:

```sh
pnpm verify:release
GITHUB_TOKEN="$(gh auth token)" pnpm release:preflight
```

## Security Rules

- Preserve the invariants in `SECURITY.md`.
- Bump `PROTOCOL_VERSION` and `conformance/protocol-v5.json` together for wire-incompatible changes.
- Do not add install lifecycle scripts.
- Do not loosen origin, TURN, Docker, package-surface, or release-artifact checks without adding a narrower replacement.
- Do not log file names, file contents, PAKE secrets, DataChannel plaintext, raw local paths, or peer-controlled protocol text.

## Pull Requests

Include:

- What changed.
- Why it changed.
- Which checks were run.
- Any security or compatibility impact.

For vulnerability reports, do not open a public issue. Follow `SECURITY.md`.
