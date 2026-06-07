# Build Toolchain Native Review

Status: required release-review artifact for native and wasm-capable build tooling in the web release build path.

## Scope

The release build runs `vite build` after the Node TypeScript build.
That path executes Vite and may load native or wasm packages through esbuild, Rolldown, and Lightning CSS.
These packages do not ship in the runtime npm package surface as application code, but they are trusted during release artifact creation and therefore belong in the supply-chain review set.

## Reviewed Package Identity

- Direct build tool: `vite@8.0.14`
- Vite build transformer peer/tool: `esbuild@0.28.0`
- Vite bundler dependency: `rolldown@1.0.2`
- Vite CSS dependency: `lightningcss@1.32.0`
- Lockfile integrity reviewed for `vite@8.0.14`: `sha512-s4BJJ+5y1pYL6Otw51FHhVJQhPnuRinKig64g/1+EUNaJsd3gCKdD31IPFvswUgW9/60QT9oFHbZHbQK5imcxw==`
- Lockfile integrity reviewed for `esbuild@0.28.0`: `sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==`
- Lockfile integrity reviewed for `rolldown@1.0.2`: `sha512-oZx5zVDtVB44AW3eaifgDml1gWRDZGvjcfdxonE4swNPG98PrrXjaO/KrnUjzlMnztCCRVlUueA1kCXhARGk6g==`
- Lockfile integrity reviewed for `lightningcss@1.32.0`: `sha512-NXYBzinNrblfraPGyrbPoD19C1h9lfI/1mzgWYvXUTe414Gz/X1FD2XBZSZM7rRTrMA8JL3OtAaGifrIKhQ5yQ==`

## Reviewed Metadata

- `vite@8.0.14`: MIT, package repository `git+https://github.com/vitejs/vite.git`, package directory `packages/vite`, `type: module`, bin `vite: bin/vite.js`, published files `bin`, `dist`, `misc/**/*.js`, `client.d.ts`, and `types`.
- `vite@8.0.14` dependencies reviewed in the release build path: `lightningcss:^1.32.0`, `rolldown:1.0.2`, `postcss:^8.5.15`, `picomatch:^4.0.4`, and `tinyglobby:^0.2.16`; `fsevents` remains an optional macOS filesystem watcher dependency.
- `esbuild@0.28.0`: MIT, repository `git+https://github.com/evanw/esbuild.git`, main `lib/main.js`, bin `bin/esbuild`, and consumer lifecycle hook `postinstall: node install.js`.
- `rolldown@1.0.2`: MIT, repository `git+https://github.com/rolldown/rolldown.git`, package directory `packages/rolldown`, `type: module`, main `./dist/index.mjs`, bin `./bin/cli.mjs`, and published files `bin`, `cli`, `dist`, excluding `dist/*.node`.
- `lightningcss@1.32.0`: MPL-2.0, repository `https://github.com/parcel-bundler/lightningcss.git`, main `node/index.js`, published files `node/*.js`, `node/*.mjs`, `node/*.d.ts`, and `node/*.flow`.

## Reviewed Build Script Policy

- `pnpm-workspace.yaml` has `strictDepBuilds: true`.
- The only allowed dependency build scripts are `@roamhq/wrtc` and `esbuild`.
- `esbuild` is allowed because its registry consumer install uses `postinstall: node install.js` to select the reviewed platform binary package for the release build tool.
- `rolldown` and `lightningcss` are not in `allowBuilds`; their registry consumer install must not require package lifecycle execution in this project.
- Any new package in `allowBuilds`, any removal of `strictDepBuilds: true`, or any change to `esbuild` lifecycle hooks requires this artifact to be updated in the same change.

## Reviewed Native And Wasm Package Sets

- esbuild optional binary packages reviewed: `@esbuild/aix-ppc64@0.28.0`, `@esbuild/android-arm@0.28.0`, `@esbuild/android-arm64@0.28.0`, `@esbuild/android-x64@0.28.0`, `@esbuild/darwin-arm64@0.28.0`, `@esbuild/darwin-x64@0.28.0`, `@esbuild/freebsd-arm64@0.28.0`, `@esbuild/freebsd-x64@0.28.0`, `@esbuild/linux-arm@0.28.0`, `@esbuild/linux-arm64@0.28.0`, `@esbuild/linux-ia32@0.28.0`, `@esbuild/linux-loong64@0.28.0`, `@esbuild/linux-mips64el@0.28.0`, `@esbuild/linux-ppc64@0.28.0`, `@esbuild/linux-riscv64@0.28.0`, `@esbuild/linux-s390x@0.28.0`, `@esbuild/linux-x64@0.28.0`, `@esbuild/netbsd-arm64@0.28.0`, `@esbuild/netbsd-x64@0.28.0`, `@esbuild/openbsd-arm64@0.28.0`, `@esbuild/openbsd-x64@0.28.0`, `@esbuild/openharmony-arm64@0.28.0`, `@esbuild/sunos-x64@0.28.0`, `@esbuild/win32-arm64@0.28.0`, `@esbuild/win32-ia32@0.28.0`, and `@esbuild/win32-x64@0.28.0`.
- Rolldown native or wasm packages reviewed: `@rolldown/binding-android-arm64@1.0.2`, `@rolldown/binding-darwin-arm64@1.0.2`, `@rolldown/binding-darwin-x64@1.0.2`, `@rolldown/binding-freebsd-x64@1.0.2`, `@rolldown/binding-linux-arm-gnueabihf@1.0.2`, `@rolldown/binding-linux-arm64-gnu@1.0.2`, `@rolldown/binding-linux-arm64-musl@1.0.2`, `@rolldown/binding-linux-ppc64-gnu@1.0.2`, `@rolldown/binding-linux-s390x-gnu@1.0.2`, `@rolldown/binding-linux-x64-gnu@1.0.2`, `@rolldown/binding-linux-x64-musl@1.0.2`, `@rolldown/binding-openharmony-arm64@1.0.2`, `@rolldown/binding-wasm32-wasi@1.0.2`, `@rolldown/binding-win32-arm64-msvc@1.0.2`, and `@rolldown/binding-win32-x64-msvc@1.0.2`.
- Lightning CSS native packages reviewed: `lightningcss-android-arm64@1.32.0`, `lightningcss-darwin-arm64@1.32.0`, `lightningcss-darwin-x64@1.32.0`, `lightningcss-freebsd-x64@1.32.0`, `lightningcss-linux-arm-gnueabihf@1.32.0`, `lightningcss-linux-arm64-gnu@1.32.0`, `lightningcss-linux-arm64-musl@1.32.0`, `lightningcss-linux-x64-gnu@1.32.0`, `lightningcss-linux-x64-musl@1.32.0`, `lightningcss-win32-arm64-msvc@1.32.0`, and `lightningcss-win32-x64-msvc@1.32.0`.

## Monitoring And Update Process

- Dependabot must keep Vite, esbuild, esbuild platform binaries, Rolldown, Rolldown native/wasm bindings, Lightning CSS, and Lightning CSS native packages in the dedicated `build-toolchain-dependencies` update group and excluded from the bulk development dependency group, so release build-toolchain changes cannot hide in unrelated dev dependency batches.
- Release verification must run `pnpm check:install-state`, `pnpm build`, `pnpm smoke:release-artifact`, `pnpm security:audit`, and `pnpm security:signatures`.
- Scheduled dependency integrity monitoring must keep running `pnpm security:audit` and `pnpm security:signatures` on unchanged `main`.
- Build-toolchain updates must update this artifact in the same change as the package pin and lockfile, with changed package metadata, lifecycle hooks, optional native/wasm package set, advisories, and release-build impact reviewed explicitly.

## Known Limitations

- This repo does not contain a formal independent audit certificate for Vite, esbuild, Rolldown, Lightning CSS, their native binaries, or their wasm bindings.
- This review covers release build-time trust. It does not make build tools part of the runtime trust boundary after the verified tarball is produced.
- Release confidence still depends on pinned lockfile integrity, registry signatures, advisory audit, packed artifact verification, and browser/e2e smoke tests.

## Release Blockers

Release must stop if any of these are true:

- `package.json`, `pnpm-lock.yaml`, installed package metadata, or this artifact no longer agree on `vite@8.0.14`, `esbuild@0.28.0`, `rolldown@1.0.2`, or `lightningcss@1.32.0`.
- The `allowBuilds` list changes, `strictDepBuilds: true` is removed, or any build tool other than `@roamhq/wrtc` or `esbuild` requires dependency lifecycle execution.
- The reviewed esbuild, Rolldown, or Lightning CSS optional native/wasm package set changes without explicit review.
- Vite, esbuild, Rolldown, or Lightning CSS package name, license, repository, entrypoints, published files, lifecycle hooks, or native/wasm loader behavior changes without an updated review.
- `pnpm check:install-state`, `pnpm build`, `pnpm smoke:release-artifact`, `pnpm audit --audit-level low`, `pnpm audit signatures`, dependency review, package-surface tests, or browser/e2e tests fail.
