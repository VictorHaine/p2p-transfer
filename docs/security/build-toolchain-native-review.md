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

## Reviewed Optional Native And Wasm Lockfile Integrities

- Lockfile integrity reviewed for `@esbuild/aix-ppc64@0.28.0`: `sha512-lhRUCeuOyJQURhTxl4WkpFTjIsbDayJHih5kZC1giwE+MhIzAb7mEsQMqMf18rHLsrb5qI1tafG20mLxEWcWlA==`
- Lockfile integrity reviewed for `@esbuild/android-arm64@0.28.0`: `sha512-+WzIXQOSaGs33tLEgYPYe/yQHf0WTU0X42Jca3y8NWMbUVhp7rUnw+vAsRC/QiDrdD31IszMrZy+qwPOPjd+rw==`
- Lockfile integrity reviewed for `@esbuild/android-arm@0.28.0`: `sha512-wqh0ByljabXLKHeWXYLqoJ5jKC4XBaw6Hk08OfMrCRd2nP2ZQ5eleDZC41XHyCNgktBGYMbqnrJKq/K/lzPMSQ==`
- Lockfile integrity reviewed for `@esbuild/android-x64@0.28.0`: `sha512-+VJggoaKhk2VNNqVL7f6S189UzShHC/mR9EE8rDdSkdpN0KflSwWY/gWjDrNxxisg8Fp1ZCD9jLMo4m0OUfeUA==`
- Lockfile integrity reviewed for `@esbuild/darwin-arm64@0.28.0`: `sha512-0T+A9WZm+bZ84nZBtk1ckYsOvyA3x7e2Acj1KdVfV4/2tdG4fzUp91YHx+GArWLtwqp77pBXVCPn2We7Letr0Q==`
- Lockfile integrity reviewed for `@esbuild/darwin-x64@0.28.0`: `sha512-fyzLm/DLDl/84OCfp2f/XQ4flmORsjU7VKt8HLjvIXChJoFFOIL6pLJPH4Yhd1n1gGFF9mPwtlN5Wf82DZs+LQ==`
- Lockfile integrity reviewed for `@esbuild/freebsd-arm64@0.28.0`: `sha512-l9GeW5UZBT9k9brBYI+0WDffcRxgHQD8ShN2Ur4xWq/NFzUKm3k5lsH4PdaRgb2w7mI9u61nr2gI2mLI27Nh3Q==`
- Lockfile integrity reviewed for `@esbuild/freebsd-x64@0.28.0`: `sha512-BXoQai/A0wPO6Es3yFJ7APCiKGc1tdAEOgeTNy3SsB491S3aHn4S4r3e976eUnPdU+NbdtmBuLncYir2tMU9Nw==`
- Lockfile integrity reviewed for `@esbuild/linux-arm64@0.28.0`: `sha512-RVyzfb3FWsGA55n6WY0MEIEPURL1FcbhFE6BffZEMEekfCzCIMtB5yyDcFnVbTnwk+CLAgTujmV/Lgvih56W+A==`
- Lockfile integrity reviewed for `@esbuild/linux-arm@0.28.0`: `sha512-CjaaREJagqJp7iTaNQjjidaNbCKYcd4IDkzbwwxtSvjI7NZm79qiHc8HqciMddQ6CKvJT6aBd8lO9kN/ZudLlw==`
- Lockfile integrity reviewed for `@esbuild/linux-ia32@0.28.0`: `sha512-KBnSTt1kxl9x70q+ydterVdl+Cn0H18ngRMRCEQfrbqdUuntQQ0LoMZv47uB97NljZFzY6HcfqEZ2SAyIUTQBQ==`
- Lockfile integrity reviewed for `@esbuild/linux-loong64@0.28.0`: `sha512-zpSlUce1mnxzgBADvxKXX5sl8aYQHo2ezvMNI8I0lbblJtp8V4odlm3Yzlj7gPyt3T8ReksE6bK+pT3WD+aJRg==`
- Lockfile integrity reviewed for `@esbuild/linux-mips64el@0.28.0`: `sha512-2jIfP6mmjkdmeTlsX/9vmdmhBmKADrWqN7zcdtHIeNSCH1SqIoNI63cYsjQR8J+wGa4Y5izRcSHSm8K3QWmk3w==`
- Lockfile integrity reviewed for `@esbuild/linux-ppc64@0.28.0`: `sha512-bc0FE9wWeC0WBm49IQMPSPILRocGTQt3j5KPCA8os6VprfuJ7KD+5PzESSrJ6GmPIPJK965ZJHTUlSA6GNYEhg==`
- Lockfile integrity reviewed for `@esbuild/linux-riscv64@0.28.0`: `sha512-SQPZOwoTTT/HXFXQJG/vBX8sOFagGqvZyXcgLA3NhIqcBv1BJU1d46c0rGcrij2B56Z2rNiSLaZOYW5cUk7yLQ==`
- Lockfile integrity reviewed for `@esbuild/linux-s390x@0.28.0`: `sha512-SCfR0HN8CEEjnYnySJTd2cw0k9OHB/YFzt5zgJEwa+wL/T/raGWYMBqwDNAC6dqFKmJYZoQBRfHjgwLHGSrn3Q==`
- Lockfile integrity reviewed for `@esbuild/linux-x64@0.28.0`: `sha512-us0dSb9iFxIi8srnpl931Nvs65it/Jd2a2K3qs7fz2WfGPHqzfzZTfec7oxZJRNPXPnNYZtanmRc4AL/JwVzHQ==`
- Lockfile integrity reviewed for `@esbuild/netbsd-arm64@0.28.0`: `sha512-CR/RYotgtCKwtftMwJlUU7xCVNg3lMYZ0RzTmAHSfLCXw3NtZtNpswLEj/Kkf6kEL3Gw+BpOekRX0BYCtklhUw==`
- Lockfile integrity reviewed for `@esbuild/netbsd-x64@0.28.0`: `sha512-nU1yhmYutL+fQ71Kxnhg8uEOdC0pwEW9entHykTgEbna2pw2dkbFSMeqjjyHZoCmt8SBkOSvV+yNmm94aUrrqw==`
- Lockfile integrity reviewed for `@esbuild/openbsd-arm64@0.28.0`: `sha512-cXb5vApOsRsxsEl4mcZ1XY3D4DzcoMxR/nnc4IyqYs0rTI8ZKmW6kyyg+11Z8yvgMfAEldKzP7AdP64HnSC/6g==`
- Lockfile integrity reviewed for `@esbuild/openbsd-x64@0.28.0`: `sha512-8wZM2qqtv9UP3mzy7HiGYNH/zjTA355mpeuA+859TyR+e+Tc08IHYpLJuMsfpDJwoLo1ikIJI8jC3GFjnRClzA==`
- Lockfile integrity reviewed for `@esbuild/openharmony-arm64@0.28.0`: `sha512-FLGfyizszcef5C3YtoyQDACyg95+dndv79i2EekILBofh5wpCa1KuBqOWKrEHZg3zrL3t5ouE5jgr94vA+Wb2w==`
- Lockfile integrity reviewed for `@esbuild/sunos-x64@0.28.0`: `sha512-1ZgjUoEdHZZl/YlV76TSCz9Hqj9h9YmMGAgAPYd+q4SicWNX3G5GCyx9uhQWSLcbvPW8Ni7lj4gDa1T40akdlw==`
- Lockfile integrity reviewed for `@esbuild/win32-arm64@0.28.0`: `sha512-Q9StnDmQ/enxnpxCCLSg0oo4+34B9TdXpuyPeTedN/6+iXBJ4J+zwfQI28u/Jl40nOYAxGoNi7mFP40RUtkmUA==`
- Lockfile integrity reviewed for `@esbuild/win32-ia32@0.28.0`: `sha512-zF3ag/gfiCe6U2iczcRzSYJKH1DCI+ByzSENHlM2FcDbEeo5Zd2C86Aq0tKUYAJJ1obRP84ymxIAksZUcdztHA==`
- Lockfile integrity reviewed for `@esbuild/win32-x64@0.28.0`: `sha512-pEl1bO9mfAmIC+tW5btTmrKaujg3zGtUmWNdCw/xs70FBjwAL3o9OEKNHvNmnyylD6ubxUERiEhdsL0xBQ9efw==`
- Lockfile integrity reviewed for `@rolldown/binding-android-arm64@1.0.2`: `sha512-ZS4D1JPGn/MYQN/SYDWftIE/nVsM8j/AFOYEzAoOE2O3NktQOZru+/vYXGbR/qtdLdIfGCP0lcoJiYVzsEz+iQ==`
- Lockfile integrity reviewed for `@rolldown/binding-darwin-arm64@1.0.2`: `sha512-vdFA9+C/rekyGce7WqHs/xoT0ioZEWaOFyZLIV1mEeNFaFDUQrPIo8Vs2GvJ6eetb3rzDUtUBgzto3ExpXJB3w==`
- Lockfile integrity reviewed for `@rolldown/binding-darwin-x64@1.0.2`: `sha512-BewSOwTHazv77DTYiAZXSqqKZ4KP/KonFisDMVU7PImxoWfB2aepnPhd2E4SWz3zDzYgDNbs6jBmTdgNnF02GA==`
- Lockfile integrity reviewed for `@rolldown/binding-freebsd-x64@1.0.2`: `sha512-m41o7M0YWtUdqk61Tb+jnKb2rN++iRdIASlExkUoKfIAH30DOHCB8fVLzSUpbWHHU8esmEioY62PxzexE8MBuA==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-arm-gnueabihf@1.0.2`: `sha512-jcojB9H7W/jS29pMKWAK1N+fU99vXodHDTatS3b3y/XSOCiHo0kkA74pL3jJmkoQtYpOCxDvaKs1fo2Ij/1X5w==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-arm64-gnu@1.0.2`: `sha512-1jn6qDU5iiOgFgygDzKUuKP0maTi0/f1+sBLgvij/76C77Nm3ts6ufz9Bjg5q5dduxiUIxtq86JIoBvo1xQ4Ig==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-arm64-musl@1.0.2`: `sha512-QVLO/czFMdoMFSqlX3bcswcJNm/23r+qoa/jgtmFc/qEp6/jXmIkDjF/XIo8dPfGaiwy1xfQn8o77L79GeXFgw==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-ppc64-gnu@1.0.2`: `sha512-hgO5Abm0w5UL6FEa2iFnZqo2KlK7TQ5QhV5x09hujBf7t5KzHQ1VmfPuTpqRy/rNlSxua3eWH374xxiVrP+lcA==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-s390x-gnu@1.0.2`: `sha512-fy8rXxuYEu602abC8MUNaPjYLIFzReOaEIEMKMUa0rFEUxNpVXhs15KSSQ4qlqSaM7B6rcj9rDZgADh/IGDzLQ==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-x64-gnu@1.0.2`: `sha512-0+bOkiQ779+r1WpoHOWHqncvyySci0vKph+myNDYb+im6meJAzHQXay6oEgnkHuUGouM1LKTZwqKpBow6Kj7CQ==`
- Lockfile integrity reviewed for `@rolldown/binding-linux-x64-musl@1.0.2`: `sha512-mjSkrzZK5Qsl0a9d1JgILOiuZOSDTVdKENcSXBoqbzSrspLR/4/IRVDo5wd2GgZjNss/viBFJdeq+j7qH2nypw==`
- Lockfile integrity reviewed for `@rolldown/binding-openharmony-arm64@1.0.2`: `sha512-1v5vHasdfQAZoEHakBV72LIFAC9JjnymsiKxp+GEr/ma3+NJCPSaYK+qavInOovJkgwFrs7GccX2d6IgDA3Z5w==`
- Lockfile integrity reviewed for `@rolldown/binding-wasm32-wasi@1.0.2`: `sha512-mb1VobWn6NheziTk5/WEaR6AKVbrwT5sOi6C7zk3gy/pD1qtJfU1j4PgTo2NJnOtbL9Dl3Aeei8w9jJ7qC2jZQ==`
- Lockfile integrity reviewed for `@rolldown/binding-win32-arm64-msvc@1.0.2`: `sha512-SqKonF56vA/L2yHwHYcEp2P34URpOZ7d1fS635cTkpDnUtEGdUbhI6NzsPdqeSWvAAeGDrxjWjNmibDIdFf9/A==`
- Lockfile integrity reviewed for `@rolldown/binding-win32-x64-msvc@1.0.2`: `sha512-v7qRI7gXLRINcOGXt+7YmAZ6iFuyZVMIoXAxhd8oP+DR9dLfL9GfNIx7PLMxmhZdvq8waUJBQiWN9EKNy+TRBQ==`
- Lockfile integrity reviewed for `lightningcss-android-arm64@1.32.0`: `sha512-YK7/ClTt4kAK0vo6w3X+Pnm0D2cf2vPHbhOXdoNti1Ga0al1P4TBZhwjATvjNwLEBCnKvjJc2jQgHXH0NEwlAg==`
- Lockfile integrity reviewed for `lightningcss-darwin-arm64@1.32.0`: `sha512-RzeG9Ju5bag2Bv1/lwlVJvBE3q6TtXskdZLLCyfg5pt+HLz9BqlICO7LZM7VHNTTn/5PRhHFBSjk5lc4cmscPQ==`
- Lockfile integrity reviewed for `lightningcss-darwin-x64@1.32.0`: `sha512-U+QsBp2m/s2wqpUYT/6wnlagdZbtZdndSmut/NJqlCcMLTWp5muCrID+K5UJ6jqD2BFshejCYXniPDbNh73V8w==`
- Lockfile integrity reviewed for `lightningcss-freebsd-x64@1.32.0`: `sha512-JCTigedEksZk3tHTTthnMdVfGf61Fky8Ji2E4YjUTEQX14xiy/lTzXnu1vwiZe3bYe0q+SpsSH/CTeDXK6WHig==`
- Lockfile integrity reviewed for `lightningcss-linux-arm-gnueabihf@1.32.0`: `sha512-x6rnnpRa2GL0zQOkt6rts3YDPzduLpWvwAF6EMhXFVZXD4tPrBkEFqzGowzCsIWsPjqSK+tyNEODUBXeeVHSkw==`
- Lockfile integrity reviewed for `lightningcss-linux-arm64-gnu@1.32.0`: `sha512-0nnMyoyOLRJXfbMOilaSRcLH3Jw5z9HDNGfT/gwCPgaDjnx0i8w7vBzFLFR1f6CMLKF8gVbebmkUN3fa/kQJpQ==`
- Lockfile integrity reviewed for `lightningcss-linux-arm64-musl@1.32.0`: `sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==`
- Lockfile integrity reviewed for `lightningcss-linux-x64-gnu@1.32.0`: `sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==`
- Lockfile integrity reviewed for `lightningcss-linux-x64-musl@1.32.0`: `sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==`
- Lockfile integrity reviewed for `lightningcss-win32-arm64-msvc@1.32.0`: `sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==`
- Lockfile integrity reviewed for `lightningcss-win32-x64-msvc@1.32.0`: `sha512-Amq9B/SoZYdDi1kFrojnoqPLxYhQ4Wo5XiL8EVJrVsB8ARoC1PWW6VGtT0WKCemjy8aC+louJnjS7U18x3b06Q==`

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
- Daily scheduled dependency integrity monitoring must keep running `pnpm security:audit` and `pnpm security:signatures` on unchanged `main`.
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
