#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_ALLOWED_BUILDS = ["@roamhq/wrtc", "esbuild"];

const REVIEWED_PACKAGES = {
  vite: {
    path: "node_modules/vite/package.json",
    name: "vite",
    version: "8.0.14",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/vitejs/vite.git", directory: "packages/vite" },
    type: "module",
    bin: { vite: "bin/vite.js" },
    files: ["bin", "dist", "misc/**/*.js", "client.d.ts", "types"],
    dependencies: {
      lightningcss: "^1.32.0",
      picomatch: "^4.0.4",
      postcss: "^8.5.15",
      rolldown: "1.0.2",
      tinyglobby: "^0.2.16"
    },
    optionalDependencies: { fsevents: "~2.3.3" },
    forbiddenScripts: ["preinstall", "install", "postinstall"]
  },
  esbuild: {
    path: "node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/package.json",
    name: "esbuild",
    version: "0.28.0",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/evanw/esbuild.git" },
    main: "lib/main.js",
    types: "lib/main.d.ts",
    bin: { esbuild: "bin/esbuild" },
    scripts: { postinstall: "node install.js" }
  },
  rolldown: {
    path: "node_modules/.pnpm/rolldown@1.0.2/node_modules/rolldown/package.json",
    name: "rolldown",
    version: "1.0.2",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/rolldown/rolldown.git", directory: "packages/rolldown" },
    type: "module",
    main: "./dist/index.mjs",
    module: "./dist/index.mjs",
    types: "./dist/index.d.mts",
    bin: { rolldown: "./bin/cli.mjs" },
    files: ["bin", "cli", "dist", "!dist/*.node"],
    dependencies: { "@oxc-project/types": "=0.132.0", "@rolldown/pluginutils": "^1.0.0" },
    forbiddenScripts: ["preinstall", "install", "postinstall"]
  },
  lightningcss: {
    path: "node_modules/.pnpm/lightningcss@1.32.0/node_modules/lightningcss/package.json",
    name: "lightningcss",
    version: "1.32.0",
    license: "MPL-2.0",
    repository: { type: "git", url: "https://github.com/parcel-bundler/lightningcss.git" },
    main: "node/index.js",
    types: "node/index.d.ts",
    files: ["node/*.js", "node/*.mjs", "node/*.d.ts", "node/*.flow"],
    dependencies: { "detect-libc": "^2.0.3" },
    forbiddenScripts: ["preinstall", "install", "postinstall"]
  }
};

const REVIEWED_OPTIONAL_DEPENDENCIES = {
  esbuild: [
    "@esbuild/aix-ppc64",
    "@esbuild/android-arm",
    "@esbuild/android-arm64",
    "@esbuild/android-x64",
    "@esbuild/darwin-arm64",
    "@esbuild/darwin-x64",
    "@esbuild/freebsd-arm64",
    "@esbuild/freebsd-x64",
    "@esbuild/linux-arm",
    "@esbuild/linux-arm64",
    "@esbuild/linux-ia32",
    "@esbuild/linux-loong64",
    "@esbuild/linux-mips64el",
    "@esbuild/linux-ppc64",
    "@esbuild/linux-riscv64",
    "@esbuild/linux-s390x",
    "@esbuild/linux-x64",
    "@esbuild/netbsd-arm64",
    "@esbuild/netbsd-x64",
    "@esbuild/openbsd-arm64",
    "@esbuild/openbsd-x64",
    "@esbuild/openharmony-arm64",
    "@esbuild/sunos-x64",
    "@esbuild/win32-arm64",
    "@esbuild/win32-ia32",
    "@esbuild/win32-x64"
  ],
  rolldown: [
    "@rolldown/binding-android-arm64",
    "@rolldown/binding-darwin-arm64",
    "@rolldown/binding-darwin-x64",
    "@rolldown/binding-freebsd-x64",
    "@rolldown/binding-linux-arm-gnueabihf",
    "@rolldown/binding-linux-arm64-gnu",
    "@rolldown/binding-linux-arm64-musl",
    "@rolldown/binding-linux-ppc64-gnu",
    "@rolldown/binding-linux-s390x-gnu",
    "@rolldown/binding-linux-x64-gnu",
    "@rolldown/binding-linux-x64-musl",
    "@rolldown/binding-openharmony-arm64",
    "@rolldown/binding-wasm32-wasi",
    "@rolldown/binding-win32-arm64-msvc",
    "@rolldown/binding-win32-x64-msvc"
  ],
  lightningcss: [
    "lightningcss-android-arm64",
    "lightningcss-darwin-arm64",
    "lightningcss-darwin-x64",
    "lightningcss-freebsd-x64",
    "lightningcss-linux-arm-gnueabihf",
    "lightningcss-linux-arm64-gnu",
    "lightningcss-linux-arm64-musl",
    "lightningcss-linux-x64-gnu",
    "lightningcss-linux-x64-musl",
    "lightningcss-win32-arm64-msvc",
    "lightningcss-win32-x64-msvc"
  ]
};

const REVIEWED_LOCKFILE_INTEGRITIES = {
  "vite@8.0.14": "sha512-s4BJJ+5y1pYL6Otw51FHhVJQhPnuRinKig64g/1+EUNaJsd3gCKdD31IPFvswUgW9/60QT9oFHbZHbQK5imcxw==",
  "esbuild@0.28.0": "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
  "rolldown@1.0.2": "sha512-oZx5zVDtVB44AW3eaifgDml1gWRDZGvjcfdxonE4swNPG98PrrXjaO/KrnUjzlMnztCCRVlUueA1kCXhARGk6g==",
  "lightningcss@1.32.0": "sha512-NXYBzinNrblfraPGyrbPoD19C1h9lfI/1mzgWYvXUTe414Gz/X1FD2XBZSZM7rRTrMA8JL3OtAaGifrIKhQ5yQ==",
  "@esbuild/aix-ppc64@0.28.0": "sha512-lhRUCeuOyJQURhTxl4WkpFTjIsbDayJHih5kZC1giwE+MhIzAb7mEsQMqMf18rHLsrb5qI1tafG20mLxEWcWlA==",
  "@esbuild/android-arm64@0.28.0": "sha512-+WzIXQOSaGs33tLEgYPYe/yQHf0WTU0X42Jca3y8NWMbUVhp7rUnw+vAsRC/QiDrdD31IszMrZy+qwPOPjd+rw==",
  "@esbuild/android-arm@0.28.0": "sha512-wqh0ByljabXLKHeWXYLqoJ5jKC4XBaw6Hk08OfMrCRd2nP2ZQ5eleDZC41XHyCNgktBGYMbqnrJKq/K/lzPMSQ==",
  "@esbuild/android-x64@0.28.0": "sha512-+VJggoaKhk2VNNqVL7f6S189UzShHC/mR9EE8rDdSkdpN0KflSwWY/gWjDrNxxisg8Fp1ZCD9jLMo4m0OUfeUA==",
  "@esbuild/darwin-arm64@0.28.0": "sha512-0T+A9WZm+bZ84nZBtk1ckYsOvyA3x7e2Acj1KdVfV4/2tdG4fzUp91YHx+GArWLtwqp77pBXVCPn2We7Letr0Q==",
  "@esbuild/darwin-x64@0.28.0": "sha512-fyzLm/DLDl/84OCfp2f/XQ4flmORsjU7VKt8HLjvIXChJoFFOIL6pLJPH4Yhd1n1gGFF9mPwtlN5Wf82DZs+LQ==",
  "@esbuild/freebsd-arm64@0.28.0": "sha512-l9GeW5UZBT9k9brBYI+0WDffcRxgHQD8ShN2Ur4xWq/NFzUKm3k5lsH4PdaRgb2w7mI9u61nr2gI2mLI27Nh3Q==",
  "@esbuild/freebsd-x64@0.28.0": "sha512-BXoQai/A0wPO6Es3yFJ7APCiKGc1tdAEOgeTNy3SsB491S3aHn4S4r3e976eUnPdU+NbdtmBuLncYir2tMU9Nw==",
  "@esbuild/linux-arm64@0.28.0": "sha512-RVyzfb3FWsGA55n6WY0MEIEPURL1FcbhFE6BffZEMEekfCzCIMtB5yyDcFnVbTnwk+CLAgTujmV/Lgvih56W+A==",
  "@esbuild/linux-arm@0.28.0": "sha512-CjaaREJagqJp7iTaNQjjidaNbCKYcd4IDkzbwwxtSvjI7NZm79qiHc8HqciMddQ6CKvJT6aBd8lO9kN/ZudLlw==",
  "@esbuild/linux-ia32@0.28.0": "sha512-KBnSTt1kxl9x70q+ydterVdl+Cn0H18ngRMRCEQfrbqdUuntQQ0LoMZv47uB97NljZFzY6HcfqEZ2SAyIUTQBQ==",
  "@esbuild/linux-loong64@0.28.0": "sha512-zpSlUce1mnxzgBADvxKXX5sl8aYQHo2ezvMNI8I0lbblJtp8V4odlm3Yzlj7gPyt3T8ReksE6bK+pT3WD+aJRg==",
  "@esbuild/linux-mips64el@0.28.0": "sha512-2jIfP6mmjkdmeTlsX/9vmdmhBmKADrWqN7zcdtHIeNSCH1SqIoNI63cYsjQR8J+wGa4Y5izRcSHSm8K3QWmk3w==",
  "@esbuild/linux-ppc64@0.28.0": "sha512-bc0FE9wWeC0WBm49IQMPSPILRocGTQt3j5KPCA8os6VprfuJ7KD+5PzESSrJ6GmPIPJK965ZJHTUlSA6GNYEhg==",
  "@esbuild/linux-riscv64@0.28.0": "sha512-SQPZOwoTTT/HXFXQJG/vBX8sOFagGqvZyXcgLA3NhIqcBv1BJU1d46c0rGcrij2B56Z2rNiSLaZOYW5cUk7yLQ==",
  "@esbuild/linux-s390x@0.28.0": "sha512-SCfR0HN8CEEjnYnySJTd2cw0k9OHB/YFzt5zgJEwa+wL/T/raGWYMBqwDNAC6dqFKmJYZoQBRfHjgwLHGSrn3Q==",
  "@esbuild/linux-x64@0.28.0": "sha512-us0dSb9iFxIi8srnpl931Nvs65it/Jd2a2K3qs7fz2WfGPHqzfzZTfec7oxZJRNPXPnNYZtanmRc4AL/JwVzHQ==",
  "@esbuild/netbsd-arm64@0.28.0": "sha512-CR/RYotgtCKwtftMwJlUU7xCVNg3lMYZ0RzTmAHSfLCXw3NtZtNpswLEj/Kkf6kEL3Gw+BpOekRX0BYCtklhUw==",
  "@esbuild/netbsd-x64@0.28.0": "sha512-nU1yhmYutL+fQ71Kxnhg8uEOdC0pwEW9entHykTgEbna2pw2dkbFSMeqjjyHZoCmt8SBkOSvV+yNmm94aUrrqw==",
  "@esbuild/openbsd-arm64@0.28.0": "sha512-cXb5vApOsRsxsEl4mcZ1XY3D4DzcoMxR/nnc4IyqYs0rTI8ZKmW6kyyg+11Z8yvgMfAEldKzP7AdP64HnSC/6g==",
  "@esbuild/openbsd-x64@0.28.0": "sha512-8wZM2qqtv9UP3mzy7HiGYNH/zjTA355mpeuA+859TyR+e+Tc08IHYpLJuMsfpDJwoLo1ikIJI8jC3GFjnRClzA==",
  "@esbuild/openharmony-arm64@0.28.0": "sha512-FLGfyizszcef5C3YtoyQDACyg95+dndv79i2EekILBofh5wpCa1KuBqOWKrEHZg3zrL3t5ouE5jgr94vA+Wb2w==",
  "@esbuild/sunos-x64@0.28.0": "sha512-1ZgjUoEdHZZl/YlV76TSCz9Hqj9h9YmMGAgAPYd+q4SicWNX3G5GCyx9uhQWSLcbvPW8Ni7lj4gDa1T40akdlw==",
  "@esbuild/win32-arm64@0.28.0": "sha512-Q9StnDmQ/enxnpxCCLSg0oo4+34B9TdXpuyPeTedN/6+iXBJ4J+zwfQI28u/Jl40nOYAxGoNi7mFP40RUtkmUA==",
  "@esbuild/win32-ia32@0.28.0": "sha512-zF3ag/gfiCe6U2iczcRzSYJKH1DCI+ByzSENHlM2FcDbEeo5Zd2C86Aq0tKUYAJJ1obRP84ymxIAksZUcdztHA==",
  "@esbuild/win32-x64@0.28.0": "sha512-pEl1bO9mfAmIC+tW5btTmrKaujg3zGtUmWNdCw/xs70FBjwAL3o9OEKNHvNmnyylD6ubxUERiEhdsL0xBQ9efw==",
  "@rolldown/binding-android-arm64@1.0.2": "sha512-ZS4D1JPGn/MYQN/SYDWftIE/nVsM8j/AFOYEzAoOE2O3NktQOZru+/vYXGbR/qtdLdIfGCP0lcoJiYVzsEz+iQ==",
  "@rolldown/binding-darwin-arm64@1.0.2": "sha512-vdFA9+C/rekyGce7WqHs/xoT0ioZEWaOFyZLIV1mEeNFaFDUQrPIo8Vs2GvJ6eetb3rzDUtUBgzto3ExpXJB3w==",
  "@rolldown/binding-darwin-x64@1.0.2": "sha512-BewSOwTHazv77DTYiAZXSqqKZ4KP/KonFisDMVU7PImxoWfB2aepnPhd2E4SWz3zDzYgDNbs6jBmTdgNnF02GA==",
  "@rolldown/binding-freebsd-x64@1.0.2": "sha512-m41o7M0YWtUdqk61Tb+jnKb2rN++iRdIASlExkUoKfIAH30DOHCB8fVLzSUpbWHHU8esmEioY62PxzexE8MBuA==",
  "@rolldown/binding-linux-arm-gnueabihf@1.0.2": "sha512-jcojB9H7W/jS29pMKWAK1N+fU99vXodHDTatS3b3y/XSOCiHo0kkA74pL3jJmkoQtYpOCxDvaKs1fo2Ij/1X5w==",
  "@rolldown/binding-linux-arm64-gnu@1.0.2": "sha512-1jn6qDU5iiOgFgygDzKUuKP0maTi0/f1+sBLgvij/76C77Nm3ts6ufz9Bjg5q5dduxiUIxtq86JIoBvo1xQ4Ig==",
  "@rolldown/binding-linux-arm64-musl@1.0.2": "sha512-QVLO/czFMdoMFSqlX3bcswcJNm/23r+qoa/jgtmFc/qEp6/jXmIkDjF/XIo8dPfGaiwy1xfQn8o77L79GeXFgw==",
  "@rolldown/binding-linux-ppc64-gnu@1.0.2": "sha512-hgO5Abm0w5UL6FEa2iFnZqo2KlK7TQ5QhV5x09hujBf7t5KzHQ1VmfPuTpqRy/rNlSxua3eWH374xxiVrP+lcA==",
  "@rolldown/binding-linux-s390x-gnu@1.0.2": "sha512-fy8rXxuYEu602abC8MUNaPjYLIFzReOaEIEMKMUa0rFEUxNpVXhs15KSSQ4qlqSaM7B6rcj9rDZgADh/IGDzLQ==",
  "@rolldown/binding-linux-x64-gnu@1.0.2": "sha512-0+bOkiQ779+r1WpoHOWHqncvyySci0vKph+myNDYb+im6meJAzHQXay6oEgnkHuUGouM1LKTZwqKpBow6Kj7CQ==",
  "@rolldown/binding-linux-x64-musl@1.0.2": "sha512-mjSkrzZK5Qsl0a9d1JgILOiuZOSDTVdKENcSXBoqbzSrspLR/4/IRVDo5wd2GgZjNss/viBFJdeq+j7qH2nypw==",
  "@rolldown/binding-openharmony-arm64@1.0.2": "sha512-1v5vHasdfQAZoEHakBV72LIFAC9JjnymsiKxp+GEr/ma3+NJCPSaYK+qavInOovJkgwFrs7GccX2d6IgDA3Z5w==",
  "@rolldown/binding-wasm32-wasi@1.0.2": "sha512-mb1VobWn6NheziTk5/WEaR6AKVbrwT5sOi6C7zk3gy/pD1qtJfU1j4PgTo2NJnOtbL9Dl3Aeei8w9jJ7qC2jZQ==",
  "@rolldown/binding-win32-arm64-msvc@1.0.2": "sha512-SqKonF56vA/L2yHwHYcEp2P34URpOZ7d1fS635cTkpDnUtEGdUbhI6NzsPdqeSWvAAeGDrxjWjNmibDIdFf9/A==",
  "@rolldown/binding-win32-x64-msvc@1.0.2": "sha512-v7qRI7gXLRINcOGXt+7YmAZ6iFuyZVMIoXAxhd8oP+DR9dLfL9GfNIx7PLMxmhZdvq8waUJBQiWN9EKNy+TRBQ==",
  "lightningcss-android-arm64@1.32.0": "sha512-YK7/ClTt4kAK0vo6w3X+Pnm0D2cf2vPHbhOXdoNti1Ga0al1P4TBZhwjATvjNwLEBCnKvjJc2jQgHXH0NEwlAg==",
  "lightningcss-darwin-arm64@1.32.0": "sha512-RzeG9Ju5bag2Bv1/lwlVJvBE3q6TtXskdZLLCyfg5pt+HLz9BqlICO7LZM7VHNTTn/5PRhHFBSjk5lc4cmscPQ==",
  "lightningcss-darwin-x64@1.32.0": "sha512-U+QsBp2m/s2wqpUYT/6wnlagdZbtZdndSmut/NJqlCcMLTWp5muCrID+K5UJ6jqD2BFshejCYXniPDbNh73V8w==",
  "lightningcss-freebsd-x64@1.32.0": "sha512-JCTigedEksZk3tHTTthnMdVfGf61Fky8Ji2E4YjUTEQX14xiy/lTzXnu1vwiZe3bYe0q+SpsSH/CTeDXK6WHig==",
  "lightningcss-linux-arm-gnueabihf@1.32.0": "sha512-x6rnnpRa2GL0zQOkt6rts3YDPzduLpWvwAF6EMhXFVZXD4tPrBkEFqzGowzCsIWsPjqSK+tyNEODUBXeeVHSkw==",
  "lightningcss-linux-arm64-gnu@1.32.0": "sha512-0nnMyoyOLRJXfbMOilaSRcLH3Jw5z9HDNGfT/gwCPgaDjnx0i8w7vBzFLFR1f6CMLKF8gVbebmkUN3fa/kQJpQ==",
  "lightningcss-linux-arm64-musl@1.32.0": "sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==",
  "lightningcss-linux-x64-gnu@1.32.0": "sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==",
  "lightningcss-linux-x64-musl@1.32.0": "sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==",
  "lightningcss-win32-arm64-msvc@1.32.0": "sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==",
  "lightningcss-win32-x64-msvc@1.32.0": "sha512-Amq9B/SoZYdDi1kFrojnoqPLxYhQ4Wo5XiL8EVJrVsB8ARoC1PWW6VGtT0WKCemjy8aC+louJnjS7U18x3b06Q=="
};

if (isMain()) {
  try {
    main();
  } catch {
    console.error("Reviewed build toolchain dependency metadata is not installed.");
    process.exitCode = 1;
  }
}

function main() {
  const packageJson = readJson(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES);
  if (ownValue(ownValue(packageJson, "devDependencies"), "vite") !== REVIEWED_PACKAGES.vite.version) throw new Error("vite pin changed.");
  assertWorkspaceBuildPolicy();
  assertReviewedPackageMetadata();
  assertReviewedOptionalDependencySets();
  assertReviewedLockfileIntegrities();
}

function assertWorkspaceBuildPolicy() {
  const workspace = readText(path.join(root, "pnpm-workspace.yaml"), MAX_PACKAGE_JSON_BYTES);
  assertStrictDepBuildsPolicy(workspace);
  if (/^\s*(?:onlyBuiltDependencies|ignoredBuiltDependencies|neverBuiltDependencies):/m.test(workspace)) throw new Error("pnpm build-script policy changed.");
  const allowedBuilds = allowedBuildNamesFromWorkspace(workspace);
  if (allowedBuilds.length !== REVIEWED_ALLOWED_BUILDS.length || allowedBuilds.some((name, index) => name !== REVIEWED_ALLOWED_BUILDS[index])) {
    throw new Error("pnpm allowed build-script surface changed.");
  }
}

export function assertStrictDepBuildsPolicy(workspace) {
  if (typeof workspace !== "string" || workspace.length < 1 || workspace.length > MAX_PACKAGE_JSON_BYTES) throw new Error("pnpm workspace policy is invalid.");
  const values = [];
  for (const line of workspace.split(/\r?\n/)) {
    if (!/^\S/.test(line) || /^\s*#/.test(line)) continue;
    if (line.startsWith("strictDepBuilds:")) values.push(line.slice("strictDepBuilds:".length).trim());
  }
  if (values.length !== 1 || values[0] !== "true") throw new Error("pnpm strict dependency build policy changed.");
}

export function allowedBuildNamesFromWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.length < 1 || workspace.length > MAX_PACKAGE_JSON_BYTES) throw new Error("pnpm workspace policy is invalid.");
  const entries = [];
  let inAllowBuilds = false;
  let allowBuildSections = 0;
  for (const line of workspace.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inAllowBuilds = line.trim() === "allowBuilds:";
      if (inAllowBuilds) allowBuildSections += 1;
      continue;
    }
    if (!inAllowBuilds || line.trim() === "" || /^\s*#/.test(line)) continue;
    const match = /^  ("@roamhq\/wrtc"|esbuild): true$/.exec(line);
    if (!match) throw new Error("pnpm allowed build-script surface changed.");
    entries.push(match[1].replace(/^"|"$/g, ""));
  }
  if (allowBuildSections !== 1) throw new Error("pnpm allowed build-script surface changed.");
  const uniqueEntries = new Set(entries);
  if (uniqueEntries.size !== entries.length) throw new Error("pnpm allowed build-script surface changed.");
  return entries;
}

function assertReviewedPackageMetadata() {
  for (const expected of Object.values(REVIEWED_PACKAGES)) {
    const actual = readJson(path.join(root, expected.path), MAX_PACKAGE_JSON_BYTES);
    assertExact(actual, "name", expected.name);
    assertExact(actual, "version", expected.version);
    assertExact(actual, "license", expected.license);
    assertExactJson(actual, "repository", expected.repository);
    assertExact(actual, "type", expected.type);
    assertExact(actual, "main", expected.main);
    assertExact(actual, "module", expected.module);
    assertExact(actual, "types", expected.types);
    assertExactJson(actual, "bin", expected.bin);
    assertExactJson(actual, "files", expected.files);
    assertExactJson(actual, "dependencies", expected.dependencies);
    if (expected.optionalDependencies) assertExactJson(actual, "optionalDependencies", expected.optionalDependencies);
    if (expected.scripts) assertExactJson(actual, "scripts", expected.scripts);
    for (const lifecycle of expected.forbiddenScripts ?? []) {
      if (ownValue(ownValue(actual, "scripts") ?? {}, lifecycle) !== undefined) throw new Error("build tool lifecycle hook changed.");
    }
  }
}

function assertReviewedOptionalDependencySets() {
  const esbuild = readJson(path.join(root, REVIEWED_PACKAGES.esbuild.path), MAX_PACKAGE_JSON_BYTES);
  const rolldown = readJson(path.join(root, REVIEWED_PACKAGES.rolldown.path), MAX_PACKAGE_JSON_BYTES);
  const lightningcss = readJson(path.join(root, REVIEWED_PACKAGES.lightningcss.path), MAX_PACKAGE_JSON_BYTES);
  assertExactJson(ownValue(esbuild, "optionalDependencies") ?? {}, undefined, Object.fromEntries(REVIEWED_OPTIONAL_DEPENDENCIES.esbuild.map((name) => [name, "0.28.0"]).sort()));
  assertExactJson(ownValue(rolldown, "optionalDependencies") ?? {}, undefined, Object.fromEntries(REVIEWED_OPTIONAL_DEPENDENCIES.rolldown.map((name) => [name, "1.0.2"]).sort()));
  assertExactJson(ownValue(lightningcss, "optionalDependencies") ?? {}, undefined, Object.fromEntries(REVIEWED_OPTIONAL_DEPENDENCIES.lightningcss.map((name) => [name, "1.32.0"]).sort()));
}

function assertReviewedLockfileIntegrities() {
  const lockfile = readText(path.join(root, "pnpm-lock.yaml"), MAX_LOCKFILE_BYTES);
  for (const [nameAndVersion, integrity] of Object.entries(REVIEWED_LOCKFILE_INTEGRITIES)) {
    const [name, version] = splitPackageNameAndVersion(nameAndVersion);
    const escapedName = escapeRegExp(name);
    const escapedVersion = escapeRegExp(version);
    const escapedIntegrity = escapeRegExp(integrity);
    const pattern = new RegExp(`^  '${escapedName}@${escapedVersion}':\\n    resolution: \\{integrity: ${escapedIntegrity}\\}`, "m");
    const unquotedPattern = new RegExp(`^  ${escapedName}@${escapedVersion}:\\n    resolution: \\{integrity: ${escapedIntegrity}\\}`, "m");
    if (!pattern.test(lockfile) && !unquotedPattern.test(lockfile)) throw new Error("reviewed build toolchain lockfile integrity changed.");
  }
}

function splitPackageNameAndVersion(nameAndVersion) {
  const at = nameAndVersion.startsWith("@") ? nameAndVersion.lastIndexOf("@") : nameAndVersion.indexOf("@");
  if (at <= 0) throw new Error("reviewed package identity is invalid.");
  return [nameAndVersion.slice(0, at), nameAndVersion.slice(at + 1)];
}

function assertExact(record, key, expected) {
  const actual = ownValue(record, key);
  if (expected === undefined) {
    if (actual !== undefined) throw new Error("build tool metadata changed.");
    return;
  }
  if (actual !== expected) throw new Error("build tool metadata changed.");
}

function assertExactJson(record, key, expected) {
  const actual = key === undefined ? record : ownValue(record, key);
  if (expected === undefined) {
    if (actual !== undefined) throw new Error("build tool metadata changed.");
    return;
  }
  if (JSON.stringify(sortRecord(actual)) !== JSON.stringify(sortRecord(expected))) throw new Error("build tool metadata changed.");
}

function sortRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function readJson(file, maxBytes) {
  return JSON.parse(readText(file, maxBytes));
}

function readText(file, maxBytes) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error("reviewed evidence is invalid.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes || !sameFile(info, opened)) throw new Error("reviewed evidence is invalid.");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = readSync(fd, buffer, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size || !sameFile(opened, fstatSync(fd))) throw new Error("reviewed evidence changed while being read.");
    return fatalUtf8.decode(buffer);
  } finally {
    closeSync(fd);
  }
}

function ownValue(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("reviewed metadata is invalid.");
  if (key === undefined) return record;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw new Error("reviewed metadata is invalid.");
  return descriptor.value;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
