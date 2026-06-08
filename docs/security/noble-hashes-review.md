# Noble Hashes Dependency Review

Status: required release-review artifact for the direct hash/HKDF/HMAC dependency.

## Package Identity

- Package: `@noble/hashes`
- Reviewed package version: `2.2.0`
- Dependency class: production runtime dependency
- Local pin: `package.json` pins `@noble/hashes` to exact version `2.2.0`
- Lockfile entry: `pnpm-lock.yaml` resolves `@noble/hashes@2.2.0` with integrity `sha512-IYqDGiTXab6FniAgnSdZwgWbomxpy9FtYvLKs7wCUs2a8RkITG+DFGO1DM9cr+E3/RgADRpFjrKVaJ1z6sjtEg==`
- Installed package identity: `node_modules/@noble/hashes/package.json` reports name `@noble/hashes` and version `2.2.0`
- License: `MIT`
- Upstream repository: `git+https://github.com/paulmillr/noble-hashes.git`
- Homepage: `https://paulmillr.com/noble/`

## Why It Is Used

`@noble/hashes` provides the SHA-256, HMAC-SHA256, HKDF-SHA256, and hex encoding primitives used by `src/shared/security.ts` and `src/shared/hash.ts`.
Those primitives derive session subkeys from CPace output, authenticate signaling messages, authenticate pair decisions, derive the SAS, hash sealed manifests for consent binding, and verify file and resume-prefix integrity.

This package controls the local cryptographic transcript and integrity boundary: if it is compromised, two peers may derive wrong keys, accept forged signaling, compute misleading SAS values, or trust incorrect transfer hashes.

## Reviewed Install Surface

- Import surface used by this project: `@noble/hashes/hkdf.js`, `@noble/hashes/hmac.js`, `@noble/hashes/sha2.js`, and `@noble/hashes/utils.js`.
- Package exports reviewed: `.`, `./hkdf.js`, `./hmac.js`, `./sha2.js`, `./utils.js`, plus the other exported hash/KDF modules exposed by upstream.
- Entrypoints reviewed in installed metadata: `type` is `module`, `main` is `index.js`, `module` is `index.js`, and `types` is `index.d.ts`.
- Published files reviewed in installed metadata: `*.js`, `*.js.map`, `*.d.ts`, `*.d.ts.map`, and `src`.
- Side-effect metadata reviewed: `sideEffects` is `false`.
- Consumer install lifecycle hooks reviewed: `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, and `prepublishOnly` are absent.
- Runtime dependency declarations reviewed: direct `dependencies`, `optionalDependencies`, and `peerDependencies` are absent in installed metadata.
- Build policy reviewed: `pnpm-workspace.yaml` has `strictDepBuilds: true`; `@noble/hashes` is not in `allowBuilds`, so it must not require dependency build scripts in this project.
- Registry source reviewed: lockfile package entries must stay registry tarballs with `sha512` integrity, not `git`, `github:`, `file:`, `link:`, `workspace:`, `http`, `https`, or custom tarball sources.
- Runtime consumer-install hardening reviewed: CLI send and receive fail closed unless direct `@noble/hashes@2.2.0` package metadata, dependency declarations, consumer lifecycle-hook policy, and HKDF/HMAC/SHA-2 import surfaces match this artifact.

## Known Limitations

- Package metadata review does not replace cryptographic review. Protocol tests for HKDF/HMAC/SHA-256 use, authenticated signaling, PAKE confirmation, encrypted payloads, resume-prefix verification, and file-hash verification must continue to pass before release.
- This repo does not contain a formal independent audit certificate for `@noble/hashes@2.2.0`.
- The package exports many algorithms this project does not use. This project must continue importing only the reviewed HKDF, HMAC, SHA-2, and utility entrypoints unless a separate protocol review changes that decision.

## Monitoring And Update Process

- Dependabot must keep `@noble/hashes` in a dedicated production update group and exclude it from the bulk production dependency group.
- Release verification must run `pnpm security:audit` and `pnpm security:signatures`.
- Daily scheduled dependency integrity monitoring must run `pnpm security:audit` and `pnpm security:signatures` on unchanged `main` so new advisories or registry signature failures are surfaced before the next code change or release tag.
- Local, CI, Docker, and release verification must run `pnpm check:install-state` so the installed direct dependency tree matches exact `package.json` pins and `node_modules/.pnpm/lock.yaml` matches `pnpm-lock.yaml`.
- `@noble/hashes` updates must update this artifact in the same change as the package pin and lockfile, with changed package metadata, exported API, lifecycle hooks, advisories, and protocol-test impact reviewed explicitly.

## Release Blockers

Release must stop if any of these are true:

- `package.json`, `pnpm-lock.yaml`, runtime dependency attestation, installed package metadata, reviewed dependency declarations, consumer lifecycle-hook policy, or reviewed import surfaces no longer agree on `@noble/hashes@2.2.0` without an updated review.
- `@noble/hashes` adds `preinstall`, `install`, `postinstall`, `prepare`, or `prepublishOnly` hooks, requires build-script allowlisting, or changes to a non-registry source.
- The package name, license, repository, homepage, exports, published files, or used cryptographic import surface changes without an updated review.
- `pnpm audit --audit-level low`, `pnpm audit signatures`, dependency review, installed-state verification, package-surface tests, security protocol tests, or release-artifact verification fails.
