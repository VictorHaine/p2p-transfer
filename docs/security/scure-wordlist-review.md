# Scure Wordlist Dependency Review

Package: `@scure/bip39`
Reviewed package version: `2.2.0`
Lockfile entry: `pnpm-lock.yaml` resolves `@scure/bip39@2.2.0` with integrity `sha512-T/Bj/YvYMNkIPq6EENO6/rcs2e7qTNuyoUXf0KBFDmp0ZDu0H2X4Lq6yC3i0c8PcWkov5EbW+yQZZbdMmk154A==`; transitive wordlist dependency `@scure/base@2.2.0` with integrity `sha512-b8XEupJibegiXV+tDUseI8oLQc8ei3d/4Jkb2RpbHh3MfE054ov3uIz2dhFkB3FI8iwYkEh0gGCApkrYggkPNg==`.

This package supplies `@scure/bip39/wordlists/english.js`, which controls short-code generation and validation in `src/shared/wordlist.ts`.

Reviewed package metadata:
- `@scure/bip39`: MIT, ESM, `main`/`module` `index.js`, `types` `index.d.ts`, `sideEffects: false`, repository `git+https://github.com/paulmillr/scure-bip39.git`, homepage `https://paulmillr.com/noble/#scure`.
- `@scure/bip39` runtime dependencies: `@noble/hashes@2.2.0` and `@scure/base@2.2.0`.
- `@scure/base`: MIT, ESM, `main`/`module` `index.js`, `types` `index.d.ts`, `sideEffects: false`, repository `git+https://github.com/paulmillr/scure-base.git`.
- Consumer install lifecycle hooks reviewed: `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, and `prepublishOnly` are absent for both packages.

Runtime consumer-install hardening reviewed: CLI send and receive fail closed unless `@scure/bip39` and `@scure/base` package metadata and exact runtime-file SHA-256 evidence match `src/cli/crypto-dependencies.ts`. The reviewed runtime files are `@scure/bip39/wordlists/english.js` and `@scure/base/index.js`. The CLI must run this attestation before dynamically importing the transfer-code wordlist module, parsing supplied transfer codes, generating receive codes, opening send files, creating receive output directories, or connecting to signaling.

This repo does not contain a formal independent audit certificate for `@scure/bip39@2.2.0` or `@scure/base@2.2.0`. Treat updates as security-sensitive because code generation and validation depend on the wordlist contents and package import surface.

Dependabot must keep `@scure/bip39` and `@scure/base` in the `wordlist-code-dependency` production group and exclude them from the bulk production dependency group.
Daily scheduled dependency integrity monitoring must run `pnpm security:audit` and `pnpm security:signatures` on unchanged `main` so new advisories or registry signature failures are surfaced before the next code change or release tag.

Release must stop if any of these are true:
- `@scure/bip39` or `@scure/base` package identity, metadata, dependency declarations, exports, lockfile integrity, or reviewed resolved-file SHA-256 evidence no longer agree.
- Either package adds `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, or `prepublishOnly` hooks.
- The CLI statically imports `@scure/bip39` wordlist code before `assertReviewedCryptoDependencies()`.
- `pnpm audit --audit-level low`, `pnpm audit signatures`, scheduled dependency integrity monitoring, dependency review, installed-state verification, package-surface tests, transfer-code tests, or release-artifact verification fails.
