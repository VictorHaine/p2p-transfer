# Native WebRTC Dependency Review

Status: required release-review artifact for the native WebRTC runtime dependency.

## Package Identity

- Package: `@roamhq/wrtc`
- Reviewed package version: `0.10.0`
- Dependency class: production runtime dependency
- Local pin: `package.json` pins `@roamhq/wrtc` to exact version `0.10.0` and pins the reviewed non-native runtime companions `domexception` to exact version `4.0.0` and `webidl-conversions` to exact version `7.0.0`
- Lockfile entry: `pnpm-lock.yaml` resolves `@roamhq/wrtc@0.10.0` with a `sha512` integrity value
- Installed package identity: `node_modules/@roamhq/wrtc/package.json` reports name `@roamhq/wrtc` and version `0.10.0`
- License: `BSD-2-Clause`
- Upstream repository: `git+ssh://git@github.com/WonderInventions/node-webrtc.git`
- Homepage: `https://github.com/WonderInventions/node-webrtc`
- Issue tracker: `https://github.com/WonderInventions/node-webrtc/issues`

## Why It Is Used

`@roamhq/wrtc` provides the Node WebRTC implementation used by the CLI.
The browser client uses the platform `RTCPeerConnection`; the CLI needs equivalent `RTCPeerConnection`, `RTCDataChannel`, and `RTCIceCandidate` constructors so CLI-to-browser and CLI-to-CLI transfers use the same WebRTC signaling and DataChannel protocol.

This package controls native code loading and the CLI WebRTC transport.
If it is compromised or if a platform prebuilt drifts, the CLI can load hostile native code, fail to establish DataChannels, or silently stop matching browser WebRTC behavior.

## Reviewed Install Surface

- Import surface used by this project: dynamic package root import `@roamhq/wrtc`, using the default export when present.
- Runtime constructors required by the smoke gate: `RTCPeerConnection`, `RTCDataChannel`, and `RTCIceCandidate`.
- Runtime behavior required by the smoke gate: load WebRTC through the built CLI `nativeWebRtc()` guard, instantiate two local peer connections, create an ordered DataChannel, complete local offer/answer SDP negotiation, and prove the SDP contains an application media section.
- Published files reviewed in installed metadata: `AUTHORS`, `CHANGELOG.md`, `lib`, and `types`.
- Entrypoints reviewed in installed metadata: `main` is `lib/index.js`, `types` is `types/index.d.ts`, and `browser` is `lib/browser.js`.
- Module metadata reviewed in installed metadata: `type`, `exports`, `sideEffects`, and direct `dependencies` are absent.
- Package script surface reviewed in installed metadata: only `patch`, `build`, `make-prebuilt`, `install-example`, `lint`, `test`, and `prepare` are present.
- Consumer install lifecycle hooks reviewed: `preinstall`, `install`, and `postinstall` are absent. `prepare` is present upstream but is not run during registry consumer installs.
- Build policy reviewed: `pnpm-workspace.yaml` has `strictDepBuilds: true`; `@roamhq/wrtc` is in `allowBuilds` because this native dependency is the only production package allowed to run reviewed dependency build tooling.
- Optional platform prebuilt packages reviewed: `@roamhq/wrtc-darwin-arm64@0.10.0`, `@roamhq/wrtc-darwin-x64@0.10.0`, `@roamhq/wrtc-linux-arm64@0.10.0`, `@roamhq/wrtc-linux-x64@0.10.0`, and `@roamhq/wrtc-win32-x64@0.10.0`.
- Optional non-native runtime dependencies reviewed: `domexception` is declared as `^4.0.0` upstream and is pinned directly in `package.json` to exact version `4.0.0`; `domexception` depends on `webidl-conversions` as `^7.0.0`, and this project also pins `webidl-conversions` directly to exact version `7.0.0` so consumer installs do not drift beyond the runtime attestation contract.
- Runtime consumer-install hardening reviewed: CLI WebRTC helpers load `@roamhq/wrtc` lazily after validating package metadata, and fail closed unless the resolved package graph matches `@roamhq/wrtc@0.10.0`, the current platform's reviewed `@roamhq/wrtc-*` prebuilt, `domexception@4.0.0`, and `webidl-conversions@7.0.0`, including reviewed wrapper metadata, optional prebuilt declarations, current-platform prebuilt metadata, domexception metadata, webidl-conversions metadata, dependency declarations, lifecycle-script surfaces, and exact resolved JS/native file SHA-256 evidence; the guard hashes the reviewed platform `wrtc.node` before native load, rejects root `build-*` fallback outputs, and rejects nested `node_modules/@roamhq/wrtc-*` fallback outputs under the wrapper package.
- Runtime resolved-file hash hardening reviewed: CLI WebRTC helpers fail closed unless all runtime wrapper files under `@roamhq/wrtc/lib/*.js`, the selected platform prebuilt `index.js` and `wrtc.node`, `domexception` runtime JS files, and `webidl-conversions/lib/index.js` match the reviewed relative paths and SHA-256 digests embedded in `src/cli/native-webrtc.ts`.
- Reviewed lockfile integrity for `@roamhq/wrtc@0.10.0`: `sha512-yFqQQ0EV1ZUHaphh3tmjoxPi2wzhW2vjmzoAVNRRLUjXYd2e1nvwi9TKfE2w4WNvNws/hBkouvOt23Xo9FkXkQ==`.
- Reviewed lockfile integrity for platform prebuilts: `@roamhq/wrtc-darwin-arm64@0.10.0` is `sha512-vFdi79jWuPHcnUcnuOjTvyKtmY/RI2xRQo9Y6RsIjIlYePN/7LTy00c+Ivrz4prYAPbp0oHscl7PDV64VUqGTQ==`; `@roamhq/wrtc-darwin-x64@0.10.0` is `sha512-H6852g2xYCuaR+/TrthpdMafs4bMfAUEpvRDhsIguzrK7Dz+MKpNI8MkwdqJN8W65J+7w7k+YqXIkTHe7Fz/cg==`; `@roamhq/wrtc-linux-arm64@0.10.0` is `sha512-fEuJbNjprxQG6QlFd2iqBW9x028RDSho6izVg7gyt8irdPiXWOxzOxNnYMs/B2fohBTd1wD4Qxfivl07/dCR8A==`; `@roamhq/wrtc-linux-x64@0.10.0` is `sha512-H32lK2eFg3sVb/9nkHIX5HIisxFoS82Gpesuea+zqAyRpRzSd5NpFXx28bVy9wQyRrNtj8k0bTUgEzWRzSbYCA==`; `@roamhq/wrtc-win32-x64@0.10.0` is `sha512-wEVXMvLrBizdLyrd+Zc7zb7zpwUuHUBXwrdIvI69e3i/AA8YsVYI2xo/sxk6GoQ+o8a14ONc4SStDS35TCjg+w==`.
- Reviewed lockfile integrity for optional non-native dependencies: `domexception@4.0.0` is `sha512-A2is4PLG+eeSfoTMA95/s4pvAoSo2mKtiM5jlHkAVewmiO8ISFTFKZjH7UAM1Atli/OT/7JHOrJRJiMKUZKYBw==`; `webidl-conversions@7.0.0` is `sha512-VwddBukDzu71offAQR975unBIGqfKZpM+8ZX6ySk8nYhVoo5CYaZyzt3YBvYtRtO+aoGlqxPg/B87NGVZ/fu6g==`.
- Registry source reviewed: lockfile package entries must stay registry tarballs with `sha512` integrity, not `git`, `github:`, `file:`, `link:`, `workspace:`, `http`, `https`, or custom tarball sources.

## Known Limitations

- `@roamhq/wrtc` is native code. This repo does not contain a formal independent audit certificate for the package or its prebuilts.
- Platform confidence depends on CI and release smoke coverage on Linux, macOS, and Windows for every supported Node major. A local macOS smoke run is not enough release evidence.
- The reviewed optional prebuilt set does not include Windows ARM64, Linux ARMv7, or other unsupported platforms.
- WebRTC and DataChannel correctness still depends on protocol, browser, e2e, and transfer tests. Package metadata review does not replace runtime compatibility tests.
- This dependency does not hide endpoint compromise, MDM inspection of local files before encryption or after decryption, or network-level metadata such as timing, IPs, sizes, and traffic shape.

## Monitoring And Update Process

- Dependabot must keep `@roamhq/wrtc`, `@roamhq/wrtc-*`, `domexception`, and `webidl-conversions` in the `native-webrtc-dependency` production group and excluded from the bulk production dependency group.
- GitHub dependency review must run on pull requests and fail vulnerable runtime or development dependency changes at low severity or higher.
- Release verification must run `pnpm security:audit` and `pnpm security:signatures`.
- Local, CI, Docker, and release verification must run `pnpm check:install-state` so the installed direct dependency tree matches exact `package.json` pins and `node_modules/.pnpm/lock.yaml` matches `pnpm-lock.yaml`.
- Native WebRTC dependency updates must update this artifact in the same change as the package pin and lockfile, with the changed package metadata, lifecycle hooks, optional prebuilt set, exact resolved-file SHA-256 evidence, advisories, and smoke-test impact reviewed explicitly.
- Release workflows must keep native smoke plus packed-install checks on Linux, macOS, and Windows for every supported Node major before publishing.

## Release Blockers

Release must stop if any of these are true:

- `package.json`, `pnpm-lock.yaml`, runtime dependency attestation, installed package metadata, optional prebuilt declarations, dependency declarations, lifecycle-script surfaces, current-platform prebuilt metadata, domexception metadata, webidl-conversions metadata, or reviewed resolved-file SHA-256 evidence no longer agree on `@roamhq/wrtc@0.10.0`, platform prebuilt `@roamhq/wrtc-*@0.10.0`, `domexception@4.0.0`, and `webidl-conversions@7.0.0` without an updated review.
- `@roamhq/wrtc` adds `preinstall`, `install`, or `postinstall` hooks, removes the reviewed registry-consumer install behavior, or changes to a non-registry source.
- The package name, license, repository, homepage, issue tracker, entrypoints, published files, or required constructor surface changes without an updated review.
- The optional platform prebuilt package set changes without explicit platform-support review.
- `pnpm-workspace.yaml` changes the reviewed dependency build allowlist without explicit review.
- `pnpm audit --audit-level low`, `pnpm audit signatures`, dependency review, installed-state verification, package-surface tests, native smoke, packed-install smoke, platform smoke, browser tests, e2e tests, or release-artifact verification fails.
- A new advisory, upstream compromise signal, maintainer transfer concern, native prebuilt distribution issue, or WebRTC transport weakness affects `@roamhq/wrtc` or the locked platform packages and has no reviewed mitigation.
