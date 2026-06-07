# CPace Dependency Review

Status: required release-review artifact for the CPace PAKE dependency.

## Package Identity

- Package: `@cipherman/pake-js`
- Reviewed package version: `0.1.1`
- Dependency class: production runtime dependency
- Local pin: `package.json` pins `@cipherman/pake-js` to exact version `0.1.1`
- Lockfile entry: `pnpm-lock.yaml` resolves `@cipherman/pake-js@0.1.1` with a `sha512` integrity value
- Installed package identity: `node_modules/@cipherman/pake-js/package.json` reports name `@cipherman/pake-js` and version `0.1.1`
- License: `MIT`
- Upstream repository: `git+https://github.com/alicommit-malp/pake-js.git`

## Why It Is Used

`@cipherman/pake-js` provides the CPace implementation used by `src/shared/security.ts`.
The project calls `cpace.ristretto255.init` to create the local PAKE share and `cpace.ristretto255.deriveIskInitiatorResponder` to derive the shared PAKE output from the full transfer code and session id.
That output is then expanded into signaling-authentication, manifest, control, and bulk-transfer keys.

This package controls the untrusted-signaling trust boundary: if CPace is compromised, two peers may derive incorrect keys, accept a man-in-the-middle path, or fail to protect encrypted transfer metadata and payloads.

## Reviewed Install Surface

- Import surface used by this project: package root import `@cipherman/pake-js`, using the exported `cpace` namespace and the `ristretto255` CPace API.
- Package exports reviewed: `.`, `./spake2plus`, and `./cpace`; this project only depends on CPace behavior.
- Entrypoints reviewed in installed metadata: `type` is `module`, `main` is `./dist/index.cjs`, and `types` is `./dist/index.d.ts`.
- Published files reviewed in installed metadata: `dist`, `README.md`, `SECURITY.md`, `THREAT_MODEL.md`, `CHANGELOG.md`, and `LICENSE`.
- Side-effect metadata reviewed: `sideEffects` is `false`.
- Consumer install lifecycle hooks reviewed: `preinstall`, `install`, `postinstall`, `prepare`, and `prepublish` are absent. `prepublishOnly` is present upstream but is not run during consumer installs.
- Build policy reviewed: `pnpm-workspace.yaml` has `strictDepBuilds: true`; `@cipherman/pake-js` is not in `allowBuilds`, so it must not require dependency build scripts in this project.
- Direct runtime dependencies reviewed: `@cipherman/pake-js@0.1.1` and `@noble/curves@1.9.7`.
- Package runtime dependency declaration reviewed: `@noble/curves` is declared as `^1.6.0` upstream.
- Consumer resolution hardening reviewed: this package also declares `@noble/curves@1.9.7` as a direct exact production dependency so normal consumer installers resolve the reviewed CPace curve implementation instead of floating only through the upstream `^1.6.0` range.
- Locked crypto dependency reviewed: `@noble/curves@1.9.7`, with `@noble/hashes@1.8.0` in the resolved CPace dependency set.
- Reviewed lockfile integrity for `@cipherman/pake-js@0.1.1`: `sha512-iutxMCmRXYacl3fc19SKFisk1sRD1FNQi7+GWPlnQnFit6l3sUagYOCU2IgRPD8MF3s1HwnkSpqARFUp04+GVQ==`.
- Reviewed lockfile integrity for CPace transitives: `@noble/curves@1.9.7` is `sha512-gbKGcRUYIjA3/zCCNaWDciTMFI0dCkvou3TL8Zmy5Nc7sJ47a0jtOeZoTaMxkuqRo9cRhjOdZJXegxYE5FN/xw==`; `@noble/hashes@1.8.0` is `sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==`.
- Registry source reviewed: lockfile package entries must stay registry tarballs with `sha512` integrity, not `git`, `github:`, `file:`, `link:`, `workspace:`, `http`, `https`, or custom tarball sources.
- CPace vector gate reviewed: `test/cpace-vectors.test.ts` asserts draft-irtf-cfrg-cpace-20 Appendix B.3 bytes for `generator_string`, SHA-512 hash output, encoded generator `g`, `Ya`, `Yb`, shared point `K`, and initiator/responder `ISK_IR` using deterministic test-only helpers from `@cipherman/pake-js/cpace`.

## Known Limitations

- `@cipherman/pake-js` is a third-party cryptography dependency at `0.1.1`; treat all updates as security-sensitive, not routine dependency churn.
- This repo does not contain a formal independent audit certificate for `@cipherman/pake-js`.
- The upstream package declares `@noble/curves` with a semver range; this repo keeps `@noble/curves@1.9.7` as a direct exact dependency, and the lockfile plus installed-state checks are part of the reviewed surface.
- The package exposes SPAKE2+ as well as CPace. This project must continue to use only the CPace path unless a separate protocol review changes that decision.
- Package metadata review does not replace protocol tests. CPace vector tests, CPace key agreement, confirmation, authenticated signaling, and encrypted payload tests must continue to pass before release.

## Monitoring And Update Process

- Dependabot must keep `@cipherman/pake-js` in the `critical-pake-dependency` production group and keep `@noble/curves` in the direct crypto dependency group; both must be excluded from the bulk production dependency group.
- GitHub dependency review must run on pull requests and fail vulnerable runtime or development dependency changes at low severity or higher.
- Release verification must run `pnpm security:audit` and `pnpm security:signatures`.
- Local, CI, Docker, and release verification must run `pnpm check:install-state` so the installed direct dependency tree matches exact `package.json` pins and `node_modules/.pnpm/lock.yaml` matches `pnpm-lock.yaml`.
- CPace dependency updates must update this artifact in the same change as the package pin and lockfile, with the changed package metadata, exported API, lifecycle hooks, transitive dependency set, advisories, and protocol-test impact reviewed explicitly.
- Emergency vulnerability bumps should pin the oldest reviewed patched version that satisfies the advisory while preserving the configured pnpm minimum-release-age policy unless the release owner records a security exception.

## Release Blockers

Release must stop if any of these are true:

- `package.json`, `pnpm-lock.yaml`, or installed package metadata no longer agree on `@cipherman/pake-js@0.1.1` and direct `@noble/curves@1.9.7` without an updated review.
- `@cipherman/pake-js` adds `preinstall`, `install`, `postinstall`, or `prepare` hooks, requires build-script allowlisting, or changes to a non-registry source.
- The package name, license, repository, exports, published files, or CPace API surface changes without an updated review.
- The lockfile adds, removes, or changes the CPace package's crypto dependencies without explicit review.
- `pnpm audit --audit-level low`, `pnpm audit signatures`, dependency review, installed-state verification, package-surface tests, CPace vector/protocol tests, or release-artifact verification fails.
- A new advisory, upstream compromise signal, maintainer transfer concern, or cryptographic weakness affects `@cipherman/pake-js`, CPace Ristretto255, or the locked noble crypto dependencies and has no reviewed mitigation.
