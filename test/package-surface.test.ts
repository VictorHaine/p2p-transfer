import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  author?: string;
  homepage?: string;
  bugs?: { url?: string } | string;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  packageManager?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  browser?: string;
  scripts?: Record<string, string>;
  sideEffects?: boolean;
  publishConfig?: Record<string, unknown>;
  pnpm?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
const pnpmWorkspace = fs.readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const pnpmLock = fs.readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const packedSmokeScript = fs.readFileSync(new URL("../scripts/smoke-packed.mjs", import.meta.url), "utf8");
const releaseArtifactSmokeScript = fs.readFileSync(new URL("../scripts/smoke-release-artifact.mjs", import.meta.url), "utf8");
const dockerPolicySmokeScript = fs.readFileSync(new URL("../scripts/smoke-docker-policy.mjs", import.meta.url), "utf8");
const dockerPublishScript = fs.readFileSync(new URL("../scripts/publish-docker-image.mjs", import.meta.url), "utf8");
const dockerConfigScript = fs.readFileSync(new URL("../scripts/docker-config.mjs", import.meta.url), "utf8");
const nativeSmokeScript = fs.readFileSync(new URL("../scripts/smoke-native.mjs", import.meta.url), "utf8");
const installStateScript = fs.readFileSync(new URL("../scripts/check-install-state.mjs", import.meta.url), "utf8");
const cryptoDependencyCheckScript = fs.readFileSync(new URL("../scripts/check-crypto-dependencies.mjs", import.meta.url), "utf8");
const checkedPnpmScript = fs.readFileSync(new URL("../scripts/prepare-checked-pnpm.mjs", import.meta.url), "utf8");
const cliCryptoDependenciesSource = fs.readFileSync(new URL("../src/cli/crypto-dependencies.ts", import.meta.url), "utf8");
const cliDependencyMetadataSource = fs.readFileSync(new URL("../src/cli/dependency-metadata.ts", import.meta.url), "utf8");
const cliNativeWebrtcSource = fs.readFileSync(new URL("../src/cli/native-webrtc.ts", import.meta.url), "utf8");
const cliRtcSource = fs.readFileSync(new URL("../src/cli/rtc.ts", import.meta.url), "utf8");
const releaseTagScript = fs.readFileSync(new URL("../scripts/check-release-tag.mjs", import.meta.url), "utf8");
const releaseMainScript = fs.readFileSync(new URL("../scripts/check-release-main.mjs", import.meta.url), "utf8");
const releaseArtifactScript = fs.readFileSync(new URL("../scripts/verify-release-artifact.mjs", import.meta.url), "utf8");
const releasePublishScript = fs.readFileSync(new URL("../scripts/publish-release-artifact.mjs", import.meta.url), "utf8");
const directPublishGuardScript = fs.readFileSync(new URL("../scripts/guard-direct-publish.mjs", import.meta.url), "utf8");
const githubReleaseScript = fs.readFileSync(new URL("../scripts/create-github-release.mjs", import.meta.url), "utf8");
const bootstrapNpmScript = fs.readFileSync(new URL("../scripts/bootstrap-npm-package.mjs", import.meta.url), "utf8");
const releaseReadinessScript = fs.readFileSync(new URL("../scripts/check-release-readiness.mjs", import.meta.url), "utf8");
const releaseChecksumScript = fs.readFileSync(new URL("../scripts/write-release-checksum.mjs", import.meta.url), "utf8");
const releaseSbomScript = fs.readFileSync(new URL("../scripts/write-release-sbom.mjs", import.meta.url), "utf8");
const releaseNotesScript = fs.readFileSync(new URL("../scripts/write-release-notes.mjs", import.meta.url), "utf8");
const liveReleaseRefScript = fs.readFileSync(new URL("../scripts/verify-live-release-ref.mjs", import.meta.url), "utf8");
const fileStabilityCheckedScripts = [
  installStateScript,
  bootstrapNpmScript,
  releaseReadinessScript,
  packedSmokeScript,
  releaseArtifactSmokeScript,
  dockerPublishScript,
  githubReleaseScript,
  releaseTagScript,
  releaseArtifactScript,
  releaseChecksumScript,
  releaseSbomScript,
  releaseNotesScript
];
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const cpaceReview = fs.readFileSync(new URL("../docs/security/cpace-review.md", import.meta.url), "utf8");
const cpaceVectorTest = fs.readFileSync(new URL("./cpace-vectors.test.ts", import.meta.url), "utf8");
const nobleHashesReview = fs.readFileSync(new URL("../docs/security/noble-hashes-review.md", import.meta.url), "utf8");
const nativeWebrtcReview = fs.readFileSync(new URL("../docs/security/native-webrtc-review.md", import.meta.url), "utf8");
const buildToolchainNativeReview = fs.readFileSync(new URL("../docs/security/build-toolchain-native-review.md", import.meta.url), "utf8");
const dependabotConfig = fs.readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const conformanceFiles = fs.readdirSync(new URL("../conformance", import.meta.url));
const pakePackageJson = JSON.parse(fs.readFileSync(new URL("../node_modules/@cipherman/pake-js/package.json", import.meta.url), "utf8")) as PackageJson;
const nobleHashesPackageJson = JSON.parse(fs.readFileSync(new URL("../node_modules/@noble/hashes/package.json", import.meta.url), "utf8")) as PackageJson;
const wrtcPackageJson = JSON.parse(fs.readFileSync(new URL("../node_modules/@roamhq/wrtc/package.json", import.meta.url), "utf8")) as PackageJson;
const vitePackageJson = JSON.parse(fs.readFileSync(new URL("../node_modules/vite/package.json", import.meta.url), "utf8")) as PackageJson;
const esbuildPackageJson = JSON.parse(
  fs.readFileSync(new URL("../node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/package.json", import.meta.url), "utf8")
) as PackageJson;
const rolldownPackageJson = JSON.parse(
  fs.readFileSync(new URL("../node_modules/.pnpm/rolldown@1.0.2/node_modules/rolldown/package.json", import.meta.url), "utf8")
) as PackageJson;
const lightningCssPackageJson = JSON.parse(
  fs.readFileSync(new URL("../node_modules/.pnpm/lightningcss@1.32.0/node_modules/lightningcss/package.json", import.meta.url), "utf8")
) as PackageJson;

const reviewedWrtcPrebuiltPackages = [
  "@roamhq/wrtc-darwin-arm64",
  "@roamhq/wrtc-darwin-x64",
  "@roamhq/wrtc-linux-arm64",
  "@roamhq/wrtc-linux-x64",
  "@roamhq/wrtc-win32-x64"
];

const reviewedPakeIntegrity = "sha512-iutxMCmRXYacl3fc19SKFisk1sRD1FNQi7+GWPlnQnFit6l3sUagYOCU2IgRPD8MF3s1HwnkSpqARFUp04+GVQ==";
const reviewedNobleCurvesIntegrity = "sha512-gbKGcRUYIjA3/zCCNaWDciTMFI0dCkvou3TL8Zmy5Nc7sJ47a0jtOeZoTaMxkuqRo9cRhjOdZJXegxYE5FN/xw==";
const reviewedNobleHashesCpaceIntegrity = "sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==";
const reviewedNobleHashesIntegrity = "sha512-IYqDGiTXab6FniAgnSdZwgWbomxpy9FtYvLKs7wCUs2a8RkITG+DFGO1DM9cr+E3/RgADRpFjrKVaJ1z6sjtEg==";
const reviewedWrtcIntegrity = "sha512-yFqQQ0EV1ZUHaphh3tmjoxPi2wzhW2vjmzoAVNRRLUjXYd2e1nvwi9TKfE2w4WNvNws/hBkouvOt23Xo9FkXkQ==";
const reviewedWrtcPrebuiltIntegrities: Record<string, string> = {
  "@roamhq/wrtc-darwin-arm64": "sha512-vFdi79jWuPHcnUcnuOjTvyKtmY/RI2xRQo9Y6RsIjIlYePN/7LTy00c+Ivrz4prYAPbp0oHscl7PDV64VUqGTQ==",
  "@roamhq/wrtc-darwin-x64": "sha512-H6852g2xYCuaR+/TrthpdMafs4bMfAUEpvRDhsIguzrK7Dz+MKpNI8MkwdqJN8W65J+7w7k+YqXIkTHe7Fz/cg==",
  "@roamhq/wrtc-linux-arm64": "sha512-fEuJbNjprxQG6QlFd2iqBW9x028RDSho6izVg7gyt8irdPiXWOxzOxNnYMs/B2fohBTd1wD4Qxfivl07/dCR8A==",
  "@roamhq/wrtc-linux-x64": "sha512-H32lK2eFg3sVb/9nkHIX5HIisxFoS82Gpesuea+zqAyRpRzSd5NpFXx28bVy9wQyRrNtj8k0bTUgEzWRzSbYCA==",
  "@roamhq/wrtc-win32-x64": "sha512-wEVXMvLrBizdLyrd+Zc7zb7zpwUuHUBXwrdIvI69e3i/AA8YsVYI2xo/sxk6GoQ+o8a14ONc4SStDS35TCjg+w=="
};
const reviewedDomexceptionIntegrity = "sha512-A2is4PLG+eeSfoTMA95/s4pvAoSo2mKtiM5jlHkAVewmiO8ISFTFKZjH7UAM1Atli/OT/7JHOrJRJiMKUZKYBw==";
const reviewedWebidlConversionsIntegrity = "sha512-VwddBukDzu71offAQR975unBIGqfKZpM+8ZX6ySk8nYhVoo5CYaZyzt3YBvYtRtO+aoGlqxPg/B87NGVZ/fu6g==";
const reviewedBuildToolchainIntegrities: Record<string, string> = {
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
const reviewedEsbuildOptionalPackages = [
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
];
const reviewedRolldownOptionalPackages = [
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
];
const reviewedLightningCssOptionalPackages = [
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
];

test("npm package surface is restricted to built artifacts and required docs", () => {
  assert.deepEqual(packageJson.files, [
    "conformance",
    "dist-node/cli",
    "dist-node/server",
    "dist-node/shared",
    "dist-web",
    "docs/security",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md"
  ]);
  assert.equal(packageJson.files?.some((entry) => entry === "src" || entry === "test" || entry.startsWith("src/") || entry.startsWith("test/")), false);
  assert.deepEqual(packageJson.bin, {
    ff: "./dist-node/cli/index.js",
    "ff-server": "./dist-node/server/index.js"
  });
  assert.deepEqual(packageJson.exports, {});
  assert.match(securityPolicy, /published package must keep an empty `exports` map unless a separately reviewed public JavaScript API is added/);
  for (const binPath of Object.values(packageJson.bin ?? {})) {
    const normalized = binPath.replace(/^\.\//, "");
    assert.equal(packageJson.files?.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`)), true, `${binPath} must be included by package files`);
  }
});

test("published bin entrypoints are executable Node CLIs", () => {
  assert.match(securityPolicy, /published CLI bin entrypoints must keep a Node shebang and executable mode/);
  for (const binPath of Object.values(packageJson.bin ?? {})) {
    const relativePath = binPath.replace(/^\.\//, "");
    const sourcePath = sourcePathForBuiltBin(relativePath);
    const builtPath = new URL(`../${relativePath}`, import.meta.url);
    const source = fs.readFileSync(sourcePath, "utf8");
    const built = fs.readFileSync(builtPath, "utf8");
    const mode = fs.statSync(builtPath).mode & 0o777;

    assert.match(source, /^#!\/usr\/bin\/env node\n/);
    assert.match(built, /^#!\/usr\/bin\/env node\n/);
    assert.equal(mode & 0o111, 0o111, `${relativePath} must be executable by npm after publish`);
  }
});

test("package ships only the current protocol conformance fixture", () => {
  assert.deepEqual(conformanceFiles, ["protocol-v5.json"]);
});

test("package publishing config keeps provenance and reproducible dependency pins", () => {
  assert.equal(packageJson.name, "@victorhaine/p2p-transfer");
  assert.match(packageJson.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.author, "Victor Haine");
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.homepage, "https://github.com/VictorHaine/p2p-transfer#readme");
  assert.deepEqual(packageJson.bugs, { url: "https://github.com/VictorHaine/p2p-transfer/issues" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/VictorHaine/p2p-transfer.git"
  });
  assert.equal(
    packageJson.packageManager,
    "pnpm@11.1.3+sha512.c85357fe17ca12dd23dd7071822666dfd7e3cb76fe214e3370b5ea2fb34f2a231185509b63e717f3cd0acb38dd3f8d82bcd5e8172400ae678b70ea4fbed0896d"
  );
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true });
  assert.match(packageJson.scripts?.build ?? "", /^node --import tsx scripts\/check-crypto-dependencies\.mjs && /);
  assert.equal(packageJson.scripts?.prepack, "pnpm build");
  assert.equal(packageJson.scripts?.prepublishOnly, "node scripts/guard-direct-publish.mjs");
  assert.equal(packageJson.scripts?.check, "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.test.json");
  assert.equal(packageJson.scripts?.["security:audit"], "pnpm audit --audit-level low");
  assert.equal(packageJson.scripts?.["security:signatures"], "pnpm audit signatures");
  assert.equal(packageJson.scripts?.["smoke:native"], "node scripts/smoke-native.mjs");
  assert.equal(packageJson.scripts?.["smoke:packed"], "node scripts/smoke-packed.mjs");
  assert.equal(packageJson.scripts?.["smoke:release-artifact"], "node scripts/smoke-release-artifact.mjs");
  assert.equal(packageJson.scripts?.["bootstrap:npm"], "node scripts/bootstrap-npm-package.mjs");
  assert.equal(packageJson.scripts?.["check:install-state"], "node scripts/check-install-state.mjs");
  assert.match(securityPolicy, /typecheck gates must explicitly run the shipping Node project config and the test project config/);
  assert.match(securityPolicy, /release dependency audits must fail on known vulnerabilities at low severity or higher/);
  assert.match(securityPolicy, /release dependency verification must run registry package signature checks/);
  assert.match(securityPolicy, /direct workspace `pnpm publish`\/`npm publish` must fail closed through `prepublishOnly`/);
  assert.match(directPublishGuardScript, /Direct workspace publishing is disabled\./);
  assert.match(directPublishGuardScript, /Use the tag-only GitHub release workflow/);
  assert.match(directPublishGuardScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(directPublishGuardScript, /function assertNoArgs\(args\)/);
  assert.doesNotMatch(directPublishGuardScript, /process\.exit\(/);
  assert.match(securityPolicy, /installed direct dependency tree does not match the exact `package\.json` pins or when `node_modules\/\.pnpm\/lock\.yaml` diverges from `pnpm-lock\.yaml`/);
  assert.match(securityPolicy, /installed-state verification must validate direct dependency names and package pins before installed package reads, check both installed direct package identity and installed direct package version against `package\.json` pins before accepting the local dependency tree, and mismatch output must not echo raw workspace paths, raw filesystem errors, stack traces, or installed package metadata/);
  assert.match(securityPolicy, /installed-state verification must resolve the project root from the checked script location, use a symlink-safe realpath entrypoint check, avoid filesystem verification side effects when imported, and use verifier-owned top-level failure reporting/);
  assert.match(securityPolicy, /installed-state verification must byte-cap, no-follow-open, identity-check, mutation-metadata-check, handle-read, and fatal-UTF-8-decode package and lockfile evidence/);
  assert.match(securityPolicy, /runtime crypto and native WebRTC dependency attestation must byte-cap, no-follow-open, identity-check, mutation-metadata-check, handle-read, and fatal-UTF-8-decode dependency package metadata before accepting installed package identity/);
  assert.match(securityPolicy, /browser and CLI builds must run the reviewed crypto dependency attestation before producing production artifacts/);
  assert.match(cryptoDependencyCheckScript, /assertReviewedCryptoDependencies\(\)/);
  assert.match(cryptoDependencyCheckScript, /Reviewed cryptographic dependency metadata is not installed\./);
  assert.match(cliDependencyMetadataSource, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(cliDependencyMetadataSource, /lstatSync\(file\)/);
  assert.match(cliDependencyMetadataSource, /openSync\(file, constants\.O_RDONLY \| noFollowFlag\(\)\)/);
  assert.match(cliDependencyMetadataSource, /if \(!opened\.isFile\(\) \|\| !sameFile\(info, opened\)\)/);
  assert.match(cliDependencyMetadataSource, /while \(offset < opened\.size\)/);
  assert.match(cliDependencyMetadataSource, /readSync\(fd, bytes, offset, opened\.size - offset, offset\)/);
  assert.match(cliDependencyMetadataSource, /if \(!sameFile\(opened, fstatSync\(fd\)\)\) throw new Error\("Dependency package metadata is invalid\."\)/);
  assert.match(cliDependencyMetadataSource, /left\.dev === right\.dev && left\.ino === right\.ino && left\.size === right\.size && left\.mtimeMs === right\.mtimeMs && left\.ctimeMs === right\.ctimeMs/);
  assert.match(cliDependencyMetadataSource, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.doesNotMatch(cliDependencyMetadataSource, /readFileSync|buffer\.toString\("utf8"\)/);
  assert.doesNotMatch(cliCryptoDependenciesSource, /readFileSync\(path\.join\(root, "package\.json"\)/);
  assert.doesNotMatch(cliNativeWebrtcSource, /readFileSync\(path\.join\(root, "package\.json"\)/);
  assert.match(securityPolicy, /installed-state verification must reject duplicate direct dependency declarations across `dependencies` and `devDependencies`/);
  assert.match(securityPolicy, /release verification scripts must resolve the project root from the checked script location/);
  assert.match(securityPolicy, /release verification scripts must byte-cap, no-follow-open, identity-check, and handle-read project metadata before parsing/);
  assert.match(installStateScript, /node_modules", "\.pnpm", "lock\.yaml"/);
  assert.match(installStateScript, /pnpm-lock\.yaml/);
  assert.match(installStateScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(installStateScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(installStateScript, /function main\(\)/);
  assert.match(installStateScript, /function isMain\(\)/);
  assert.match(installStateScript, /console\.error\("Installed dependency tree could not be verified:"\)/);
  assert.match(installStateScript, /function containsAbsolutePathText\(value\)/);
  assert.doesNotMatch(installStateScript, /process\.cwd\(\)/);
  assert.match(installStateScript, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(installStateScript, /const MAX_LOCKFILE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(installStateScript, /lstatSync\(file\)/);
  assert.match(installStateScript, /openSync\(file, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(installStateScript, /if \(!sameFile\(info, opened\)\) throw new Error\(`\$\{label\} changed before verification`\)/);
  assert.match(installStateScript, /function readHandleText\(fd, size, label\)/);
  assert.match(installStateScript, /readSync\(fd, buffer, offset, size - offset, offset\)/);
  assert.match(installStateScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(installStateScript, /return fatalUtf8\.decode\(buffer\)/);
  assert.match(installStateScript, /\$\{label\} is not valid UTF-8/);
  assert.doesNotMatch(installStateScript, /buffer\.toString\("utf8"\)/);
  assert.match(installStateScript, /function sameFile\(left, right\)/);
  assert.match(installStateScript, /function relativeEvidencePath\(file\)/);
  assert.match(installStateScript, /function installStateErrorMessage\(error\)/);
  assert.match(installStateScript, /could not read installed package evidence at/);
  assert.doesNotMatch(installStateScript, /errorMessage\(error\)|String\(error\)|error\.stack|ENOENT/);
  assert.doesNotMatch(installStateScript, /readFileSync\(file|(?<!l)statSync\(file\)/);
  assert.match(installStateScript, /function validatePackageName\(name\)/);
  assert.match(installStateScript, /Invalid dependency name in package\.json\./);
  assert.match(installStateScript, /expected exact semver package\.json pin/);
  assert.doesNotMatch(installStateScript, /Invalid dependency name in package\.json: \$\{String\(name\)\}/);
  assert.doesNotMatch(installStateScript, /expected exact semver pin, got \$\{String\(version\)\}/);
  assert.match(installStateScript, /Dependency \$\{name\} must not be declared in both dependencies and devDependencies/);
  assert.match(installStateScript, /const installedName = ownString\(installed, "name"\)/);
  assert.match(installStateScript, /function isCanonicalPackageName\(name\)/);
  assert.match(installStateScript, /installed package identity does not match expected name/);
  assert.match(installStateScript, /installed package version does not match package\.json pin/);
  assert.doesNotMatch(installStateScript, /installed package identity is \$\{installedName\}/);
  assert.doesNotMatch(installStateScript, /installed \$\{String\(installedVersion\)\}/);
  assert.match(installStateScript, /Object\.getOwnPropertyDescriptor\(record, key\)/);
  assert.match(installStateScript, /info\.isFile\(\)/);
  assert.match(installStateScript, /info\.size < 1 \|\| info\.size > maxBytes/);
  assert.equal(packageJson.scripts?.["verify:local"], "pnpm check:install-state && pnpm security:dependencies && pnpm build && pnpm check && pnpm test:unit && pnpm smoke:native && pnpm smoke:packed");
  assert.equal(
    packageJson.scripts?.["verify:release"],
    "pnpm check:install-state && pnpm security:dependencies && pnpm build && pnpm check && pnpm test:unit && pnpm smoke:native && pnpm smoke:packed && pnpm test:e2e && pnpm test:browser && pnpm security:audit && pnpm security:signatures && node scripts/write-release-notes.mjs --check && pnpm smoke:release-artifact"
  );
  assert.equal(packageJson.scripts?.["verify:release:docker"], "pnpm verify:release && pnpm smoke:docker-policy");
  assert.equal(packageJson.scripts?.test, "pnpm build && pnpm test:unit && pnpm test:e2e && pnpm test:browser");
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.equal(isExactPackageVersion(version), true, `${name} must use an exact dependency version`);
  }
});

test("release file stability helpers compare mutation metadata", () => {
  for (const source of fileStabilityCheckedScripts) {
    assert.match(source, /function sameFile\(left, right\)/);
    assert.match(source, /left\.dev === right\.dev && left\.ino === right\.ino && left\.size === right\.size && left\.mtimeMs === right\.mtimeMs && left\.ctimeMs === right\.ctimeMs/);
  }
});

test("native WebRTC smoke negotiates local session descriptions", () => {
  assert.match(securityPolicy, /native WebRTC smoke must load WebRTC through the built CLI `nativeWebRtc\(\)` guard, instantiate PeerConnections, create a DataChannel, and complete local offer\/answer SDP negotiation/);
  assert.match(nativeSmokeScript, /async function importNativeWebRtc\(\)/);
  assert.match(nativeSmokeScript, /const mod = await import\("\.\.\/dist-node\/cli\/native-webrtc\.js"\)/);
  assert.match(nativeSmokeScript, /return mod\.nativeWebRtc\(\)/);
  assert.match(nativeSmokeScript, /throw new Error\("Native WebRTC package could not be loaded\."\)/);
  assert.doesNotMatch(nativeSmokeScript, /@roamhq\/wrtc|import wrtc from "@roamhq\/wrtc"/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCPeerConnection, "RTCPeerConnection"\)/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCDataChannel, "RTCDataChannel"\)/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCIceCandidate, "RTCIceCandidate"\)/);
  assert.match(nativeSmokeScript, /new RTCPeerConnection\(\{ iceServers: \[\] \}\)/);
  assert.match(nativeSmokeScript, /left\.createDataChannel\("native-smoke", \{ ordered: true \}\)/);
  assert.match(nativeSmokeScript, /await Promise\.race\(\[negotiate\(left, right\), timeoutPromise\]\)/);
  assert.match(nativeSmokeScript, /assertDescription\(left\.localDescription, "offer", "left local description"\)/);
  assert.match(nativeSmokeScript, /assertDescription\(right\.remoteDescription, "offer", "right remote description"\)/);
  assert.match(nativeSmokeScript, /description\.sdp\.includes\("m=application"\)/);
  assert.match(nativeSmokeScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(securityPolicy, /bypassed runtime attestation, or wrapper\/prebuilt mismatch cannot pass by import alone/);
  assert.doesNotMatch(packageJson.scripts?.["smoke:native"] ?? "", /node -e/);
});

test("packed package smoke installs and executes published bins", () => {
  assert.match(securityPolicy, /install the packed tarball into a fresh consumer project and execute the published `ff` and `ff-server` bins/);
  assert.match(packedSmokeScript, /pnpm.*pack.*--pack-destination/s);
  assert.match(packedSmokeScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(packedSmokeScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(packedSmokeScript, /process\.cwd\(\)/);
  assert.match(packedSmokeScript, /const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(packedSmokeScript, /const MAX_CONFORMANCE_JSON_BYTES = 128 \* 1024/);
  assert.match(packedSmokeScript, /if \(!sameFile\(info, opened\)\) throw new Error\(`\$\{path\.relative\(root, file\)\} changed before verification\.`\)/);
  assert.match(packedSmokeScript, /return await readHandleText\(handle, opened\.size, path\.relative\(root, file\)\)/);
  assert.doesNotMatch(packedSmokeScript, /readFile\(file, "utf8"\)|import\("node:fs\/promises"\)\.then/);
  assert.match(packedSmokeScript, /pnpm.*add/s);
  assert.match(packedSmokeScript, /pnpm.*exec", "ff", "--version"/);
  assert.match(packedSmokeScript, /const protocolVersion = requiredProtocolVersion\(parseJsonEvidence\(await readText\(path\.join\(root, "conformance", "protocol-v5\.json"\), MAX_CONFORMANCE_JSON_BYTES\), "conformance\/protocol-v5\.json"\)\.protocolVersion\)/);
  assert.match(packedSmokeScript, /const packageName = requiredPackageName\(packageJson\.name\)/);
  assert.match(packedSmokeScript, /const packageVersion = requiredPackageVersion\(packageJson\.version\)/);
  assert.match(packedSmokeScript, /const expectedTarballName = expectedPackedTarballName\(packageName, packageVersion\)/);
  assert.match(packedSmokeScript, /packCurrentProject\(packDir, childEnv, expectedTarballName\)/);
  assert.match(packedSmokeScript, /function requiredPackageName\(value\)/);
  assert.match(packedSmokeScript, /function requiredPackageVersion\(value\)/);
  assert.match(packedSmokeScript, /export function expectedPackedTarballName\(packageName, packageVersion\)/);
  assert.match(packedSmokeScript, /Packed smoke pack output must contain exactly the expected tarball\./);
  assert.doesNotMatch(packedSmokeScript, /filter\(\(name\) => name\.endsWith\("\.tgz"\)\)/);
  assert.match(packedSmokeScript, /function requiredProtocolVersion\(value\)/);
  assert.match(packedSmokeScript, /const expectedVersion = `\$\{packageVersion\} protocol \$\{protocolVersion\}`/);
  assert.match(packedSmokeScript, /version\.stdout\.trimEnd\(\) !== expectedVersion \|\| version\.stderr\.length > 0/);
  assert.doesNotMatch(packedSmokeScript, /version\.stdout\.includes/);
  assert.match(packedSmokeScript, /pnpm.*exec", "ff-server"/);
  assert.match(packedSmokeScript, /async function smokeInstalledTransfer\(consumerDir, childEnv, port, tmp\)/);
  assert.match(packedSmokeScript, /"exec", "ff", "--server", serverUrl, "--json", "--local-private-mode", "recv", "--code-stdin", "--yes", "--out-env", "FF_RECEIVE_OUT"/);
  assert.match(packedSmokeScript, /env: \{ \.\.\.childEnv, FF_RECEIVE_OUT: out \}/);
  assert.match(packedSmokeScript, /endCheckedChildStdin\(receiver, `\$\{code\}\\n`, "packed ff recv"/);
  assert.match(packedSmokeScript, /let receiverStdinError/);
  assert.match(packedSmokeScript, /throw receiverStdinError \?\? error/);
  assert.match(packedSmokeScript, /"exec", "ff", "--server", serverUrl, "--json", "--local-private-mode", "send", "--code-stdin", "--files-stdin"/);
  assert.match(packedSmokeScript, /stdin: `\$\{code\}\\n\$\{source\}\\n`/);
  assert.match(packedSmokeScript, /Packed installed ff recv did not use an opaque output name\./);
  assert.match(packedSmokeScript, /function checkedChildStdin\(value\)/);
  assert.match(packedSmokeScript, /const MAX_CHILD_STDIN_BYTES = 8_192/);
  assert.match(packedSmokeScript, /Packed installed CLI transfer changed file bytes\./);
  assert.match(packedSmokeScript, /strictDepBuilds: true/);
  assert.match(packedSmokeScript, /onlyBuiltDependencies:/);
  assert.match(packedSmokeScript, /@roamhq\/wrtc/);
  assert.match(packedSmokeScript, /\/healthz/);
  assert.match(packedSmokeScript, /ff transfer/);
  assert.match(securityPolicy, /packed-install smoke must use an OS-assigned loopback port/);
  assert.match(securityPolicy, /packed-install smoke options and subprocesses must run with descriptor-read, non-empty, control-free, byte-capped environment values/);
  assert.match(securityPolicy, /packed-install smoke must use a symlink-safe realpath entrypoint check and smoke-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, preflight temporary filesystem capacity before creating its private workspace or starting package-manager\/native-install work, strip terminal control and format characters and redact path-shaped evidence from captured subprocess output and rendered command labels, reject non-string command label parts and non-Buffer child output chunks before coercion, bound that sanitized output, and force-kill timed-out subprocesses/);
  assert.match(securityPolicy, /packed-install smoke command timeouts must reject only after the timed-out subprocess exits/);
  assert.match(securityPolicy, /packed-install smoke startup waits must clean up listeners, terminate timed-out server subprocesses, and reject only after the server subprocess exits/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap server health and web UI response bodies/);
  assert.match(securityPolicy, /packed-install smoke HTTP probes must use an abort deadline that covers both headers and response body reads/);
  assert.match(securityPolicy, /packed-install smoke must fatal-UTF-8-decode project metadata and HTTP probe responses, parse project metadata and health response JSON with smoke-owned deterministic errors, and reject invalid health bodies without echoing response content/);
  assert.match(securityPolicy, /packed-install smoke must require exact `ff --version` stdout and empty stderr/);
  assert.match(securityPolicy, /packed-install smoke must run an actual installed `ff recv` and `ff send` transfer through the installed `ff-server` using `--local-private-mode` plus private stdin receive-code input, environment-sourced receive-output input, and stdin file-list input, handle child stdin pipe errors with generic non-input-reporting failures, verify the receive path is opaque, then compare received bytes/);
  assert.match(securityPolicy, /packed-install smoke must validate the project package name and `version`, derive the exact expected npm tarball name from that metadata before installing a self-packed workspace, and reject any pack output that is not exactly that single tarball/);
  assert.match(securityPolicy, /packed-install smoke must validate the project `packageManager` is an exact hash-pinned `pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]+` pin/);
  assert.match(securityPolicy, /provided tarball paths must reject terminal control\/format characters and staging\/open failures must not echo raw tarball paths/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap the provided tarball path by UTF-8 bytes, no-follow-open, identity-check, and stage the verified tarball into a distinct no-follow-copied file in its private temp workspace before fresh-project install/);
  assert.match(packedSmokeScript, /const MAX_CHILD_OUTPUT_CHARS = 200_000/);
  assert.match(packedSmokeScript, /const MAX_PACKED_SMOKE_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(packedSmokeScript, /const MAX_PACKED_SMOKE_TARBALL_PATH_BYTES = 4_096/);
  assert.match(packedSmokeScript, /const MIN_PACKED_SMOKE_TMP_FREE_BYTES = 1024 \* 1024 \* 1024/);
  assert.match(packedSmokeScript, /const MAX_HEALTH_RESPONSE_BYTES = 8_192/);
  assert.match(packedSmokeScript, /const MAX_WEB_RESPONSE_BYTES = 1_048_576/);
  assert.match(packedSmokeScript, /const MAX_FETCH_RESPONSE_MS = 10_000/);
  assert.match(packedSmokeScript, /const CHILD_KILL_GRACE_MS = 5_000/);
  assert.match(packedSmokeScript, /console\.error\("Packed smoke failed:"\)/);
  assert.match(packedSmokeScript, /function packedSmokeErrorMessage\(error\)/);
  assert.match(packedSmokeScript, /function containsPathLikeText\(value\)/);
  assert.doesNotMatch(packedSmokeScript, /if \(isMain\(\)\) await main\(\)/);
  assert.match(packedSmokeScript, /function appendBoundedOutput\(current, chunk\)/);
  assert.match(packedSmokeScript, /typeof current !== "string"/);
  assert.match(packedSmokeScript, /sanitizeChildOutputChunk\(chunk\)/);
  assert.match(packedSmokeScript, /Buffer\.isBuffer\(chunk\)/);
  assert.doesNotMatch(packedSmokeScript, /chunk\.toString\("utf8"\)/);
  assert.match(packedSmokeScript, /function renderCommandForLog\(command, args\)/);
  assert.match(packedSmokeScript, /function commandParts\(command, args\)/);
  assert.match(packedSmokeScript, /function redactPathLikeText\(value\)/);
  assert.match(packedSmokeScript, /export async function assertTemporaryDiskSpace\(minFreeBytes, failureMessage\)/);
  assert.match(packedSmokeScript, /await assertTemporaryDiskSpace\(MIN_PACKED_SMOKE_TMP_FREE_BYTES, "Packed smoke requires at least 1 GiB of free temporary disk space\."\)/);
  assert.match(packedSmokeScript, /Object\.getOwnPropertyDescriptor\(args, String\(index\)\)/);
  assert.match(packedSmokeScript, /const commandLabel = renderCommandForLog\(command, args\)/);
  assert.doesNotMatch(packedSmokeScript, /\$\{command\} \$\{args\.join\(" "\)\}/);
  assert.match(packedSmokeScript, /replace\(\/\[\\p\{Cc\}\\p\{Cf\}\]\/gu/);
  assert.match(packedSmokeScript, /export async function readBoundedResponseText\(response, maxBytes\)/);
  assert.match(packedSmokeScript, /function fetchBoundedResponseText\(url, maxBytes\)/);
  assert.match(packedSmokeScript, /\$\{label\} is not valid UTF-8\./);
  assert.match(packedSmokeScript, /Packed smoke response is not valid UTF-8\./);
  assert.match(packedSmokeScript, /export function parseJsonEvidence\(text, label\)/);
  assert.match(packedSmokeScript, /packageJson = parseJsonEvidence/);
  assert.match(packedSmokeScript, /parseJsonEvidence\(text, "packed ff-server health response"\)/);
  assert.match(packedSmokeScript, /Packed ff-server health body is invalid\./);
  assert.doesNotMatch(packedSmokeScript, /Packed ff-server health body is invalid:|JSON\.stringify\(body\)/);
  assert.match(packedSmokeScript, /const controller = new AbortController\(\)/);
  assert.match(packedSmokeScript, /fetch\(url, \{ signal: controller\.signal \}\)/);
  assert.match(packedSmokeScript, /Packed smoke HTTP probe timed out after \$\{MAX_FETCH_RESPONSE_MS\}ms\./);
  assert.doesNotMatch(packedSmokeScript, /Packed smoke HTTP probe timed out after \$\{MAX_FETCH_RESPONSE_MS\}ms: \$\{url\}/);
  assert.match(packedSmokeScript, /readBoundedResponseText\(response, maxBytes\)/);
  assert.match(packedSmokeScript, /stdout = appendBoundedOutput\(stdout, chunk\)/);
  assert.match(packedSmokeScript, /stderr = appendBoundedOutput\(stderr, chunk\)/);
  assert.match(packedSmokeScript, /function run\(command, args, options\)[\s\S]*let timeoutError/);
  assert.match(packedSmokeScript, /timeoutError = new Error\(`\$\{commandLabel\} timed out/);
  assert.match(packedSmokeScript, /child\.on\("exit", \(code\) => \{[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\)/);
  assert.doesNotMatch(packedSmokeScript, /rejectOnce\(new Error\(`\$\{command\} \$\{args\.join\(" "\)\} timed out/);
  assert.match(packedSmokeScript, /fetchBoundedResponseText\(`http:\/\/127\.0\.0\.1:\$\{port\}\/healthz`, MAX_HEALTH_RESPONSE_BYTES\)/);
  assert.match(packedSmokeScript, /fetchBoundedResponseText\(`http:\/\/127\.0\.0\.1:\$\{port\}\/`, MAX_WEB_RESPONSE_BYTES\)/);
  assert.equal(packedSmokeScript.match(/child\.kill\("SIGKILL"\)/g)?.length, 5);
  assert.match(packedSmokeScript, /export function endCheckedChildStdin\(child, value, label, onFailure\)/);
  assert.match(packedSmokeScript, /child\.stdin\.once\("error", onError\)/);
  assert.match(packedSmokeScript, /child\.stdin\.once\("finish", onFinish\)/);
  assert.match(packedSmokeScript, /child\.stdin\.off\("error", onError\)/);
  assert.match(packedSmokeScript, /child\.stdin\.end\(stdin\)/);
  assert.match(packedSmokeScript, /new Error\(`\$\{label\} stdin pipe failed\.`\)/);
  assert.doesNotMatch(packedSmokeScript, /child\.stdin\.end\(checkedChildStdin\(options\.stdin\)\)/);
  assert.match(packedSmokeScript, /function run\(command, args, options\)[\s\S]*catch \(error\) \{[\s\S]*child\.kill\("SIGTERM"\)[\s\S]*killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)[\s\S]*rejectOnce\(error, true\)/);
  assert.match(packedSmokeScript, /function waitForOutput\(child, pattern, timeoutMs\)[\s\S]*let timeoutError[\s\S]*timeoutError = new Error\(`Timed out waiting for \$\{pattern\}/);
  assert.match(packedSmokeScript, /function waitForOutput\(child, pattern, timeoutMs\)[\s\S]*child\.kill\("SIGTERM"\)[\s\S]*killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(packedSmokeScript, /const onExit = \(code\) => \{[\s\S]*if \(killTimer\) clearTimeout\(killTimer\);[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.doesNotMatch(packedSmokeScript, /rejectOnce\(new Error\(`Timed out waiting for \$\{pattern\}/);
  assert.match(packedSmokeScript, /function waitForOutput\(child, pattern, timeoutMs\)[\s\S]*child\.stdout\.off\("data", onStdout\)[\s\S]*child\.stderr\.off\("data", onStderr\)[\s\S]*child\.off\("exit", onExit\)/);
  assert.match(packedSmokeScript, /function waitForExitWithOutput\(child, timeoutMs, output\)[\s\S]*let timeoutError[\s\S]*timeoutError = new Error\("Timed out waiting for packed transfer command\."\)/);
  assert.match(packedSmokeScript, /function waitForExitWithOutput\(child, timeoutMs, output\)[\s\S]*child\.kill\("SIGTERM"\)[\s\S]*killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(packedSmokeScript, /const onExit = \(code\) => \{[\s\S]*if \(killTimer\) clearTimeout\(killTimer\);[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.match(packedSmokeScript, /function waitForExitWithOutput\(child, timeoutMs, output\)[\s\S]*child\.off\("exit", onExit\)[\s\S]*child\.off\("error", onError\)/);
  assert.doesNotMatch(packedSmokeScript, /reject\(new Error\("Timed out waiting for packed transfer command\."\)\)/);
  assert.match(packedSmokeScript, /const packageManager = requiredPackageManager\(packageJson\.packageManager\)/);
  assert.match(packedSmokeScript, /function requiredPackageManager\(value\)/);
  assert.match(packedSmokeScript, /\^pnpm@\\d\+\\\.\\d\+\\\.\\d\+\\\+sha512\\\.\[a-f0-9\]\+\$/);
  assert.match(packedSmokeScript, /const providedTarball = optionalProvidedTarball\(\)/);
  assert.match(packedSmokeScript, /function optionalProvidedTarball\(\)/);
  assert.match(packedSmokeScript, /PACKED_SMOKE_TARBALL/);
  assert.match(packedSmokeScript, /hasUnsafePathText\(value\)/);
  assert.match(packedSmokeScript, /utf8ByteLengthExceeds\(value, MAX_PACKED_SMOKE_TARBALL_PATH_BYTES\)/);
  assert.match(packedSmokeScript, /const childEnv = isolatedChildEnv\(privateHome\)/);
  assert.match(packedSmokeScript, /await mkdir\(privateHome, \{ mode: 0o700 \}\)/);
  assert.match(packedSmokeScript, /await mkdir\(childEnv\.XDG_CONFIG_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(packedSmokeScript, /await mkdir\(childEnv\.PNPM_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(packedSmokeScript, /await mkdir\(childEnv\.COREPACK_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(securityPolicy, /package-manager homes, and npm userconfig paths to a private 0700 temporary directory/);
  assert.match(packedSmokeScript, /providedTarball \?\? \(await packCurrentProject\(packDir, childEnv, expectedTarballName\)\)/);
  assert.match(packedSmokeScript, /const installTarball = await stageVerifiedTarball\(tarball, packDir\)/);
  assert.match(packedSmokeScript, /await run\(pnpm, \["add", installTarball\], \{ cwd: consumerDir, timeoutMs: 180_000, env: childEnv \}\)/);
  assert.match(packedSmokeScript, /function stageVerifiedTarball\(tarball, destination\)/);
  assert.match(packedSmokeScript, /Packed smoke tarball could not be opened for verification\./);
  assert.doesNotMatch(packedSmokeScript, /Packed smoke tarball filename is invalid: \$\{basename\}/);
  assert.doesNotMatch(packedSmokeScript, /Packed smoke tarball is not a regular file: \$\{tarball\}/);
  assert.match(packedSmokeScript, /path\.join\(destination, `verified-\$\{basename\}`\)/);
  assert.doesNotMatch(packedSmokeScript, /path\.resolve\(staged\) === path\.resolve\(tarball\)|return tarball/);
  assert.match(packedSmokeScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(packedSmokeScript, /if \(!sameFile\(info, opened\)\) throw new Error\("Packed smoke tarball changed before verification\."\)/);
  assert.match(packedSmokeScript, /constants\.O_CREAT \| constants\.O_EXCL \| constants\.O_WRONLY/);
  assert.match(packedSmokeScript, /await copyVerifiedHandle\(source, target, opened\.size\)/);
  assert.match(packedSmokeScript, /function copyVerifiedHandle\(source, target, size\)/);
  assert.match(packedSmokeScript, /function writeFull\(handle, data, position\)/);
  assert.match(packedSmokeScript, /Packed smoke tarball changed while being staged/);
  assert.doesNotMatch(packedSmokeScript, /await assertRegularTarball\(tarball\)/);
  assert.match(packedSmokeScript, /lstat\(tarball\)/);
  assert.match(packedSmokeScript, /info\.size < 1 \|\| info\.size > MAX_PACKED_SMOKE_TARBALL_BYTES/);
  assert.match(packedSmokeScript, /function safeChildEnv\(\)/);
  assert.match(packedSmokeScript, /const keepTemp = optionalEnvString\("KEEP_PACKED_SMOKE_TMP"\) === "true"/);
  assert.match(packedSmokeScript, /export function optionalEnvString\(name\)/);
  assert.match(packedSmokeScript, /\$\{name\} must be a non-empty control-free environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.doesNotMatch(packedSmokeScript, /process\.env\.KEEP_PACKED_SMOKE_TMP/);
  assert.match(packedSmokeScript, /function isolatedChildEnv\(privateHome\)/);
  assert.match(packedSmokeScript, /const MAX_CHILD_ENV_VALUE_BYTES = 8_192/);
  assert.match(packedSmokeScript, /\["PATH", true\]/);
  assert.match(packedSmokeScript, /HOME: home/);
  assert.match(packedSmokeScript, /USERPROFILE: home/);
  assert.match(packedSmokeScript, /NPM_CONFIG_USERCONFIG: path\.join\(home, "\.npmrc"\)/);
  assert.match(packedSmokeScript, /PNPM_HOME: path\.join\(home, "pnpm-home"\)/);
  assert.match(packedSmokeScript, /COREPACK_HOME: path\.join\(home, "corepack-home"\)/);
  assert.match(packedSmokeScript, /throw new Error\(`\$\{name\} must be a non-empty control-free child environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\.`\)/);
  assert.match(packedSmokeScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(value\)/);
  assert.match(packedSmokeScript, /env: options\.env \?\? safeChildEnv\(\)/);
  assert.match(packedSmokeScript, /\.\.\.childEnv/);
  assert.doesNotMatch(packedSmokeScript, /env: process\.env/);
  assert.doesNotMatch(packedSmokeScript, /\.\.\.process\.env/);
  assert.match(packedSmokeScript, /import \{ createServer \} from "node:net"/);
  assert.match(packedSmokeScript, /function reserveLoopbackPort\(\)/);
  assert.match(packedSmokeScript, /probe\.listen\(0, "127\.0\.0\.1"/);
  assert.doesNotMatch(packedSmokeScript, /Math\.random/);
  assert.doesNotMatch(packedSmokeScript, /npm\s+install|npx/);
});

test("CI workflow enforces local, platform, browser, and Docker gates", () => {
  assert.match(securityPolicy, /CI platform smoke must also install the packed tarball into a fresh consumer project/);
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /branches:\n\s+- main/);
  assert.match(ciWorkflow, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(ciWorkflow, /- 22\.22\.3/);
  assert.match(ciWorkflow, /- 24\.13\.1/);
  assert.match(ciWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(ciWorkflow, /pnpm check:install-state/);
  assert.match(ciWorkflow, /pnpm security:dependencies/);
  assert.match(ciWorkflow, /pnpm check:install-state[\s\S]*pnpm security:dependencies[\s\S]*pnpm build/);
  assert.match(ciWorkflow, /pnpm check/);
  assert.match(ciWorkflow, /pnpm build/);
  assert.match(ciWorkflow, /pnpm test:unit/);
  assert.match(ciWorkflow, /pnpm smoke:native/);
  assert.match(ciWorkflow, /pnpm smoke:native[\s\S]*pnpm smoke:release-artifact[\s\S]*pnpm security:audit/);
  assert.match(ciWorkflow, /pnpm smoke:packed/);
  assert.match(ciWorkflow, /pnpm exec playwright install --with-deps chromium/);
  assert.match(ciWorkflow, /pnpm test:e2e/);
  assert.match(ciWorkflow, /pnpm test:browser/);
  assert.match(ciWorkflow, /ubuntu-24\.04/);
  assert.match(ciWorkflow, /ubuntu-24\.04-arm/);
  assert.match(ciWorkflow, /macos-15/);
  assert.match(ciWorkflow, /macos-15-intel/);
  assert.match(ciWorkflow, /windows-2025/);
  assert.doesNotMatch(ciWorkflow, /runs-on:\s*[a-z]+-latest|-\s+[a-z]+-latest/);
  assert.equal(packageJson.scripts?.["smoke:docker-policy"], "node scripts/smoke-docker-policy.mjs");
  assert.match(ciWorkflow, /DOCKER_SMOKE_TAG=p2p-transfer:test node scripts\/smoke-docker-policy\.mjs/);
  assert.match(checkedPnpmScript, /corepack", \["pack", `pnpm@\$\{version\}`, "-o", archive\]/);
  assert.match(checkedPnpmScript, /Corepack pnpm package hash did not match the reviewed integrity/);
  assert.match(checkedPnpmScript, /if \(isMain\(\)\) \{[\s\S]*await main\(\)/);
  assert.match(checkedPnpmScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(checkedPnpmScript, /readCheckedText\(path\.join\(root, "package\.json"\), MAX_PACKAGE_JSON_BYTES, "package metadata"\)/);
  assert.match(checkedPnpmScript, /await lstat\(file\)/);
  assert.match(checkedPnpmScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(checkedPnpmScript, /sameFile\(info\.stat, afterRead\)/);
  assert.match(checkedPnpmScript, /left\.mtimeMs === right\.mtimeMs && left\.ctimeMs === right\.ctimeMs/);
  assert.match(checkedPnpmScript, /const childEnv = await privateChildEnv\(path\.join\(tmp, "home"\)\)/);
  assert.match(checkedPnpmScript, /HOME: home[\s\S]*PNPM_HOME: path\.join\(home, "pnpm-home"\)[\s\S]*COREPACK_HOME: path\.join\(home, "corepack-home"\)/);
  assert.match(checkedPnpmScript, /\["PATH", true\]/);
  assert.match(checkedPnpmScript, /const descriptor = Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(checkedPnpmScript, /spawn\(command, args, \{ cwd: options\.cwd, env: options\.env, stdio: \["ignore", "pipe", "pipe"\] \}\)/);
  assert.doesNotMatch(checkedPnpmScript, /readFile\(path\.join\(root, "package\.json"\)|readFileSync\(path\.join\(root, "package\.json"\)/);
  assert.match(ciWorkflow, /production docker policy[\s\S]*actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0[\s\S]*node-version: 22\.22\.3[\s\S]*node scripts\/prepare-checked-pnpm\.mjs[\s\S]*DOCKER_SMOKE_TAG=p2p-transfer:test node scripts\/smoke-docker-policy\.mjs/);
  assert.doesNotMatch(ciWorkflow, /corepack prepare pnpm@/);
  assert.match(dockerPolicySmokeScript, /\["build", "-t", imageTag, "\."\]/);
  assert.match(dockerPolicySmokeScript, /const HARDENED_DOCKER_RUN_FLAGS = \["--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1"\]/);
  assert.match(dockerPolicySmokeScript, /\["run", "--rm", \.\.\.HARDENED_DOCKER_RUN_FLAGS, "-e", "SIGNALING_TOPOLOGY=single-instance", imageTag\]/);
  assert.match(dockerPolicySmokeScript, /\["run", "--rm", \.\.\.HARDENED_DOCKER_RUN_FLAGS, "-e", `ALLOWED_ORIGINS=\$\{PRODUCTION_ORIGIN\}`, imageTag\]/);
  assert.match(dockerPolicySmokeScript, /"Error: ALLOWED_ORIGINS is required in production\."/);
  assert.match(dockerPolicySmokeScript, /"Error: SIGNALING_TOPOLOGY must be single-instance or sticky-sessions for production or non-loopback deployments\."/);
  assert.match(dockerPolicySmokeScript, /function hasExactOutputLine\(result, expectedLine\)/);
  assert.match(dockerPolicySmokeScript, /line\.trim\(\) === expectedLine/);
  assert.match(dockerPolicySmokeScript, /MAX_COMMAND_OUTPUT_BYTES = 1024 \* 1024/);
  assert.match(dockerPolicySmokeScript, /import \{ spawn \} from "node:child_process"/);
  assert.match(dockerPolicySmokeScript, /const DOCKER_PREFLIGHT_TIMEOUT_MS = 20_000/);
  assert.match(dockerPolicySmokeScript, /const BUILD_TIMEOUT_MS = 300_000/);
  assert.match(dockerPolicySmokeScript, /await run\("docker", \["info", "--format", "\{\{json \.ServerVersion\}\}"\], "docker daemon preflight", DOCKER_PREFLIGHT_TIMEOUT_MS/);
  assert.match(dockerPolicySmokeScript, /const CHILD_KILL_GRACE_MS = 5_000/);
  assert.match(dockerPolicySmokeScript, /return new Promise\(\(resolve, reject\) =>/);
  assert.match(dockerPolicySmokeScript, /timeoutError = new Error\(`\$\{label\} timed out\.`\)/);
  assert.match(dockerPolicySmokeScript, /child\.kill\("SIGTERM"\)/);
  assert.match(dockerPolicySmokeScript, /child\.kill\("SIGKILL"\)/);
  assert.match(dockerPolicySmokeScript, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(dockerPolicySmokeScript, /child\.on\("exit", \(code, signal\) =>/);
  assert.match(dockerPolicySmokeScript, /if \(timeoutError\) \{\n\s+rejectOnce\(timeoutError\)/);
  assert.match(dockerPolicySmokeScript, /stdout = appendBoundedOutput\(stdout, chunk\)/);
  assert.match(dockerPolicySmokeScript, /stderr = appendBoundedOutput\(stderr, chunk\)/);
  assert.match(dockerPolicySmokeScript, /function truncateUtf8Tail\(value, maxBytes\)/);
  assert.match(dockerPolicySmokeScript, /Buffer\.byteLength\(next, "utf8"\) <= MAX_COMMAND_OUTPUT_BYTES/);
  assert.doesNotMatch(dockerPolicySmokeScript, /spawnSync|maxBuffer: MAX_COMMAND_OUTPUT_BYTES/);
  assert.doesNotMatch(dockerPolicySmokeScript, /combinedOutput\(result\)\.includes\(requiredEvidence\)/);
  assert.match(dockerPolicySmokeScript, /"-p",\n\s+"127\.0\.0\.1::8787"/);
  assert.match(dockerPolicySmokeScript, /import \{ connect as connectTcp \} from "node:net"/);
  assert.match(dockerPolicySmokeScript, /await waitForProbe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/healthz`, "200"\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/v1\/ice`, "200", \{ origin: PRODUCTION_ORIGIN, contains: "\\"iceServers\\"" \}\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/v1\/ice`, "403", \{ origin: BAD_ORIGIN \}\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(url, status\)/);
  assert.match(dockerPolicySmokeScript, /await probeWebSocketOrigin\(port, PRODUCTION_ORIGIN, true\)/);
  assert.match(dockerPolicySmokeScript, /await probeWebSocketOrigin\(port, BAD_ORIGIN, false\)/);
  assert.match(dockerPolicySmokeScript, /function webSocketHandshakeRequest\(port, origin\)/);
  assert.match(dockerPolicySmokeScript, /"Sec-WebSocket-Version: 13"/);
  assert.match(dockerPolicySmokeScript, /Set \$\{VERBOSE_ENV\}=1 to print command output/);
  assert.match(dockerPolicySmokeScript, /export function safeChildEnv\(\)/);
  assert.match(dockerPolicySmokeScript, /\["PATH", true\]/);
  assert.doesNotMatch(dockerPolicySmokeScript, /"DOCKER_HOST"/);
  assert.doesNotMatch(dockerPolicySmokeScript, /"DOCKER_CONTEXT"/);
  assert.match(dockerPolicySmokeScript, /import \{ createIsolatedDockerConfig \} from "\.\/docker-config\.mjs"/);
  assert.match(dockerConfigScript, /export function createIsolatedDockerConfig\(prefix = "p2p-transfer-docker-", sourceConfigRoot = defaultDockerConfigRoot\(\)\)/);
  assert.match(dockerConfigScript, /mkdtempSync\(path\.join\(tmpdir\(\), prefix\)\)/);
  assert.match(dockerConfigScript, /chmodSync\(dir, 0o700\)/);
  assert.match(dockerConfigScript, /JSON\.stringify\(config\), \{ mode: 0o600 \}/);
  assert.match(dockerConfigScript, /const config = localContext \? \{ auths: \{\}, currentContext: localContext\.name \} : \{ auths: \{\} \}/);
  assert.match(dockerConfigScript, /createHash\("sha256"\)\.update\(name\)\.digest\("hex"\)/);
  assert.match(dockerConfigScript, /if \(host\.startsWith\("unix:\/\/"\)\) return path\.isAbsolute\(host\.slice\("unix:\/\/"\.length\)\)/);
  assert.match(dockerConfigScript, /npipe:[\s\S]*docker_engine/);
  assert.match(dockerConfigScript, /if \(metadata\.TLSMaterial && Object\.keys\(metadata\.TLSMaterial\)\.length > 0\) return undefined/);
  assert.match(dockerConfigScript, /openSync\(file, constants\.O_RDONLY \| noFollowFlag\(\)\)/);
  assert.match(dockerConfigScript, /if \(!opened\.isFile\(\) \|\| !sameFile\(info, opened\)\) return undefined/);
  assert.match(dockerConfigScript, /if \(!sameFile\(opened, fstatSync\(fd\)\)\) return undefined/);
  assert.match(dockerConfigScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes\)/);
  assert.doesNotMatch(dockerConfigScript, /readFileSync/);
  assert.doesNotMatch(dockerConfigScript, /tcp:\/\/|ssh:\/\/|https:\/\//);
  assert.match(dockerPolicySmokeScript, /const dockerEnv = \{ DOCKER_CONFIG: dockerConfigDir \}/);
  assert.match(dockerPolicySmokeScript, /rmSync\(dockerConfigDir, \{ recursive: true, force: true \}\)/);
  assert.match(dockerPolicySmokeScript, /function smokeErrorMessage\(error\)/);
  assert.match(dockerPolicySmokeScript, /function containsPathLikeText\(value\)/);
  assert.match(dockerPolicySmokeScript, /return "docker policy smoke failed with path-sensitive evidence\."/);
  assert.match(dockerPolicySmokeScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(dockerPolicySmokeScript, /MAX_CHILD_ENV_VALUE_BYTES = 8_192/);
  assert.match(dockerPolicySmokeScript, /const imageTag = imageTagFromEnv\(optionalEnvString\("DOCKER_SMOKE_TAG"\)\)/);
  assert.match(dockerPolicySmokeScript, /return optionalEnvString\(VERBOSE_ENV\) === "1"/);
  assert.match(dockerPolicySmokeScript, /function optionalEnvString\(name\)/);
  assert.match(dockerPolicySmokeScript, /\$\{name\} must be a non-empty control-free environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.doesNotMatch(dockerPolicySmokeScript, /process\.env\.DOCKER_SMOKE_TAG|process\.env\.DOCKER_SMOKE_VERBOSE/);
  assert.doesNotMatch(dockerPolicySmokeScript, /timer\.unref\?\.\(\)/);
  assert.doesNotMatch(dockerPolicySmokeScript, /env: \{ \.\.\.process\.env/);
  assert.match(dockerPolicySmokeScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(value\)/);
  assert.match(securityPolicy, /Docker policy smoke options and subprocesses must run with descriptor-read, non-empty, control-free, byte-capped environment values/);
  assert.match(securityPolicy, /Docker policy smoke top-level failure reporting must not print stack traces or raw path-sensitive evidence/);
  assert.match(securityPolicy, /Docker policy smoke must run a fast daemon preflight before `docker build`/);
  assert.match(securityPolicy, /command timeouts must terminate timed-out subprocesses with `SIGTERM`, arm a bounded `SIGKILL` fallback, and reject only after the subprocess exits/);
  assert.match(securityPolicy, /Docker policy smoke must validate production-policy container startup failures with bounded exact output-line evidence/);
  assert.match(securityPolicy, /not loose substring matches over arbitrary Docker output/);
  assert.match(securityPolicy, /accepts the configured production origin and rejects an untrusted origin on both the HTTP ICE endpoint and the WebSocket signaling upgrade path/);
  assert.match(securityPolicy, /`DOCKER_HOST`, or `DOCKER_CONTEXT`/);
  assert.match(securityPolicy, /send the release build context to a caller-configured remote Docker daemon/);
  assert.match(securityPolicy, /temporary 0700 `DOCKER_CONFIG` containing no credential helper or registry credentials/);
  assert.match(securityPolicy, /byte-cap, no-follow-open, identity-check, handle-read, and fatal-UTF-8-decode that source Docker config\/context metadata/);
  assert.doesNotMatch(ciWorkflow, /\bnpm\s+(?:install|ci|publish)\b|npx\b/);
});

test("release workflow is tag-only, verifies one artifact, and publishes with trusted provenance", () => {
  assert.match(securityPolicy, /release workflow is tag-only/);
  assert.match(securityPolicy, /Release publishing must use npm trusted publishing with OIDC provenance/);
  assert.match(securityPolicy, /GitHub Releases must be tag-only, run only after npm publishing succeeds, re-verify the downloaded npm tarball and SBOM/);
  assert.match(securityPolicy, /runs a pre-publish Docker validation job with the checked Docker policy smoke before npm can publish/);
  assert.match(releaseWorkflow, /tags:\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.doesNotMatch(releaseWorkflow, /pull_request:/);
  assert.doesNotMatch(releaseWorkflow, /branches:/);
  assert.match(releaseWorkflow, /Verify tag matches package version[\s\S]*run: node scripts\/check-release-tag\.mjs[\s\S]*Verify release tag is on main/);
  assert.doesNotMatch(releaseWorkflow, /readFileSync\('package\.json'|node -p|test "\$\{GITHUB_REF_NAME\}" = "v\$\{version\}"/);
  assert.match(releaseTagScript, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseTagScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseTagScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseTagScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(scriptPath\)/);
  assert.match(releaseTagScript, /await lstat\(file\)[\s\S]*await open\(file, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)[\s\S]*if \(!sameFile\(info, opened\)\)/);
  assert.match(releaseTagScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(buffer\)/);
  assert.match(releaseTagScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(releaseTagScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(descriptor\.value\)/);
  assert.match(releaseTagScript, /\$\{name\} must be a non-empty control-free string under \$\{MAX_RELEASE_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseTagScript, /envString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(releaseTagScript, /envString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(releaseTagScript, /release tag does not match package version\./);
  assert.doesNotMatch(releaseTagScript, /process\.env\.GITHUB_REF_NAME|readFile\(file, "utf8"\)|String\(error\)|error\.stack|release tag \$\{value\} does not match/);
  assert.match(securityPolicy, /release tag commit must exactly match protected `main` before release artifact packaging, attestation, npm publish, Docker publish, or GitHub Release creation/);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  assert.match(releaseWorkflow, /Verify release tag is on main[\s\S]*run: node scripts\/check-release-main\.mjs[\s\S]*Release controls preflight/);
  assert.doesNotMatch(releaseWorkflow, /git fetch --no-tags|git merge-base --is-ancestor "\$GITHUB_SHA"/);
  assert.match(releaseMainScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseMainScript, /const GIT_TIMEOUT_MS = 120_000/);
  assert.match(releaseMainScript, /const CHILD_KILL_GRACE_MS = 5_000/);
  assert.match(releaseMainScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(releaseMainScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(descriptor\.value\)/);
  assert.match(releaseMainScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(value\)/);
  assert.match(releaseMainScript, /\$\{name\} must be a non-empty control-free string under \$\{MAX_RELEASE_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseMainScript, /\$\{name\} must be a non-empty control-free child environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseMainScript, /import \{ spawn \} from "node:child_process"/);
  assert.match(releaseMainScript, /const child = spawn\("git", args/);
  assert.match(releaseMainScript, /stdio: "ignore"/);
  assert.match(releaseMainScript, /timeoutError = new Error\(`\$\{failureMessage\} Git subprocess timed out\.`\)/);
  assert.match(releaseMainScript, /child\.kill\("SIGTERM"\)/);
  assert.match(releaseMainScript, /killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(releaseMainScript, /child\.on\("exit", \(code\) => \{[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.doesNotMatch(releaseMainScript, /spawnSync|maxBuffer|encoding: "utf8"|stdio: \["ignore", "pipe", "pipe"\]/);
  assert.match(releaseMainScript, /\["fetch", "--no-tags", "--prune", "origin", "\+refs\/heads\/main:refs\/remotes\/origin\/main"\]/);
  assert.match(releaseMainScript, /\["merge-base", "--is-ancestor", sha, "origin\/main"\]/);
  assert.match(releaseMainScript, /\["merge-base", "--is-ancestor", "origin\/main", sha\]/);
  assert.match(releaseMainScript, /release tag commit does not match current main\./);
  assert.match(releaseMainScript, /import \{ devNull \} from "node:os"/);
  assert.match(releaseMainScript, /GIT_CONFIG_GLOBAL: devNull/);
  assert.match(releaseMainScript, /GIT_CONFIG_NOSYSTEM: "1"/);
  assert.match(releaseMainScript, /GIT_TERMINAL_PROMPT: "0"/);
  assert.doesNotMatch(releaseMainScript, /process\.env\.GITHUB_SHA|String\(error\)|error\.stack|\.\.\.process\.env/);
  assert.match(securityPolicy, /release tag current-main matching must use the checked release main verifier with control-free byte-capped `GITHUB_SHA`, a control-free minimal Git child environment that ignores global and system Git config and disables terminal prompts, ignored Git output, bidirectional ancestry checks/);
  assert.match(securityPolicy, /release main checks must signal timed-out Git subprocesses, arm a bounded `SIGKILL` fallback, and reject only after the child exits/);
  assert.match(releaseWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(packageJson.scripts?.["verify:release"] ?? "", /pnpm smoke:packed && pnpm test:e2e && pnpm test:browser && pnpm security:audit && pnpm security:signatures && node scripts\/write-release-notes\.mjs --check && pnpm smoke:release-artifact/);
  assert.equal(packageJson.scripts?.["verify:release:docker"], "pnpm verify:release && pnpm smoke:docker-policy");
  assert.match(releaseArtifactSmokeScript, /const pnpm = process\.platform === "win32" \? "pnpm\.cmd" : "pnpm"/);
  assert.match(releaseArtifactSmokeScript, /import \{ spawn \} from "node:child_process"/);
  assert.match(releaseArtifactSmokeScript, /const CHILD_TIMEOUT_MS = 120_000/);
  assert.match(releaseArtifactSmokeScript, /const CHILD_KILL_GRACE_MS = 5_000/);
  assert.match(releaseArtifactSmokeScript, /const MIN_RELEASE_ARTIFACT_SMOKE_TMP_FREE_BYTES = 512 \* 1024 \* 1024/);
  assert.match(releaseArtifactSmokeScript, /await assertTemporaryDiskSpace\(MIN_RELEASE_ARTIFACT_SMOKE_TMP_FREE_BYTES, "release artifact smoke requires at least 512 MiB of free temporary disk space\."\)/);
  assert.match(releaseArtifactSmokeScript, /const tmp = await mkdtemp\(path\.join\(tmpdir\(\), "ff-release-artifact-smoke-"\)\)/);
  assert.match(releaseArtifactSmokeScript, /const childEnv = await privateReleaseArtifactEnv\(path\.join\(tmp, "home"\)\)/);
  assert.match(releaseArtifactSmokeScript, /await run\(pnpm, \["--config\.ignore-scripts=true", "pack", "--pack-destination", "release-artifacts"\], childEnv, \{\}, "release artifact pack"\)/);
  assert.match(releaseArtifactSmokeScript, /await run\(process\.execPath, \["scripts\/write-release-sbom\.mjs"\], childEnv, \{\}, "release SBOM generation"\)/);
  assert.match(releaseArtifactSmokeScript, /await run\(process\.execPath, \["scripts\/write-release-checksum\.mjs"\], childEnv, \{\}, "release checksum generation"\)/);
  assert.match(releaseArtifactSmokeScript, /GITHUB_REF_NAME: `v\$\{version\}`,\s+GITHUB_REF_TYPE: "tag",\s+GITHUB_REF: `refs\/tags\/v\$\{version\}`/);
  assert.match(releaseArtifactSmokeScript, /"scripts\/write-release-sbom\.mjs"/);
  assert.match(releaseArtifactSmokeScript, /"scripts\/write-release-checksum\.mjs"/);
  assert.match(releaseArtifactSmokeScript, /"scripts\/verify-release-artifact\.mjs"/);
  assert.match(releaseArtifactSmokeScript, /GITHUB_REF_NAME: `v\$\{version\}`/);
  for (const writer of [releaseSbomScript, releaseChecksumScript, releaseNotesScript]) {
    assert.match(writer, /function isMain\(\) \{/);
    assert.match(writer, /return realpathSync\(process\.argv\[1\]\) === realpathSync\(scriptPath\)/);
    assert.match(writer, /return pathToFileURL\(process\.argv\[1\]\)\.href === import\.meta\.url/);
    assert.doesNotMatch(writer, /const isDirectEntrypoint = /);
  }
  assert.match(releaseArtifactSmokeScript, /const options = parseArgs\(process\.argv\.slice\(2\)\)/);
  assert.match(releaseArtifactSmokeScript, /args\.length === 1 && args\[0\] === "--keep-artifacts"/);
  assert.match(releaseArtifactSmokeScript, /if \(!options\.keepArtifacts\) await rm\(artifactDir, \{ recursive: true, force: true \}\)/);
  assert.match(releaseArtifactSmokeScript, /import \{ assertTemporaryDiskSpace, isolatedChildEnv \} from "\.\/smoke-packed\.mjs"/);
  assert.match(releaseArtifactSmokeScript, /await mkdir\(env\.XDG_CONFIG_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releaseArtifactSmokeScript, /await mkdir\(env\.PNPM_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releaseArtifactSmokeScript, /await mkdir\(env\.COREPACK_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releaseArtifactSmokeScript, /env: \{ \.\.\.childEnv, \.\.\.env \}/);
  assert.match(releaseArtifactSmokeScript, /stdio: "ignore"/);
  assert.match(releaseArtifactSmokeScript, /timeoutError = new Error\(`\$\{label\} timed out\.`\)/);
  assert.match(releaseArtifactSmokeScript, /child\.kill\("SIGTERM"\)/);
  assert.match(releaseArtifactSmokeScript, /killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(releaseArtifactSmokeScript, /child\.on\("exit", \(code, signal\) => \{[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.match(releaseArtifactSmokeScript, /function childExitStatus\(code, signal\)/);
  assert.match(releaseArtifactSmokeScript, /failed with \$\{childExitStatus\(code, signal\)\}\./);
  assert.doesNotMatch(releaseArtifactSmokeScript, /spawnSync|encoding: "utf8"|timeout: 120_000|args\.join|stdout|stderr/);
  assert.doesNotMatch(releaseArtifactSmokeScript, /env: \{ \.\.\.process\.env/);
  assert.doesNotMatch(releaseArtifactSmokeScript, /safeChildEnv\(\)/);
  assert.match(releaseArtifactSmokeScript, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseArtifactSmokeScript, /await lstat\(filePath\)[\s\S]*await open\(filePath, noFollowReadFlags\(\)\)[\s\S]*if \(!sameFile\(info, stat\)\)/);
  assert.match(releaseArtifactSmokeScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes\)/);
  assert.doesNotMatch(releaseArtifactSmokeScript, /readFile\(path\.join\(root, "package\.json"\)/);
  assert.match(securityPolicy, /release-artifact smoke must run `pnpm pack`, CycloneDX SBOM generation, checksum generation, and release-artifact verification with the same minimal allowlisted child environment/);
  assert.match(securityPolicy, /release-artifact smoke must preflight temporary filesystem capacity before creating its private workspace or starting package-manager work/);
  assert.match(securityPolicy, /release-artifact smoke top-level failure reporting must not print stack traces or raw path-sensitive evidence/);
  assert.match(securityPolicy, /release-artifact smoke command timeouts must signal the child, arm a bounded `SIGKILL` fallback, reject only after the child exits, and ignore child stdout\/stderr/);
  assert.match(releaseArtifactSmokeScript, /await rm\(artifactDir, \{ recursive: true, force: true \}\)/);
  assert.match(releaseArtifactSmokeScript, /Release artifact smoke failed:/);
  assert.match(releaseArtifactSmokeScript, /function containsPathLikeText\(value\)/);
  assert.match(releaseArtifactSmokeScript, /return "release artifact smoke failed with path-sensitive evidence\."/);
  assert.match(releaseArtifactSmokeScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(releaseWorkflow, /release docker image[\s\S]*needs:\n      - publish[\s\S]*environment: npm[\s\S]*permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write/);
  assert.match(releaseWorkflow, /pre-publish docker validation[\s\S]*needs:\n      - verify\n      - platform-smoke[\s\S]*permissions:\n      contents: read[\s\S]*Validate release Docker image[\s\S]*DOCKER_SMOKE_TAG=p2p-transfer:release-gate node scripts\/smoke-docker-policy\.mjs/);
  assert.match(releaseWorkflow, /release docker image[\s\S]*actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0[\s\S]*node-version: 22\.22\.3[\s\S]*node scripts\/prepare-checked-pnpm\.mjs[\s\S]*Build, smoke, and stage image[\s\S]*run: node scripts\/publish-docker-image\.mjs[\s\S]*Promote attested image[\s\S]*DOCKER_STAGED_DIGEST: \$\{\{ steps\.docker_image\.outputs\.digest \}\}[\s\S]*run: node scripts\/publish-docker-image\.mjs --promote/);
  assert.match(releaseWorkflow, /release docker image[\s\S]*subject-name: \$\{\{ steps\.docker_image\.outputs\.image \}\}[\s\S]*subject-digest: \$\{\{ steps\.docker_image\.outputs\.digest \}\}[\s\S]*push-to-registry: true/);
  assert.match(dockerPublishScript, /env: \{ DOCKER_SMOKE_TAG: stagedRef \}/);
  assert.match(dockerPublishScript, /await run\("docker", \["push", stagedRef\]/);
  assert.match(dockerPublishScript, /if \(mode === "promote"\) \{[\s\S]*dockerDigest\(requiredEnvString\("DOCKER_STAGED_DIGEST"\)\)[\s\S]*await run\("docker", \["pull", `\$\{image\}@\$\{digest\}`\]/);
  assert.match(dockerPublishScript, /await run\("docker", \["push", versionRef\]/);
  assert.match(dockerPublishScript, /await run\("docker", \["push", plainVersionRef\]/);
  assert.match(dockerPublishScript, /if \(aliasDigest !== digest\) throw new Error\("docker release tag aliases resolved to different digests\."\)/);
  assert.match(dockerPublishScript, /writeGithubOutput\(\{ image, digest, tag: versionRef, alias: plainVersionRef \}\)/);
  assert.match(dockerPublishScript, /import \{ createIsolatedDockerConfig \} from "\.\/docker-config\.mjs"/);
  assert.match(dockerPublishScript, /createIsolatedDockerConfig\("p2p-transfer-docker-release-"\)/);
  assert.match(securityPolicy, /release Docker publishing must read package metadata through no-follow regular-file opens with exact-size handle reads and pre\/post-read identity checks/);
  assert.match(securityPolicy, /emit the staged digest through checked `GITHUB_OUTPUT` no-follow regular-file appends with size and identity checks/);
  assert.match(dockerPublishScript, /const MAX_GITHUB_OUTPUT_BYTES = 1024 \* 1024/);
  assert.match(dockerPublishScript, /await open\(file, constants\.O_WRONLY \| constants\.O_APPEND \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(dockerPublishScript, /if \(!opened\.isFile\(\) \|\| !sameFile\(info, opened\)\) throw new Error\("GitHub output path is invalid\."\)/);
  assert.doesNotMatch(dockerPublishScript, /appendFile/);
  assert.match(dockerPublishScript, /package version is not an exact release semver/);
  assert.match(dockerPublishScript, /release tag is not an exact release tag/);
  assert.match(dockerPublishScript, /await lstat\(file\)/);
  assert.match(dockerPublishScript, /await open\(file, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(dockerPublishScript, /if \(!sameFile\(info, opened\)\) throw new Error\("package metadata changed before verification\."\)/);
  assert.match(dockerPublishScript, /const afterRead = await handle\.stat\(\);[\s\S]*if \(!sameFile\(opened, afterRead\)\) throw new Error\("package metadata changed while being read\."\)/);
  assert.match(dockerPublishScript, /\^\(\?:0\|\[1-9\]\\d\*\)\\\.\(\?:0\|\[1-9\]\\d\*\)\\\.\(\?:0\|\[1-9\]\\d\*\)\$/);
  assert.match(dockerPublishScript, /import \{ safeChildEnv \} from "\.\/smoke-packed\.mjs"/);
  assert.match(dockerPublishScript, /env: \{ \.\.\.safeChildEnv\(\), \.\.\.\(options\.env \?\? \{\}\) \}/);
  assert.doesNotMatch(dockerPublishScript, /env: \{ \.\.\.process\.env|DOCKER_HOST|DOCKER_CONTEXT|NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /corepack prepare pnpm@/);
  assert.match(releaseWorkflow, /pnpm check:install-state[\s\S]*pnpm security:dependencies[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed[\s\S]*pnpm test:e2e[\s\S]*pnpm test:browser[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures[\s\S]*Verify release notes[\s\S]*pack release artifact/);
  assert.match(releaseWorkflow, /Verify release notes[\s\S]*node scripts\/write-release-notes\.mjs --check[\s\S]*pack release artifact[\s\S]*node scripts\/smoke-release-artifact\.mjs --keep-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /pack release artifact[\s\S]*(rm -rf release-artifacts|mkdir -p release-artifacts|pnpm --config\.ignore-scripts=true pack --pack-destination release-artifacts|node scripts\/write-release-checksum\.mjs)/);
  assert.match(releaseSbomScript, /spawn\(pnpm, \["sbom", "--sbom-format", "cyclonedx", "--prod", "--sbom-type", "application"\]/);
  assert.match(releaseSbomScript, /await writeFile\(path\.join\(artifactDir, SBOM_NAME\), sbomText, \{ flag: "wx" \}\)/);
  assert.match(releaseChecksumScript, /return `\$\{packedPackageName\(name\)\}-\$\{version\}\.tgz`[\s\S]*const expectedTarballName = expectedTarballNameFor\(packageJson\)[\s\S]*entries\.length !== 2[\s\S]*entry\.name === expectedTarballName[\s\S]*entry\.name === SBOM_NAME[\s\S]*const tarballChecksum = createHash\("sha256"\)[\s\S]*const sbomChecksum = createHash\("sha256"\)[\s\S]*writeFile\(path\.join\(artifactDir, "SHA256SUMS"\), `\$\{tarballChecksum\}  \$\{expectedTarballName\}\\n\$\{sbomChecksum\}  \$\{SBOM_NAME\}\\n`, \{ flag: "wx" \}\)/);
  assert.match(releaseChecksumScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseChecksumScript, /const artifactDir = await verifiedArtifactDir\(\)/);
  assert.match(releaseNotesScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseNotesScript, /writeFile\(path\.join\(await verifiedArtifactDir\(\), "RELEASE_NOTES\.md"\), notes, \{ flag: "wx" \}\)/);
  assert.match(securityPolicy, /release checksum, SBOM, and release-notes writers must verify `release-artifacts` is a real directory inside the project root/);
  assert.match(releaseChecksumScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseChecksumScript, /const MAX_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(releaseChecksumScript, /constants\.O_NOFOLLOW/);
  assert.match(releaseChecksumScript, /await lstat\(filePath\)[\s\S]*await open\(filePath, noFollowReadFlags\(\)\)[\s\S]*if \(!sameFile\(info, stat\)\)[\s\S]*readVerifiedHandleBytes\(handle, stat\.size, description\)[\s\S]*if \(opened\.size !== stat\.size \|\| !sameFile\(stat, opened\)\)/);
  assert.match(releaseChecksumScript, /async function readVerifiedHandleBytes\(handle, size, description\)[\s\S]*Buffer\.alloc\(size\)[\s\S]*await handle\.read\(buffer, offset, size - offset, offset\)[\s\S]*if \(offset !== size\)/);
  assert.doesNotMatch(releaseChecksumScript, /handle\.readFile\(/);
  assert.match(releaseChecksumScript, /Release checksum generation failed:/);
  assert.match(releaseChecksumScript, /function releaseChecksumErrorMessage\(error\)[\s\S]*containsAbsolutePathText\(error\.message\)/);
  assert.doesNotMatch(releaseChecksumScript, /execFileSync|child_process|sha256sum|find release-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /pack release artifact[\s\S]*(find release-artifacts|basename "\$tgz"|sha256sum)/);
  assert.match(releaseWorkflow, /verify downloaded release artifact[\s\S]*node scripts\/verify-release-artifact\.mjs/);
  assert.match(releaseArtifactScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseArtifactScript, /const releaseArtifactDir = await verifiedArtifactDir\(\)/);
  assert.match(releaseArtifactScript, /release artifact directory must be a real directory/);
  assert.match(securityPolicy, /release artifact verification must use the checked script with a symlink-safe realpath entrypoint check and verifier-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, verify `release-artifacts` is a real directory inside the project root before listing or opening release evidence/);
  assert.match(securityPolicy, /validate artifact directory entry names before sorting, filtering, or reporting them/);
  assert.match(securityPolicy, /reject control\/format\/path-shaped or over-byte-budget entry names without echoing them/);
  assert.match(securityPolicy, /require control-free byte-capped `GITHUB_OUTPUT` paths before appending verifier output/);
  assert.match(securityPolicy, /prove the downloaded artifact directory contains only `SHA256SUMS`, `SBOM\.cdx\.json`, and the expected tarball/);
  assert.match(securityPolicy, /release artifact verification must extract exactly one regular-file `package\/package\.json` with bounded in-process gzip\/tar parsing/);
  assert.match(securityPolicy, /reject invalid gzip archives with verifier-owned deterministic errors/);
  assert.match(securityPolicy, /release artifact verification must fatal-UTF-8-decode workspace metadata, checksum files, tar header text, and packed metadata through verifier-owned deterministic errors/);
  assert.match(securityPolicy, /release artifact verification must cap the checked workspace `package\.json files` expansion by file count and total bytes before hashing expected package files/);
  assert.match(securityPolicy, /release artifact verification must reject packed package install lifecycle scripts, validate the checked workspace package manager as an exact hash-pinned `pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]+` pin, require packed metadata to omit the workspace-only `packageManager` field that real `pnpm pack` removes/);
  assert.match(releaseArtifactScript, /const MAX_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_EXPECTED_PACKED_FILES = 4096/);
  assert.match(releaseArtifactScript, /const MAX_EXPECTED_PACKED_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseArtifactScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseArtifactScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(releaseArtifactScript, /console\.error\("Release artifact verification failed:"\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactErrorMessage\(error\)/);
  assert.match(releaseArtifactScript, /function containsAbsolutePathText\(value\)/);
  assert.match(releaseArtifactScript, /function parseArgs\(args\)/);
  assert.match(releaseArtifactScript, /args\.length === 1 && args\[0\] === "--print-tarball"/);
  assert.match(releaseArtifactScript, /args\.length === 2 && args\[0\] === "--github-output" && args\[1\] === "tarball"/);
  assert.match(releaseArtifactScript, /async function writeGithubOutput\(name, value\)/);
  assert.match(releaseArtifactScript, /const outputPath = githubOutputPath\(\)/);
  assert.match(releaseArtifactScript, /function githubOutputPath\(\)/);
  assert.match(releaseArtifactScript, /\$\{name\} must be a non-empty control-free string under \$\{maxBytes\} UTF-8 bytes\./);
  assert.match(releaseArtifactScript, /Object\.getOwnPropertyDescriptor\(process\.env, "GITHUB_OUTPUT"\)/);
  assert.match(releaseArtifactScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(descriptor\.value\)[\s\S]*throw new Error\("GITHUB_OUTPUT must be a non-empty control-free path\."\)/);
  assert.match(releaseArtifactScript, /await handle\.writeFile\(`\$\{name\}=\$\{value\}\\n`, "utf8"\)/);
  assert.match(releaseArtifactScript, /function verifiedTarballPath\(tarball\)/);
  assert.match(releaseArtifactScript, /relative !== path\.join\("release-artifacts", tarball\.basename\)/);
  assert.doesNotMatch(releaseArtifactScript, /process\.cwd\(\)/);
  assert.match(releaseArtifactScript, /const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\(`\$\{path\.relative\(root, file\)\} changed before verification\.`\)/);
  assert.match(releaseArtifactScript, /return await readHandleText\(handle, opened\.size, path\.relative\(root, file\)\)/);
  assert.doesNotMatch(releaseArtifactScript, /readFile\(file, "utf8"\)/);
  assert.match(releaseArtifactScript, /const MAX_PACKED_PACKAGE_JSON_BYTES = 64 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_TAR_SCAN_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_CHECKSUM_FILE_BYTES = 512/);
  assert.match(releaseArtifactScript, /const MAX_SBOM_BYTES = 1024 \* 1024/);
  assert.match(releaseArtifactScript, /requiredPackageVersion\(expected\.version\)/);
  assert.match(releaseArtifactScript, /assertPackedPackageMetadataMatchesWorkspace\(expected, packed\)/);
  assert.match(releaseArtifactScript, /function releasePackageMetadata\(record, label, options\)/);
  assert.match(releaseArtifactScript, /function assertNoInstallLifecycleScripts\(scripts, label\)/);
  assert.match(releaseArtifactScript, /new Set\(\["preinstall", "install", "postinstall", "prepare"\]\)/);
  assert.match(releaseArtifactScript, /const expectedMetadata = releasePackageMetadata\(expected, "package\.json", \{ packageManager: "required" \}\)/);
  assert.match(releaseArtifactScript, /const packedMetadata = releasePackageMetadata\(packed, "package\/package\.json", \{ packageManager: "forbidden" \}\)/);
  assert.match(releaseArtifactScript, /delete expectedMetadata\.packageManager/);
  assert.match(releaseArtifactScript, /function exactPackageManager\(value, label\)/);
  assert.match(releaseArtifactScript, /label\} packageManager must be an exact hash-pinned pnpm version/);
  assert.match(releaseArtifactScript, /publishConfig: exactPublishConfig\(requiredPlainRecord\(record, "publishConfig", label\)/);
  assert.match(releaseArtifactScript, /function exactPublishConfig\(record, label\)/);
  assert.match(releaseArtifactScript, /ownValue\(record, "access"\) !== "public"/);
  assert.match(releaseArtifactScript, /ownValue\(record, "provenance"\) !== true/);
  assert.match(releaseArtifactScript, /function canonicalJsonValue\(value, label\)/);
  assert.match(releaseArtifactScript, /type: exactStringField\(record, "type", label\)/);
  assert.match(releaseArtifactScript, /engines: canonicalStringRecord\(requiredPlainRecord\(record, "engines", label\)/);
  assert.match(releaseArtifactScript, /bin: canonicalStringRecord\(requiredPlainRecord\(record, "bin", label\)/);
  assert.match(releaseArtifactScript, /dependencies: canonicalStringRecord\(requiredPlainRecord\(record, "dependencies", label\)/);
  assert.match(releaseArtifactScript, /installAndImportMetadata: canonicalOptionalJsonFields\(record, label, \[/);
  assert.match(releaseArtifactScript, /"optionalDependencies"/);
  assert.match(releaseArtifactScript, /"exports"/);
  assert.match(releaseArtifactScript, /"bundleDependencies"/);
  assert.match(releaseArtifactScript, /function canonicalOptionalJsonFields\(record, label, keys\)/);
  assert.match(releaseArtifactScript, /present: false/);
  assert.match(releaseArtifactScript, /present: true, value: canonicalJsonValue/);
  assert.match(releaseArtifactScript, /if \(out\.size >= MAX_EXPECTED_PACKED_FILES\) throw new Error\("package\.json files expands to too many package files\."\)/);
  assert.match(releaseArtifactScript, /state\.totalBytes \+ info\.size > MAX_EXPECTED_PACKED_BYTES/);
  assert.match(releaseArtifactScript, /const packedName = requiredPackageName\(packed\.name, "package\/package\.json name"\)/);
  assert.match(releaseArtifactScript, /const packedVersion = requiredPackageVersion\(packed\.version, "package\/package\.json version"\)/);
  assert.match(releaseArtifactScript, /requiredReleaseTag\(envString\("GITHUB_REF_NAME"\), expectedVersion\)/);
  assert.match(releaseArtifactScript, /function assertReleaseTagRef\(tag\)/);
  assert.match(releaseArtifactScript, /envString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(releaseArtifactScript, /envString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(releaseArtifactScript, /utf8ByteLengthExceeds\(descriptor\.value, maxBytes\)/);
  assert.match(releaseArtifactScript, /release tag does not match package version \$\{version\}/);
  assert.doesNotMatch(releaseArtifactScript, /release tag \$\{value\} does not match/);
  assert.match(releaseArtifactScript, /release artifact package metadata does not match the checked workspace metadata/);
  assert.doesNotMatch(releaseArtifactScript, /String\(packed\.name\)|String\(packed\.version\)/);
  assert.match(releaseArtifactScript, /const MAX_ARTIFACT_ENTRY_NAME_BYTES = 255/);
  assert.match(releaseArtifactScript, /\(await readdir\(releaseArtifactDir\)\)\.map\(releaseArtifactEntryName\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactEntryName\(value\)/);
  assert.match(releaseArtifactScript, /release-artifacts contains an invalid artifact entry name/);
  assert.match(releaseArtifactScript, /assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /release-artifacts must contain only/);
  assert.match(releaseArtifactScript, /await verifyChecksumFile\(releaseArtifactDir, tarball, sbom\)/);
  assert.match(releaseArtifactScript, /const expectedSbom = await expectedProductionSbom\(expected, expectedName, expectedVersion\)/);
  assert.match(releaseArtifactScript, /await verifySbomFile\(sbom, expectedName, expectedVersion, expectedSbom\)/);
  assert.match(releaseArtifactScript, /release SBOM production dependency inventory does not match package\.json and pnpm-lock\.yaml/);
  assert.match(releaseArtifactScript, /SHA256SUMS is not a regular file/);
  assert.match(releaseArtifactScript, /info\.size < 1 \|\| info\.size > MAX_CHECKSUM_FILE_BYTES/);
  assert.match(releaseArtifactScript, /const handle = await open\(checksumFile, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\("SHA256SUMS changed before verification\."\)/);
  assert.match(releaseArtifactScript, /const checksumText = await readHandleText\(handle, opened\.size, "SHA256SUMS"\)/);
  assert.match(releaseArtifactScript, /function readHandleText\(handle, size, label\)/);
  assert.match(releaseArtifactScript, /const buffer = Buffer\.alloc\(size\)/);
  assert.match(releaseArtifactScript, /handle\.read\(buffer, offset, size - offset, offset\)/);
  assert.match(releaseArtifactScript, /\$\{label\} changed while being read/);
  assert.match(releaseArtifactScript, /function decodeUtf8\(bytes, label\)/);
  assert.match(releaseArtifactScript, /throw new Error\(`\$\{label\} is not valid UTF-8\.`\)/);
  assert.match(releaseArtifactScript, /function parseJson\(text, label\)/);
  assert.match(releaseArtifactScript, /throw new Error\(`\$\{label\} is not valid JSON\.`\)/);
  assert.match(releaseArtifactScript, /parseJson\(await readText\(path\.join\(root, "package\.json"\), MAX_PROJECT_PACKAGE_JSON_BYTES\), "package\.json"\)/);
  assert.match(releaseArtifactScript, /return parseJson\(text, "package\/package\.json"\)/);
  assert.doesNotMatch(releaseArtifactScript, /readFile\(checksumFile, "utf8"\)/);
  assert.match(releaseArtifactScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\("release tarball changed before verification\."\)/);
  assert.match(releaseArtifactScript, /await tarball\.handle\.close\(\)/);
  assert.match(releaseArtifactScript, /tarball\.handle\.createReadStream\(\{ start: 0, end: tarball\.size - 1, autoClose: false \}\)/);
  assert.match(releaseArtifactScript, /\$\{tarball\.label \?\? "release tarball"\} changed while being read/);
  assert.match(releaseArtifactScript, /const gunzip = createGunzip\(\)/);
  assert.match(releaseArtifactScript, /const stream = source\.pipe\(gunzip\)/);
  assert.match(releaseArtifactScript, /function nextTarGzChunk\(chunks\)/);
  assert.match(releaseArtifactScript, /release tarball is not a valid gzip archive/);
  assert.match(releaseArtifactScript, /extractTarGzTextFile\(tarball, "package\/package\.json", MAX_PACKED_PACKAGE_JSON_BYTES\)/);
  assert.match(releaseArtifactScript, /let foundText/);
  assert.match(releaseArtifactScript, /release tarball contains duplicate \$\{wantedName\} entries/);
  assert.match(releaseArtifactScript, /\$\{wantedName\} is not a regular file in the release tarball/);
  assert.match(releaseArtifactScript, /if \(foundText !== undefined\) return foundText/);
  assert.match(releaseArtifactScript, /validateSkippableTarEntry\(type, size\)/);
  assert.match(releaseArtifactScript, /function validateSkippableTarEntry\(type, size\)/);
  assert.match(releaseArtifactScript, /release tarball contains an unsupported tar entry type/);
  assert.match(releaseArtifactScript, /release tarball expanded beyond the scan limit/);
  assert.match(releaseArtifactScript, /validateTarHeaderChecksum\(header\)/);
  assert.match(releaseArtifactScript, /function validateTarHeaderChecksum\(header\)/);
  assert.match(releaseArtifactScript, /index >= 148 && index < 156 \? 0x20/);
  assert.match(securityPolicy, /require the two-block tar end-of-archive marker, reject non-zero trailing archive data/);
  assert.match(releaseArtifactScript, /await validateTarEnd\(reader\)/);
  assert.match(releaseArtifactScript, /function validateTarEnd\(reader\)/);
  assert.match(releaseArtifactScript, /malformed tar end-of-archive marker/);
  assert.match(releaseArtifactScript, /non-zero data after tar end-of-archive/);
  assert.match(releaseArtifactScript, /source\.destroy\(\)/);
  assert.match(releaseArtifactScript, /gunzip\.destroy\(\)/);
  assert.match(releaseArtifactScript, /await reader\.close\(\)/);
  assert.doesNotMatch(releaseArtifactScript, /execFileSync|child_process|maxBuffer: MAX_PACKED_PACKAGE_JSON_BYTES/);
  assert.match(securityPolicy, /release publishing must packed-install smoke the exact downloaded tarball artifact immediately before `pnpm publish`/);
  assert.match(securityPolicy, /release artifact attestation must run inside the `publish` job after the `npm` environment approval gate/);
  assert.match(securityPolicy, /GHCR Docker staging\/promotion and GitHub Release creation must also run inside the protected release environment before mutating production state/);
  assert.match(securityPolicy, /attest the verified `SHA256SUMS` subjects instead of a single tarball path/);
  assert.doesNotMatch(releaseWorkflow, /\n  attest:\n/);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*environment: npm[\s\S]*node scripts\/verify-release-artifact\.mjs --github-output tarball[\s\S]*node scripts\/verify-live-release-ref\.mjs[\s\S]*uses: actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4\.1\.0[\s\S]*subject-checksums: release-artifacts\/SHA256SUMS[\s\S]*node scripts\/publish-release-artifact\.mjs/);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*needs:\n      - verify\n      - platform-smoke\n      - docker-validate/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*needs:\n      - publish\n      - docker/);
  assert.match(releaseWorkflow, /environment: npm/);
  assert.match(releaseWorkflow, /id-token: write/);
  assert.match(securityPolicy, /release publishing must pass the verifier-emitted tarball path to packed smoke and `pnpm publish` instead of rediscovering the artifact with `find` or a shell glob after verification/);
  assert.match(securityPolicy, /release publishing, Docker publishing, and GitHub Release creation must run through checked Node scripts/);
  assert.match(securityPolicy, /descriptor-read, non-empty, control-free, byte-capped allowlisted environments/);
  assert.match(securityPolicy, /wrong-repository release contexts before trusted publishing, Docker publish, GitHub API, or artifact work/);
  assert.match(securityPolicy, /private 0700 package-manager homes\/userconfig paths/);
  assert.match(securityPolicy, /release publishing and GitHub Release creation subprocess timeouts must signal the child, arm a bounded `SIGKILL` fallback, and reject only after the subprocess exits/);
  assert.match(securityPolicy, /nonzero release subprocess exits must report only the exit status or signal and must not embed captured child stdout or stderr in release logs/);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*verify, smoke, and publish release artifact[\s\S]*node scripts\/publish-release-artifact\.mjs/);
  assert.match(releasePublishScript, /rejectStaticNpmTokens\(\)/);
  assert.match(releasePublishScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(releasePublishScript, /await assertLiveReleaseRefFromEnv\(\)/);
  assert.match(releasePublishScript, /STATIC_NPM_TOKEN_ENV = \["NODE_AUTH_TOKEN", "NPM_TOKEN"\]/);
  assert.match(releasePublishScript, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(releasePublishScript, /GITHUB_ACTIONS must be true for trusted publishing/);
  assert.match(releasePublishScript, /const EXPECTED_GITHUB_REPOSITORY = "VictorHaine\/p2p-transfer"/);
  assert.match(releasePublishScript, /GITHUB_REPOSITORY must match the trusted publishing repository/);
  assert.match(releasePublishScript, /requiredEnvString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(releasePublishScript, /requiredEnvString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(releasePublishScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(value\)/);
  assert.match(releasePublishScript, /\$\{name\} must be a non-empty control-free environment value under \$\{MAX_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releasePublishScript, /isolatedChildEnv\(privateHome\)/);
  assert.match(releasePublishScript, /await mkdir\(privateHome, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releasePublishScript, /await mkdir\(env\.XDG_CONFIG_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releasePublishScript, /await mkdir\(env\.PNPM_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releasePublishScript, /await mkdir\(env\.COREPACK_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(releasePublishScript, /PACKED_SMOKE_TARBALL: tarball/);
  assert.match(releasePublishScript, /verifiedTarballPath\(\{ \.\.\.childEnv, \.\.\.releaseVerifierEnv\(tag\) \}\)/);
  assert.match(releasePublishScript, /function releaseVerifierEnv\(tag\) \{[\s\S]*GITHUB_REF_NAME: tag[\s\S]*GITHUB_REF_TYPE: "tag"[\s\S]*GITHUB_REF: `refs\/tags\/\$\{tag\}`/);
  assert.doesNotMatch(releasePublishScript, /verifiedTarballPath\(\{ \.\.\.childEnv, GITHUB_REF_NAME: tag \}\)/);
  assert.match(releasePublishScript, /const NPM_REGISTRY = "https:\/\/registry\.npmjs\.org"/);
  assert.match(releasePublishScript, /\["publish", tarball, "--provenance", "--access", "public", "--registry", NPM_REGISTRY, "--tag", "latest", "--ignore-scripts"\]/);
  assert.match(securityPolicy, /only the checked release publisher may publish the verifier-selected tarball with `--ignore-scripts`/);
  assert.match(releasePublishScript, /timeoutError = new Error\("release publish subprocess timed out\."\);\s*child\.kill\("SIGTERM"\);\s*killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), 5_000\);/s);
  assert.match(releasePublishScript, /child\.on\("exit", \(code, signal\) => \{[\s\S]*if \(killTimer\) clearTimeout\(killTimer\);[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.match(releasePublishScript, /release publish subprocess failed with \$\{childExitStatus\(code, signal\)\}\./);
  assert.doesNotMatch(releasePublishScript, /release publish subprocess failed[\s\S]*stdout:/);
  assert.doesNotMatch(releasePublishScript, /release publish subprocess failed[\s\S]*stderr:/);
  assert.doesNotMatch(releasePublishScript, /env: \{ \.\.\.process\.env|process\.env\.NODE_AUTH_TOKEN|process\.env\.NPM_TOKEN/);
  assert.match(securityPolicy, /GitHub Release job must run only after npm and Docker publishing succeed, run inside the protected `npm` environment, reject non-Actions repository\/run contexts before artifact or API work, re-verify the downloaded tarball and SBOM through `scripts\/create-github-release\.mjs`/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*needs:\n      - publish\n      - docker[\s\S]*environment: npm[\s\S]*permissions:\n      contents: write[\s\S]*node scripts\/create-github-release\.mjs/);
  assert.match(githubReleaseScript, /requiredReleaseTag\(requiredEnvString\("GITHUB_REF_NAME"\)\)/);
  assert.match(githubReleaseScript, /requiredEnvString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(githubReleaseScript, /requiredEnvString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(githubReleaseScript, /const sha = requiredCommitSha\(requiredEnvString\("GITHUB_SHA"\)\)/);
  assert.match(githubReleaseScript, /const API = "https:\/\/api\.github\.com"/);
  assert.match(githubReleaseScript, /const EXPECTED_GITHUB_REPOSITORY = "VictorHaine\/p2p-transfer"/);
  assert.match(githubReleaseScript, /const token = requiredEnvString\("GH_TOKEN"\)/);
  assert.match(githubReleaseScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(githubReleaseScript, /const token = requiredEnvString\("GH_TOKEN"\);\n  requiredGitHubActionsContext\(\);\n  await assertLiveReleaseRefFromEnv\(\);\n  const tmp = await mkdtemp/);
  assert.match(githubReleaseScript, /verifiedTarballPath\(\{ \.\.\.childEnv, GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs\/tags\/\$\{tag\}` \}\)/);
  assert.match(githubReleaseScript, /\/repos\/\$\{repository\}\/git\/ref\/tags\/\$\{tag\}/);
  assert.match(githubReleaseScript, /if \(\(await githubReleaseTagCommitSha\(token, repository, tag\)\) !== expectedSha\) throw new Error\("GitHub tag ref does not match the release workflow commit\."\)/);
  assert.match(githubReleaseScript, /\/repos\/\$\{repository\}\/releases/);
  assert.match(githubReleaseScript, /uploadReleaseAsset\(token, uploadUrl, asset\)/);
  assert.match(githubReleaseScript, /draft: true/);
  assert.match(githubReleaseScript, /await publishDraftRelease\(token, repository, id\)/);
  assert.match(githubReleaseScript, /await reconcileDraftPublishFailure\(token, repository, id, tag\)\.catch\(\(\) => false\)/);
  assert.match(githubReleaseScript, /if \(state === "published"\) return true/);
  assert.match(githubReleaseScript, /await deleteDraftRelease\(token, repository, id\)\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(githubReleaseScript, /"gh"|gh release create|"--verify-tag"/);
  assert.match(githubReleaseScript, /requiredRepository\(requiredEnvString\("GITHUB_REPOSITORY"\)\)/);
  assert.match(githubReleaseScript, /GITHUB_REPOSITORY must match the release repository/);
  assert.match(githubReleaseScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(value\)/);
  assert.match(githubReleaseScript, /\$\{name\} must be a non-empty control-free environment value under \$\{MAX_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(githubReleaseScript, /await mkdir\(privateHome, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(githubReleaseScript, /await mkdir\(env\.XDG_CONFIG_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(githubReleaseScript, /await mkdir\(env\.PNPM_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(githubReleaseScript, /await mkdir\(env\.COREPACK_HOME, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(githubReleaseScript, /\["scripts\/write-release-notes\.mjs"\]/);
  assert.match(githubReleaseScript, /await createGitHubRelease\(token, repository, tag, sha, notes, assets, assertLiveReleaseRefFromEnv\)/);
  assert.match(githubReleaseScript, /await readArtifactFile\(tarball, 50 \* 1024 \* 1024, "release tarball"\)/);
  assert.match(githubReleaseScript, /while \(offset < opened\.size\) \{[\s\S]*await handle\.read\(bytes, offset, opened\.size - offset, offset\)[\s\S]*offset \+= bytesRead/);
  assert.match(githubReleaseScript, /await readArtifactFile\("release-artifacts\/SHA256SUMS", MAX_CHECKSUM_BYTES, "SHA256SUMS"\)/);
  assert.match(githubReleaseScript, /await readArtifactFile\("release-artifacts\/SBOM\.cdx\.json", MAX_SBOM_BYTES, "release SBOM"\)/);
  assert.match(githubReleaseScript, /const afterRead = await handle\.stat\(\);[\s\S]*if \(!sameFile\(opened, afterRead\)\) throw new Error\(`\$\{description\} changed while being read\.`\)/);
  assert.match(githubReleaseScript, /assetNames\.filter\(\(name\) => name\.endsWith\("\.tgz"\)\)\.length !== 1/);
  assert.match(githubReleaseScript, /!assetNames\.includes\("SHA256SUMS"\) \|\| !assetNames\.includes\("SBOM\.cdx\.json"\)/);
  assert.match(githubReleaseScript, /assertReleaseAssetChecksums\(assets\)/);
  assert.match(githubReleaseScript, /function assertReleaseAssetChecksums\(assets\) \{[\s\S]*SHA256SUMS[\s\S]*SBOM\.cdx\.json[\s\S]*sha256Hex\(tarball\.bytes\)[\s\S]*sha256Hex\(sbom\.bytes\)/);
  assert.match(githubReleaseScript, /timeoutError = new Error\("GitHub Release subprocess timed out\."\);\s*child\.kill\("SIGTERM"\);\s*killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), 5_000\);/s);
  assert.match(githubReleaseScript, /child\.on\("exit", \(code, signal\) => \{[\s\S]*if \(killTimer\) clearTimeout\(killTimer\);[\s\S]*if \(timeoutError\) \{[\s\S]*rejectOnce\(timeoutError\);[\s\S]*return;[\s\S]*\}/);
  assert.match(githubReleaseScript, /GitHub Release subprocess failed with \$\{childExitStatus\(code, signal\)\}\./);
  assert.doesNotMatch(githubReleaseScript, /GitHub Release subprocess failed[\s\S]*stdout:/);
  assert.doesNotMatch(githubReleaseScript, /GitHub Release subprocess failed[\s\S]*stderr:/);
  assert.doesNotMatch(githubReleaseScript, /env: \{ \.\.\.process\.env|--notes-file",\s+"CHANGELOG\.md"/);
  assert.doesNotMatch(releaseWorkflow, /--notes-file CHANGELOG\.md/);
  assert.doesNotMatch(releaseWorkflow, /pnpm publish release-artifacts\/\*\.tgz/);
  assert.doesNotMatch(releaseWorkflow, /smoke downloaded release artifact[\s\S]*find release-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /publish npm package[\s\S]*find release-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /tgz="\$\(node scripts\/verify-release-artifact\.mjs --print-tarball\)"|printf 'tarball=%s\\n'|test -f "\$tgz"|PACKED_SMOKE_TARBALL="\$tgz" node scripts\/smoke-packed\.mjs|pnpm publish "\$tgz"|gh release create "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(releaseWorkflow, /sha256sum -c SHA256SUMS|execFileSync\('tar'/);
  assert.match(dockerPublishScript, /DOCKER_SMOKE_TAG: stagedRef/);
  assert.match(dockerPublishScript, /if \(isMain\(\)\) \{[\s\S]*await main\(\)/);
  assert.match(dockerPublishScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(dockerPublishScript, /const EXPECTED_GITHUB_REPOSITORY = "VictorHaine\/p2p-transfer"/);
  assert.match(dockerPublishScript, /GitHub repository must match the release repository/);
  assert.match(dockerPublishScript, /const tag = releaseTag\(requiredEnvString\("GITHUB_REF_NAME"\)\);\n  assertReleaseTagRef\(tag\);\n  const repository = githubRepository\(requiredEnvString\("GITHUB_REPOSITORY"\)\);\n  const runId = requiredGitHubActionsContext\(\);\n  requiredCommitSha\(requiredEnvString\("GITHUB_SHA"\)\);\n  const actor = githubActor\(requiredEnvString\("GITHUB_ACTOR"\)\);\n  const token = requiredEnvString\("GITHUB_TOKEN", MAX_TOKEN_BYTES\);\n  const packageJson = await readPackageJson\(\);/);
  assert.match(dockerPublishScript, /import \{ safeChildEnv \} from "\.\/smoke-packed\.mjs"/);
  assert.match(dockerPublishScript, /env: \{ \.\.\.safeChildEnv\(\), \.\.\.\(options\.env \?\? \{\}\) \}/);
  assert.match(dockerPublishScript, /endChildStdin\(child, options\.input \?\? "", label/);
  assert.match(dockerPublishScript, /child\.stdin\.once\("error", onError\)/);
  assert.match(dockerPublishScript, /child\.stdin\.once\("finish", onFinish\)/);
  assert.match(dockerPublishScript, /new Error\(`\$\{label\} stdin pipe failed\.`\)/);
  assert.match(dockerPublishScript, /child\.on\("exit", \(code, signal\) => \{\n      if \(killTimer\) clearTimeout\(killTimer\);/);
  assert.match(dockerPublishScript, /function checkedChildStdin\(value\)/);
  assert.match(dockerPublishScript, /docker publish child stdin is invalid\./);
  assert.doesNotMatch(dockerPublishScript, /child\.stdin\.end\(options\.input\)|child\.stdin\.end\(\)/);
  assert.match(dockerPublishScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(dockerPublishScript, /await assertLiveReleaseRefFromEnv\(\)/);
  assert.match(liveReleaseRefScript, /export async function assertLiveReleaseRefFromEnv\(\)/);
  assert.match(liveReleaseRefScript, /\/repos\/\$\{repository\}\/git\/ref\/tags\/\$\{tag\}/);
  assert.match(liveReleaseRefScript, /\/repos\/\$\{repository\}\/git\/ref\/heads\/main/);
  assert.match(liveReleaseRefScript, /return error instanceof Error && error\.name === "AbortError"/);
  assert.match(securityPolicy, /last-mile live release-ref verifier must reject ambiguous `GITHUB_TOKEN` plus `GH_TOKEN` input before network work, then re-check the GitHub tag ref or annotated tag object and GitHub `main` ref against `GITHUB_SHA` through bounded GitHub API calls immediately before release artifact attestation, immediately before npm publish, before Docker smoke, immediately before GHCR staging push, immediately before GHCR promotion, immediately before GitHub Release draft creation, and immediately before GitHub Release final publish/);
  assert.match(securityPolicy, /push only that staging tag before provenance[\s\S]*then promote only that attested digest to the `vX\.Y\.Z` and `X\.Y\.Z` release tags/);
  assert.match(dockerPublishScript, /await assertLiveReleaseRefFromEnv\(\);\n      const digest = dockerDigest\(requiredEnvString\("DOCKER_STAGED_DIGEST"\)\)/);
  assert.match(dockerPublishScript, /await assertLiveReleaseRefFromEnv\(\);\n    await run\("docker", \["login", REGISTRY/);
  assert.match(releaseWorkflow, /release docker image[\s\S]*environment: npm[\s\S]*run: node scripts\/publish-docker-image\.mjs[\s\S]*run: node scripts\/publish-docker-image\.mjs --promote/);
  assert.match(dockerPolicySmokeScript, /"--read-only"/);
  assert.match(dockerPolicySmokeScript, /"--cap-drop=ALL"/);
  assert.match(dockerPolicySmokeScript, /"no-new-privileges"/);
  assert.match(dockerPolicySmokeScript, /const CLI_WEBRTC_RUNTIME_PATHS = \[[\s\S]*"node_modules\/@roamhq"[\s\S]*"node_modules\/\.pnpm\/@roamhq\+wrtc-linux-x64@0\.10\.0"[\s\S]*"node_modules\/\.pnpm\/webidl-conversions@7\.0\.0"/);
  assert.match(dockerPolicySmokeScript, /await assertNoCliWebrtcRuntime\(imageTag, dockerEnv\)/);
  assert.match(securityPolicy, /Docker policy smoke must prove the final server runtime image does not contain CLI-only native WebRTC packages/);
  assert.match(releaseWorkflow, /ubuntu-24\.04/);
  assert.match(releaseWorkflow, /ubuntu-24\.04-arm/);
  assert.match(releaseWorkflow, /macos-15/);
  assert.match(releaseWorkflow, /macos-15-intel/);
  assert.match(releaseWorkflow, /windows-2025/);
  assert.doesNotMatch(releaseWorkflow, /runs-on:\s*[a-z]+-latest|-\s+[a-z]+-latest/);
  assert.match(releaseWorkflow, /- 22\.22\.3/);
  assert.match(releaseWorkflow, /- 24\.13\.1/);
  assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /\bnpm\s+(?:install|ci|publish)\b|npx\b/);
});

test("Node ambient types stay on the supported runtime major", () => {
  const runtime = packageJson.engines?.node;
  const nodeTypes = packageJson.devDependencies?.["@types/node"];
  assert.equal(runtime, ">=22.22.3 <23 || >=24.13.1 <25");
  assert.match(nodeTypes ?? "", /^22\./);
  assert.doesNotMatch(nodeTypes ?? "", /^2[345]\./);
  assert.match(pnpmLock, /^  '@types\/node@22\.\d+\.\d+':$/m);
  assert.doesNotMatch(pnpmLock, /@types\/node@2[345]\./);
  assert.match(pnpmWorkspace, /overrides:\n\s+"@types\/node": 22\.13\.14\n\s+undici-types: 6\.19\.1/);
  assert.match(pnpmLock, /overrides:\n\s+'@types\/node': 22\.13\.14\n\s+undici-types: 6\.19\.1/);
  assert.match(pnpmLock, /^  undici-types@6\.19\.1:$/m);
  assert.doesNotMatch(pnpmLock, /undici-types@6\.2[01]\./);
  assert.doesNotMatch(pnpmLock, /undici-types@7\./);
});

test("package install scripts are restricted to the required native tooling", () => {
  const allowedBuilds = new Set(parseAllowBuilds(pnpmWorkspace));
  assert.equal(packageJson.pnpm, undefined);
  assert.doesNotMatch(pnpmWorkspace, /\bonlyBuiltDependencies\b/);
  assert.doesNotMatch(pnpmWorkspace, /\bignoredBuiltDependencies\b/);
  assert.doesNotMatch(pnpmWorkspace, /\bneverBuiltDependencies\b/);
  assert.match(pnpmWorkspace, /^strictDepBuilds: true$/m);
  assert.deepEqual([...allowedBuilds].sort(), ["@roamhq/wrtc", "esbuild"]);
  assert.match(nativeWebrtcReview, /`@roamhq\/wrtc` is in `allowBuilds` because this native dependency is the only production package allowed to run reviewed dependency build tooling/);
  assert.match(buildToolchainNativeReview, /`pnpm-workspace\.yaml` has `strictDepBuilds: true`/);
  assert.match(buildToolchainNativeReview, /The only allowed dependency build scripts are `@roamhq\/wrtc` and `esbuild`/);
  assert.match(buildToolchainNativeReview, /`esbuild` is allowed because its registry consumer install uses `postinstall: node install\.js`/);
  assert.match(buildToolchainNativeReview, /`rolldown` and `lightningcss` are not in `allowBuilds`/);
});

test("build-time native toolchain identity and install surface stay reviewed", () => {
  assert.match(
    securityPolicy,
    /release build-time native and wasm-capable tooling metadata, optional native\/wasm package sets, lifecycle hooks, allowed build-script surface, and lockfile integrity must stay reviewed/
  );
  assert.equal(packageJson.devDependencies?.vite, "8.0.14");

  assert.equal(vitePackageJson.name, "vite");
  assert.equal(vitePackageJson.version, packageJson.devDependencies?.vite);
  assert.equal(vitePackageJson.license, "MIT");
  assert.deepEqual(vitePackageJson.repository, {
    type: "git",
    url: "git+https://github.com/vitejs/vite.git",
    directory: "packages/vite"
  });
  assert.equal(vitePackageJson.type, "module");
  assert.deepEqual(vitePackageJson.bin, { vite: "bin/vite.js" });
  assert.deepEqual(vitePackageJson.files, ["bin", "dist", "misc/**/*.js", "client.d.ts", "types"]);
  assert.equal(vitePackageJson.dependencies?.lightningcss, "^1.32.0");
  assert.equal(vitePackageJson.dependencies?.rolldown, "1.0.2");
  assert.equal(vitePackageJson.dependencies?.postcss, "^8.5.15");
  assert.equal(vitePackageJson.dependencies?.picomatch, "^4.0.4");
  assert.equal(vitePackageJson.dependencies?.tinyglobby, "^0.2.16");
  assert.equal(vitePackageJson.optionalDependencies?.fsevents, "~2.3.3");
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(vitePackageJson.scripts?.[lifecycle], undefined);
  }

  assert.equal(esbuildPackageJson.name, "esbuild");
  assert.equal(esbuildPackageJson.version, "0.28.0");
  assert.equal(esbuildPackageJson.license, "MIT");
  assert.deepEqual(esbuildPackageJson.repository, {
    type: "git",
    url: "git+https://github.com/evanw/esbuild.git"
  });
  assert.equal(esbuildPackageJson.main, "lib/main.js");
  assert.equal(esbuildPackageJson.types, "lib/main.d.ts");
  assert.deepEqual(esbuildPackageJson.bin, { esbuild: "bin/esbuild" });
  assert.deepEqual(esbuildPackageJson.scripts, { postinstall: "node install.js" });
  assert.deepEqual(
    Object.fromEntries(Object.entries(esbuildPackageJson.optionalDependencies ?? {}).sort()),
    Object.fromEntries(reviewedEsbuildOptionalPackages.map((name) => [name, "0.28.0"]).sort())
  );

  assert.equal(rolldownPackageJson.name, "rolldown");
  assert.equal(rolldownPackageJson.version, "1.0.2");
  assert.equal(rolldownPackageJson.license, "MIT");
  assert.deepEqual(rolldownPackageJson.repository, {
    type: "git",
    url: "git+https://github.com/rolldown/rolldown.git",
    directory: "packages/rolldown"
  });
  assert.equal(rolldownPackageJson.type, "module");
  assert.equal(rolldownPackageJson.main, "./dist/index.mjs");
  assert.equal(rolldownPackageJson.module, "./dist/index.mjs");
  assert.equal(rolldownPackageJson.types, "./dist/index.d.mts");
  assert.deepEqual(rolldownPackageJson.bin, { rolldown: "./bin/cli.mjs" });
  assert.deepEqual(rolldownPackageJson.files, ["bin", "cli", "dist", "!dist/*.node"]);
  assert.equal(rolldownPackageJson.dependencies?.["@rolldown/pluginutils"], "^1.0.0");
  assert.equal(rolldownPackageJson.dependencies?.["@oxc-project/types"], "=0.132.0");
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(rolldownPackageJson.scripts?.[lifecycle], undefined);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(rolldownPackageJson.optionalDependencies ?? {}).sort()),
    Object.fromEntries(reviewedRolldownOptionalPackages.map((name) => [name, "1.0.2"]).sort())
  );

  assert.equal(lightningCssPackageJson.name, "lightningcss");
  assert.equal(lightningCssPackageJson.version, "1.32.0");
  assert.equal(lightningCssPackageJson.license, "MPL-2.0");
  assert.deepEqual(lightningCssPackageJson.repository, {
    type: "git",
    url: "https://github.com/parcel-bundler/lightningcss.git"
  });
  assert.equal(lightningCssPackageJson.main, "node/index.js");
  assert.equal(lightningCssPackageJson.types, "node/index.d.ts");
  assert.deepEqual(lightningCssPackageJson.files, ["node/*.js", "node/*.mjs", "node/*.d.ts", "node/*.flow"]);
  assert.equal(lightningCssPackageJson.dependencies?.["detect-libc"], "^2.0.3");
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(lightningCssPackageJson.scripts?.[lifecycle], undefined);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(lightningCssPackageJson.optionalDependencies ?? {}).sort()),
    Object.fromEntries(reviewedLightningCssOptionalPackages.map((name) => [name, "1.32.0"]).sort())
  );

  for (const [name, integrity] of Object.entries(reviewedBuildToolchainIntegrities)) {
    const [packageName, version] = splitPackageNameAndVersion(name);
    assert.match(pnpmLock, lockfilePackageIntegrityPattern(packageName, version, integrity));
    assert.match(buildToolchainNativeReview, new RegExp(`Lockfile integrity reviewed for \`${escapeRegExp(name)}\`: \`${escapeRegExp(integrity)}\``));
  }
  for (const name of reviewedEsbuildOptionalPackages) {
    assert.match(buildToolchainNativeReview, new RegExp(`\`${escapeRegExp(name)}@0\\.28\\.0\``));
  }
  for (const name of reviewedRolldownOptionalPackages) {
    assert.match(buildToolchainNativeReview, new RegExp(`\`${escapeRegExp(name)}@1\\.0\\.2\``));
  }
  for (const name of reviewedLightningCssOptionalPackages) {
    assert.match(buildToolchainNativeReview, new RegExp(`\`${escapeRegExp(name)}@1\\.32\\.0\``));
  }
  assert.match(buildToolchainNativeReview, /# Build Toolchain Native Review/);
  assert.match(buildToolchainNativeReview, /Direct build tool: `vite@8\.0\.14`/);
  assert.match(buildToolchainNativeReview, /Vite build transformer peer\/tool: `esbuild@0\.28\.0`/);
  assert.match(buildToolchainNativeReview, /Vite bundler dependency: `rolldown@1\.0\.2`/);
  assert.match(buildToolchainNativeReview, /Vite CSS dependency: `lightningcss@1\.32\.0`/);
  assert.match(buildToolchainNativeReview, /release build runs `vite build`/);
  assert.match(buildToolchainNativeReview, /This repo does not contain a formal independent audit certificate for Vite, esbuild, Rolldown, Lightning CSS, their native binaries, or their wasm bindings/);
  assert.match(securityPolicy, /Dependabot must track Vite, esbuild, esbuild platform binaries, Rolldown, Rolldown native\/wasm bindings, Lightning CSS, and Lightning CSS native packages in their own build-toolchain update group/);
  assert.match(buildToolchainNativeReview, /Dependabot must keep Vite, esbuild, esbuild platform binaries, Rolldown, Rolldown native\/wasm bindings, Lightning CSS, and Lightning CSS native packages in the dedicated `build-toolchain-dependencies` update group and excluded from the bulk development dependency group/);
  assert.match(
    dependabotConfig,
    /build-toolchain-dependencies:\n\s+patterns:\n\s+- "vite"\n\s+- "esbuild"\n\s+- "@esbuild\/\*"\n\s+- "rolldown"\n\s+- "@rolldown\/\*"\n\s+- "lightningcss"\n\s+- "lightningcss-\*"/
  );
  assert.match(
    dependabotConfig,
    /development-dependencies:\n\s+dependency-type: development\n\s+exclude-patterns:\n\s+- "vite"\n\s+- "esbuild"\n\s+- "@esbuild\/\*"\n\s+- "rolldown"\n\s+- "@rolldown\/\*"\n\s+- "lightningcss"\n\s+- "lightningcss-\*"/
  );
  assert.match(buildToolchainNativeReview, /Release must stop if any of these are true:/);
  assert.match(buildToolchainNativeReview, /`package\.json`, `pnpm-lock\.yaml`, installed package metadata, or this artifact no longer agree/);
});

test("pnpm project policy keeps installs strict and resists fresh package compromises", () => {
  assert.match(pnpmWorkspace, /^minimumReleaseAge: 10080$/m);
  assert.match(pnpmWorkspace, /^minimumReleaseAgeIgnoreMissingTime: false$/m);
  assert.match(pnpmWorkspace, /^minimumReleaseAgeStrict: true$/m);
  assert.match(pnpmWorkspace, /^trustPolicy: no-downgrade$/m);
  assert.match(pnpmWorkspace, /^blockExoticSubdeps: true$/m);
  assert.match(pnpmWorkspace, /^nodeVersion: 22\.22\.3$/m);
  assert.match(pnpmWorkspace, /^engineStrict: true$/m);
  assert.match(pnpmWorkspace, /^pmOnFail: error$/m);
  assert.match(pnpmWorkspace, /^saveExact: true$/m);
  assert.match(pnpmWorkspace, /^verifyStoreIntegrity: true$/m);
  assert.match(pnpmWorkspace, /^strictStorePkgContentCheck: true$/m);
  assert.match(pnpmWorkspace, /^autoInstallPeers: false$/m);
  assert.match(pnpmWorkspace, /^verifyDepsBeforeRun: error$/m);
});

test("known vulnerable dependency versions cannot be reintroduced", () => {
  assertAtLeast(packageJson.dependencies?.ws, "8.20.1", "ws must include the CVE-2026-45736 fix.");
  assert.equal(packageJson.dependencies?.ws, "8.21.0", "ws must stay on the reviewed patched floor until newer releases satisfy the pnpm minimum-release-age policy.");
  assertAtLeast(packageJson.devDependencies?.vite, "8.0.5", "vite must include the CVE-2026-39363/CVE-2026-39364/CVE-2026-39365 fixes.");
  assertAtLeast(packageJson.dependencies?.nanoid, "5.0.9", "nanoid must include the CVE-2024-55565 fix.");
  for (const resolved of lockfileResolvedPackages(pnpmLock).filter((entry) => entry.startsWith("nanoid@"))) {
    const version = packageVersionFromResolvedEntry(resolved);
    assertAtLeast(version, version.startsWith("3.") ? "3.3.8" : "5.0.9", `${resolved} must include the CVE-2024-55565 fix.`);
  }
});

test("critical PAKE dependency identity and install surface stay reviewed", () => {
  const pakePin = packageJson.dependencies?.["@cipherman/pake-js"];
  const curvesPin = packageJson.dependencies?.["@noble/curves"];
  assert.match(securityPolicy, /critical PAKE dependency metadata must stay reviewed and must not add install lifecycle hooks/);
  assert.match(securityPolicy, /Dependabot must track the critical `@cipherman\/pake-js` PAKE dependency in its own production update group/);
  assert.match(dependabotConfig, /critical-pake-dependency:\n\s+patterns:\n\s+- "@cipherman\/pake-js"\n\s+dependency-type: production/);
  assert.match(dependabotConfig, /direct-crypto-dependency:\n\s+patterns:\n\s+- "@noble\/curves"\n\s+- "@noble\/hashes"\n\s+dependency-type: production/);
  assert.match(dependabotConfig, /production-dependencies:\n\s+dependency-type: production\n\s+exclude-patterns:\n\s+- "@cipherman\/pake-js"\n\s+- "@noble\/curves"/);
  assert.equal(pakePin, "0.1.1");
  assert.equal(curvesPin, "1.9.7");
  assert.equal(pakePackageJson.name, "@cipherman/pake-js");
  assert.equal(pakePackageJson.version, pakePin);
  assert.equal(pakePackageJson.license, "MIT");
  assert.equal(pakePackageJson.type, "module");
  assert.equal(pakePackageJson.main, "./dist/index.cjs");
  assert.equal(pakePackageJson.types, "./dist/index.d.ts");
  assert.equal(pakePackageJson.sideEffects, false);
  assert.deepEqual(pakePackageJson.files, ["dist", "README.md", "SECURITY.md", "THREAT_MODEL.md", "CHANGELOG.md", "LICENSE"]);
  assert.deepEqual(pakePackageJson.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs"
    },
    "./spake2plus": {
      types: "./dist/spake2plus/index.d.ts",
      import: "./dist/spake2plus/index.js",
      require: "./dist/spake2plus/index.cjs"
    },
    "./cpace": {
      types: "./dist/cpace/index.d.ts",
      import: "./dist/cpace/index.js",
      require: "./dist/cpace/index.cjs"
    }
  });
  assert.deepEqual(pakePackageJson.dependencies, { "@noble/curves": "^1.6.0" });
  assert.deepEqual(pakePackageJson.repository, {
    type: "git",
    url: "git+https://github.com/alicommit-malp/pake-js.git"
  });
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
    assert.equal(pakePackageJson.scripts?.[lifecycle], lifecycle === "prepublishOnly" ? "npm run clean && npm run typecheck && npm run lint && npm run test && npm run build" : undefined);
  }
  assert.match(
    pnpmLock,
    new RegExp(`^  '@cipherman/pake-js@0\\.1\\.1':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedPakeIntegrity)}\\}`, "m")
  );
  assert.match(
    pnpmLock,
    new RegExp(`^  '@noble/curves@1\\.9\\.7':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedNobleCurvesIntegrity)}\\}`, "m")
  );
  assert.match(
    pnpmLock,
    new RegExp(`^  '@noble/hashes@1\\.8\\.0':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedNobleHashesCpaceIntegrity)}\\}`, "m")
  );
  assert.match(cpaceReview, /# CPace Dependency Review/);
  assert.match(cpaceReview, new RegExp(`Package: \`${escapeRegExp(pakePackageJson.name ?? "")}\``));
  assert.match(cpaceReview, new RegExp(`Reviewed package version: \`${escapeRegExp(pakePin ?? "")}\``));
  assert.match(cpaceReview, new RegExp(`Local pin: \`package\\.json\` pins \`@cipherman/pake-js\` to exact version \`${escapeRegExp(pakePin ?? "")}\``));
  assert.match(cpaceReview, new RegExp(`Installed package identity: \`node_modules/@cipherman/pake-js/package\\.json\` reports name \`${escapeRegExp(pakePackageJson.name ?? "")}\` and version \`${escapeRegExp(pakePackageJson.version ?? "")}\``));
  assert.match(cpaceReview, new RegExp(`License: \`${escapeRegExp(pakePackageJson.license ?? "")}\``));
  assert.match(cpaceReview, /Upstream repository: `git\+https:\/\/github\.com\/alicommit-malp\/pake-js\.git`/);
  assert.match(cpaceReview, /`cpace\.ristretto255\.init`/);
  assert.match(cpaceReview, /`cpace\.ristretto255\.deriveIskInitiatorResponder`/);
  assert.match(cpaceReview, /untrusted-signaling trust boundary/);
  assert.match(cpaceReview, /Package exports reviewed: `.`, `\.\/spake2plus`, and `\.\/cpace`; this project only depends on CPace behavior/);
  assert.match(cpaceReview, /Entrypoints reviewed in installed metadata: `type` is `module`, `main` is `\.\/dist\/index\.cjs`, and `types` is `\.\/dist\/index\.d\.ts`/);
  assert.match(cpaceReview, /Published files reviewed in installed metadata: `dist`, `README\.md`, `SECURITY\.md`, `THREAT_MODEL\.md`, `CHANGELOG\.md`, and `LICENSE`/);
  assert.match(cpaceReview, /Side-effect metadata reviewed: `sideEffects` is `false`/);
  assert.match(cpaceReview, /Consumer install lifecycle hooks reviewed: `preinstall`, `install`, `postinstall`, `prepare`, and `prepublish` are absent/);
  assert.match(cpaceReview, /`prepublishOnly` is present upstream but is not run during consumer installs/);
  assert.match(cpaceReview, /`strictDepBuilds: true`; `@cipherman\/pake-js` is not in `allowBuilds`/);
  assert.match(cpaceReview, /Direct runtime dependencies reviewed: `@cipherman\/pake-js@0\.1\.1` and `@noble\/curves@1\.9\.7`/);
  assert.match(cpaceReview, /Package runtime dependency declaration reviewed: `@noble\/curves` is declared as `\^1\.6\.0` upstream/);
  assert.match(cpaceReview, /Consumer resolution hardening reviewed: this package also declares `@noble\/curves@1\.9\.7` as a direct exact production dependency/);
  assert.match(cpaceReview, /Runtime consumer-install hardening reviewed: CLI send and receive fail closed unless the resolved package graph matches/);
  assert.match(cpaceReview, /including reviewed package metadata, dependency declarations, consumer lifecycle-hook policy, CPace\/curve\/hash import surfaces, and exact runtime-file SHA-256 evidence/);
  assert.match(cpaceReview, /Runtime resolved-file hash hardening reviewed: CLI send and receive fail closed unless the resolved crypto runtime files match the reviewed relative paths and SHA-256 digests embedded in `src\/cli\/crypto-dependencies\.ts`/);
  assert.match(cpaceReview, /`@cipherman\/pake-js\/dist\/index\.cjs`, `@cipherman\/pake-js\/dist\/index\.js`, `@cipherman\/pake-js\/dist\/cpace\/index\.cjs`, and `@cipherman\/pake-js\/dist\/cpace\/index\.js`/);
  assert.match(cpaceReview, /CPace-resolved `@noble\/curves` runtime files including `ed25519\.js`, `abstract\/\*\.js`, `nist\.js`, `p256\.js`, `_shortw_utils\.js`, and `utils\.js`/);
  assert.match(cpaceReview, /CPace-resolved `@noble\/hashes@1\.8\.0` runtime files including `sha2\.js`, `hmac\.js`, `_md\.js`, `_u64\.js`, `cryptoNode\.js`, and `utils\.js`/);
  assert.match(cpaceReview, /direct `@noble\/hashes@2\.2\.0` runtime files including `hkdf\.js`, `hmac\.js`, `sha2\.js`, `_md\.js`, `_u64\.js`, `legacy\.js`, and `utils\.js`/);
  assert.match(securityPolicy, /CLI crypto dependency runtime attestation must verify the exact resolved entry file path and SHA-256 digest/);
  assert.match(cliDependencyMetadataSource, /export function sha256FileEvidenceFromResolvedFile/);
  assert.match(cliDependencyMetadataSource, /DEFAULT_MAX_DEPENDENCY_FILE_BYTES = 2 \* 1024 \* 1024/);
  assert.match(cliDependencyMetadataSource, /sha256FileEvidenceFromResolvedFile\(resolvedFile: string, maxBytes = DEFAULT_MAX_DEPENDENCY_FILE_BYTES\)/);
  assert.match(cliDependencyMetadataSource, /createHash\("sha256"\)/);
  assert.match(cliDependencyMetadataSource, /openSync\(resolvedFile, constants\.O_RDONLY \| noFollowFlag\(\)\)/);
  assert.match(cliDependencyMetadataSource, /sameFile\(opened, fstatSync\(fd\)\)/);
  assert.match(cliCryptoDependenciesSource, /const REVIEWED_CRYPTO_DEPENDENCIES = \{/);
  assert.match(cliCryptoDependenciesSource, /name: "@cipherman\/pake-js",\n    version: "0\.1\.1"/);
  assert.match(cliCryptoDependenciesSource, /name: "@noble\/curves",\n    version: "1\.9\.7"/);
  assert.match(cliCryptoDependenciesSource, /name: "@noble\/hashes",\n    version: "1\.8\.0"/);
  assert.match(cliCryptoDependenciesSource, /name: "@noble\/hashes",\n    version: "2\.2\.0"/);
  assert.match(cliCryptoDependenciesSource, /resolvedFiles: \{[\s\S]*"dist\/index\.cjs": "3acc7e2184b3f9cd7fe01797d15cfe4a6dc07ced0ea48312ae0389e5d519f94d"/);
  assert.match(cliCryptoDependenciesSource, /"dist\/index\.js": "0342ac6eb86e98172b552392b645c1517dadd4728e668461e73ee6294fdef822"/);
  assert.match(cliCryptoDependenciesSource, /"dist\/cpace\/index\.cjs": "3fde8b5223b4cca19c932e2293ccf2467de5b1b4b34f49a678a54e174b826968"/);
  assert.match(cliCryptoDependenciesSource, /"dist\/cpace\/index\.js": "6724ffbbd017b5a495eb4c4428c6e7bec0f9eab6029474bc0b1382fbfed6d679"/);
  assert.match(cliCryptoDependenciesSource, /"ed25519\.js": "33df162c066fcaef63f82118d296dcbb49ab94dc729e76c9dc5dea67f6f1da09"/);
  assert.match(cliCryptoDependenciesSource, /"abstract\/weierstrass\.js": "149fd490c6871c20a538103ce711b9fc706dc217d889aeafb438572729b0f0dc"/);
  assert.match(cliCryptoDependenciesSource, /"cryptoNode\.js": "7d96258d2ff9da048ceb1fe88fb68172c5f952e461dda65fd08f30e20b5416ae"/);
  assert.match(cliCryptoDependenciesSource, /"sha2\.js": "53b6dc30db76a7c4e4b9370049e7a3c01bbb5507d058c084e97ccb3ee050faa4"/);
  assert.match(cliCryptoDependenciesSource, /"hkdf\.js": "c0de209ef30cc76c14781d7746e6802b44eb17b7bfad6c07e5c17c5806c9836d"/);
  assert.match(cliCryptoDependenciesSource, /"sha2\.js": "0fb8e3c3f2c73a890be2524ac5d2542aaed4decff69e561231a86131203b3973"/);
  assert.match(cliCryptoDependenciesSource, /"utils\.js": "e2adfc13c846487feff0410bd5508a1d66f5ebadc3188f3a40a6b55449981e2f"/);
  assert.match(cliCryptoDependenciesSource, /allowedScripts: \{[\s\S]*prepublishOnly:/);
  assert.match(cliCryptoDependenciesSource, /REVIEWED_SCRIPT_SURFACE = \["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"\]/);
  assert.match(cliCryptoDependenciesSource, /function assertReviewedDependencyEvidence/);
  assert.match(cliCryptoDependenciesSource, /function assertReviewedDependencyFileEvidence/);
  assert.match(cliCryptoDependenciesSource, /function isSafeReviewedRelativeFile/);
  assert.match(cliCryptoDependenciesSource, /sha256FileEvidenceFromResolvedFile\(resolvedFile\) !== digest/);
  assert.match(cliCryptoDependenciesSource, /function assertReviewedScripts/);
  assert.match(cliCryptoDependenciesSource, /function assertRequiredExports/);
  assert.match(cliCryptoDependenciesSource, /requireFromCli\.resolve\("@cipherman\/pake-js"\)/);
  assert.match(cliCryptoDependenciesSource, /requireFromPake\.resolve\("@noble\/curves\/ed25519\.js"\)/);
  assert.match(cliCryptoDependenciesSource, /requireFromCurves\.resolve\("@noble\/hashes\/sha2\.js"\)/);
  assert.match(cliCryptoDependenciesSource, /requireFromCli\.resolve\("@noble\/hashes\/hkdf\.js"\)/);
  assert.match(cliCryptoDependenciesSource, /Reviewed cryptographic dependency metadata is not installed\./);
  assert.doesNotMatch(cliCryptoDependenciesSource, /console\.|process\.exit/);
  assert.match(cpaceReview, /Locked crypto dependency reviewed: `@noble\/curves@1\.9\.7`, with `@noble\/hashes@1\.8\.0`/);
  assert.match(cpaceReview, new RegExp(`Reviewed lockfile integrity for \`@cipherman/pake-js@0\\.1\\.1\`: \`${escapeRegExp(reviewedPakeIntegrity)}\``));
  assert.match(
    cpaceReview,
    new RegExp(
      `Reviewed lockfile integrity for CPace transitives: \`@noble/curves@1\\.9\\.7\` is \`${escapeRegExp(reviewedNobleCurvesIntegrity)}\`; \`@noble/hashes@1\\.8\\.0\` is \`${escapeRegExp(reviewedNobleHashesCpaceIntegrity)}\``
    )
  );
  assert.match(cpaceReview, /CPace vector gate reviewed: `test\/cpace-vectors\.test\.ts` asserts draft-irtf-cfrg-cpace-20 Appendix B\.3 bytes/);
  assert.match(cpaceReview, /`generator_string`, SHA-512 hash output, encoded generator `g`, `Ya`, `Yb`, shared point `K`, and initiator\/responder `ISK_IR`/);
  assert.match(cpaceVectorTest, /CPace Ristretto255 matches draft-20 Appendix B\.3 vector bytes/);
  assert.match(cpaceVectorTest, /__generatorString/);
  assert.match(cpaceVectorTest, /__calculateGeneratorEncoded/);
  assert.match(cpaceVectorTest, /__initWithScalar/);
  assert.match(cpaceVectorTest, /__scalarMultVfy/);
  assert.match(cpaceVectorTest, /b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447/);
  assert.match(cpaceReview, /This repo does not contain a formal independent audit certificate for `@cipherman\/pake-js`/);
  assert.match(cpaceReview, /Dependabot must keep `@cipherman\/pake-js` in the `critical-pake-dependency` production group and keep `@noble\/curves` in the direct crypto dependency group/);
  assert.match(cpaceReview, /Release verification must run `pnpm security:audit` and `pnpm security:signatures`/);
  assert.match(cpaceReview, /Scheduled dependency integrity monitoring must run `pnpm security:audit` and `pnpm security:signatures` on unchanged `main`/);
  assert.match(cpaceReview, /CPace dependency updates must update this artifact in the same change as the package pin and lockfile, with the changed package metadata, exported API, lifecycle hooks, transitive dependency set, exact runtime-file SHA-256 evidence/);
  assert.match(cpaceReview, /Release must stop if any of these are true:/);
  assert.match(cpaceReview, /reviewed resolved-file SHA-256 evidence no longer agree/);
  assert.match(cpaceReview, /`@cipherman\/pake-js` adds `preinstall`, `install`, `postinstall`, or `prepare` hooks, requires build-script allowlisting, or changes to a non-registry source/);
  assert.match(cpaceReview, /`pnpm audit --audit-level low`, `pnpm audit signatures`, scheduled dependency integrity monitoring, dependency review, installed-state verification, package-surface tests, CPace vector\/protocol tests, or release-artifact verification fails/);
});

test("direct noble hashes dependency identity and install surface stay reviewed", () => {
  const hashesPin = packageJson.dependencies?.["@noble/hashes"];
  assert.match(securityPolicy, /direct `@noble\/hashes` crypto dependency metadata, exports, runtime dependency declarations, lifecycle hooks, and lockfile integrity must stay reviewed/);
  assert.match(securityPolicy, /Dependabot must track it in its own production update group and exclude it from bulk production dependency groups/);
  assert.match(dependabotConfig, /direct-crypto-dependency:\n\s+patterns:\n\s+- "@noble\/curves"\n\s+- "@noble\/hashes"\n\s+dependency-type: production/);
  assert.match(dependabotConfig, /production-dependencies:\n\s+dependency-type: production\n\s+exclude-patterns:\n\s+- "@cipherman\/pake-js"\n\s+- "@noble\/curves"\n\s+- "@noble\/hashes"/);
  assert.equal(hashesPin, "2.2.0");
  assert.equal(nobleHashesPackageJson.name, "@noble/hashes");
  assert.equal(nobleHashesPackageJson.version, hashesPin);
  assert.equal(nobleHashesPackageJson.license, "MIT");
  assert.equal(nobleHashesPackageJson.type, "module");
  assert.equal(nobleHashesPackageJson.main, "index.js");
  assert.equal(nobleHashesPackageJson.types, "index.d.ts");
  assert.equal(nobleHashesPackageJson.sideEffects, false);
  assert.equal(nobleHashesPackageJson.homepage, "https://paulmillr.com/noble/");
  assert.deepEqual(nobleHashesPackageJson.repository, {
    type: "git",
    url: "git+https://github.com/paulmillr/noble-hashes.git"
  });
  assert.deepEqual(nobleHashesPackageJson.files, ["*.js", "*.js.map", "*.d.ts", "*.d.ts.map", "src"]);
  assert.deepEqual(nobleHashesPackageJson.exports, {
    ".": "./index.js",
    "./_md.js": "./_md.js",
    "./argon2.js": "./argon2.js",
    "./blake1.js": "./blake1.js",
    "./blake2.js": "./blake2.js",
    "./blake3.js": "./blake3.js",
    "./eskdf.js": "./eskdf.js",
    "./hkdf.js": "./hkdf.js",
    "./hmac.js": "./hmac.js",
    "./legacy.js": "./legacy.js",
    "./pbkdf2.js": "./pbkdf2.js",
    "./scrypt.js": "./scrypt.js",
    "./sha2.js": "./sha2.js",
    "./sha3-addons.js": "./sha3-addons.js",
    "./sha3.js": "./sha3.js",
    "./webcrypto.js": "./webcrypto.js",
    "./utils.js": "./utils.js"
  });
  assert.equal(nobleHashesPackageJson.dependencies, undefined);
  assert.equal(nobleHashesPackageJson.optionalDependencies, undefined);
  assert.equal(nobleHashesPackageJson.peerDependencies, undefined);
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
    assert.equal(nobleHashesPackageJson.scripts?.[lifecycle], undefined);
  }
  assert.match(
    pnpmLock,
    new RegExp(`^  '@noble/hashes@2\\.2\\.0':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedNobleHashesIntegrity)}\\}`, "m")
  );
  assert.match(nobleHashesReview, /# Noble Hashes Dependency Review/);
  assert.match(nobleHashesReview, new RegExp(`Package: \`${escapeRegExp(nobleHashesPackageJson.name ?? "")}\``));
  assert.match(nobleHashesReview, new RegExp(`Reviewed package version: \`${escapeRegExp(hashesPin ?? "")}\``));
  assert.match(nobleHashesReview, new RegExp(`Lockfile entry: \`pnpm-lock\\.yaml\` resolves \`@noble/hashes@2\\.2\\.0\` with integrity \`${escapeRegExp(reviewedNobleHashesIntegrity)}\``));
  assert.match(nobleHashesReview, /`src\/shared\/security\.ts` and `src\/shared\/hash\.ts`/);
  assert.match(nobleHashesReview, /HKDF-SHA256, and hex encoding primitives/);
  assert.match(nobleHashesReview, /`@noble\/hashes\/hkdf\.js`, `@noble\/hashes\/hmac\.js`, `@noble\/hashes\/sha2\.js`, and `@noble\/hashes\/utils\.js`/);
  assert.match(nobleHashesReview, /Entrypoints reviewed in installed metadata: `type` is `module`, `main` is `index\.js`, `module` is `index\.js`, and `types` is `index\.d\.ts`/);
  assert.match(nobleHashesReview, /Runtime dependency declarations reviewed: direct `dependencies`, `optionalDependencies`, and `peerDependencies` are absent/);
  assert.match(nobleHashesReview, /`@noble\/hashes` is not in `allowBuilds`/);
  assert.match(nobleHashesReview, /This repo does not contain a formal independent audit certificate for `@noble\/hashes@2\.2\.0`/);
  assert.match(nobleHashesReview, /Dependabot must keep `@noble\/hashes` in a dedicated production update group and exclude it from the bulk production dependency group/);
  assert.match(nobleHashesReview, /Release must stop if any of these are true:/);
  assert.match(nobleHashesReview, /`@noble\/hashes` adds `preinstall`, `install`, `postinstall`, `prepare`, or `prepublishOnly` hooks/);
});

test("native WebRTC dependency identity and install surface stay reviewed", () => {
  const wrtcPin = packageJson.dependencies?.["@roamhq/wrtc"];
  const domexceptionPin = packageJson.dependencies?.domexception;
  const webidlConversionsPin = packageJson.dependencies?.["webidl-conversions"];
  assert.match(securityPolicy, /native WebRTC dependency metadata, optional prebuilt package set, allowed build-script surface, and platform smoke coverage must stay reviewed/);
  assert.match(securityPolicy, /Dependabot must track `@roamhq\/wrtc`, `@roamhq\/wrtc-\*`, `domexception`, and `webidl-conversions` in their own production update group/);
  assert.match(dependabotConfig, /native-webrtc-dependency:\n\s+patterns:\n\s+- "@roamhq\/wrtc"\n\s+- "@roamhq\/wrtc-\*"\n\s+- "domexception"\n\s+- "webidl-conversions"\n\s+dependency-type: production/);
  assert.match(dependabotConfig, /production-dependencies:\n\s+dependency-type: production\n\s+exclude-patterns:\n\s+- "@cipherman\/pake-js"\n\s+- "@noble\/curves"\n\s+- "@noble\/hashes"\n\s+- "@roamhq\/wrtc"\n\s+- "@roamhq\/wrtc-\*"\n\s+- "domexception"\n\s+- "webidl-conversions"/);
  assert.equal(wrtcPin, "0.10.0");
  assert.equal(domexceptionPin, "4.0.0");
  assert.equal(webidlConversionsPin, "7.0.0");
  assert.equal(wrtcPackageJson.name, "@roamhq/wrtc");
  assert.equal(wrtcPackageJson.version, wrtcPin);
  assert.equal(wrtcPackageJson.license, "BSD-2-Clause");
  assert.equal(wrtcPackageJson.homepage, "https://github.com/WonderInventions/node-webrtc");
  assert.equal(wrtcPackageJson.bugs, "https://github.com/WonderInventions/node-webrtc/issues");
  assert.deepEqual(wrtcPackageJson.repository, {
    type: "git",
    url: "git+ssh://git@github.com/WonderInventions/node-webrtc.git"
  });
  assert.equal(wrtcPackageJson.main, "lib/index.js");
  assert.equal(wrtcPackageJson.types, "types/index.d.ts");
  assert.equal(wrtcPackageJson.browser, "lib/browser.js");
  assert.equal(wrtcPackageJson.type, undefined);
  assert.equal(wrtcPackageJson.exports, undefined);
  assert.equal(wrtcPackageJson.sideEffects, undefined);
  assert.equal(wrtcPackageJson.dependencies, undefined);
  assert.deepEqual(wrtcPackageJson.files, ["AUTHORS", "CHANGELOG.md", "lib", "types"]);
  const wrtcScripts: Record<string, string> | undefined = wrtcPackageJson.scripts;
  const expectedWrtcScripts: Record<string, string> = {
    patch: "patch-package --error-on-warn",
    build: "node scripts/build-from-source.js",
    "make-prebuilt": "node scripts/make-prebuilt.js",
    "install-example": "node scripts/install-example.js",
    lint: "eslint lib/*.js lib/**/*.js test/*.js test/**/*.js scripts/*.js",
    test: "node --expose-gc test/all.js",
    prepare: "husky"
  };
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepublish", "prepublishOnly"]) {
    assert.equal(wrtcScripts?.[lifecycle], undefined);
  }
  assert.equal(wrtcScripts?.prepare, "husky");
  assert.equal(wrtcScripts?.build, "node scripts/build-from-source.js");
  assert.equal(wrtcScripts?.["make-prebuilt"], "node scripts/make-prebuilt.js");
  assert.deepEqual(wrtcScripts, expectedWrtcScripts);
  assert.deepEqual(
    Object.fromEntries(Object.entries(wrtcPackageJson.optionalDependencies ?? {}).filter(([name]) => name.startsWith("@roamhq/wrtc-"))),
    Object.fromEntries(reviewedWrtcPrebuiltPackages.map((name) => [name, wrtcPin]))
  );
  assert.equal(wrtcPackageJson.optionalDependencies?.domexception, "^4.0.0");
  assert.match(
    pnpmLock,
    new RegExp(`^  '@roamhq/wrtc@0\\.10\\.0':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedWrtcIntegrity)}\\}`, "m")
  );
  for (const name of reviewedWrtcPrebuiltPackages) {
    assert.match(
      pnpmLock,
      new RegExp(`^  '${escapeRegExp(name)}@0\\.10\\.0':\\n    resolution: \\{integrity: ${escapeRegExp(reviewedWrtcPrebuiltIntegrities[name] ?? "")}\\}`, "m")
    );
  }
  assert.match(pnpmLock, new RegExp(`^  domexception@4\\.0\\.0:\\n    resolution: \\{integrity: ${escapeRegExp(reviewedDomexceptionIntegrity)}\\}`, "m"));
  assert.match(pnpmLock, /^      domexception:\n        specifier: 4\.0\.0\n        version: 4\.0\.0/m);
  assert.match(pnpmLock, /^      webidl-conversions:\n        specifier: 7\.0\.0\n        version: 7\.0\.0/m);
  assert.match(pnpmLock, new RegExp(`^  webidl-conversions@7\\.0\\.0:\\n    resolution: \\{integrity: ${escapeRegExp(reviewedWebidlConversionsIntegrity)}\\}`, "m"));
  assert.match(nativeSmokeScript, /const mod = await import\("\.\.\/dist-node\/cli\/native-webrtc\.js"\)/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCPeerConnection, "RTCPeerConnection"\)/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCDataChannel, "RTCDataChannel"\)/);
  assert.match(nativeSmokeScript, /requiredConstructor\(wrtc\.RTCIceCandidate, "RTCIceCandidate"\)/);
  assert.doesNotMatch(cliRtcSource, /import wrtc from "@roamhq\/wrtc"/);
  assert.match(cliRtcSource, /import \{ nativeWebRtc \} from "\.\/native-webrtc\.js"/);
  assert.match(cliNativeWebrtcSource, /const REVIEWED_NATIVE_WEBRTC_DEPENDENCIES = \{/);
  assert.match(cliNativeWebrtcSource, /name: "@roamhq\/wrtc",\n    version: "0\.10\.0"/);
  assert.match(cliNativeWebrtcSource, /optionalDependencies: \{[\s\S]*"@roamhq\/wrtc-darwin-arm64": "0\.10\.0"[\s\S]*domexception: "\^4\.0\.0"/);
  assert.match(cliNativeWebrtcSource, /domException: \{[\s\S]*name: "domexception",\n    version: "4\.0\.0"/);
  assert.match(cliNativeWebrtcSource, /webidlConversions: \{[\s\S]*name: "webidl-conversions",\n    version: "7\.0\.0"/);
  assert.match(cliNativeWebrtcSource, /"darwin-arm64": \{[\s\S]*name: "@roamhq\/wrtc-darwin-arm64",\n      version: "0\.10\.0",\n      license: "BSD-2-Clause"/);
  assert.match(cliNativeWebrtcSource, /"linux-x64": \{[\s\S]*name: "@roamhq\/wrtc-linux-x64",\n      version: "0\.10\.0",\n      license: "BSD-2-Clause"/);
  assert.match(cliNativeWebrtcSource, /"win32-x64": \{[\s\S]*name: "@roamhq\/wrtc-win32-x64",\n      version: "0\.10\.0",\n      license: "BSD-2-Clause"/);
  assert.match(cliNativeWebrtcSource, /MAX_NATIVE_WEBRTC_FILE_BYTES = 64 \* 1024 \* 1024/);
  assert.match(cliNativeWebrtcSource, /"lib\/index\.js": "3340521d1c72f51f6ab9eade422270b5764e8eb2acf8474a451399d77957a12f"/);
  assert.match(cliNativeWebrtcSource, /"lib\/binding\.js": "855729de6ed99559225d489ca316421e05d5dbc950578017ebe5be7eff2c9475"/);
  assert.match(cliNativeWebrtcSource, /"wrtc\.node": "844f7e2ed329c652b9f07f26c8aa46930d72f6c8220dba2e63038bbe2e73cdf5"/);
  assert.match(cliNativeWebrtcSource, /"wrtc\.node": "910e4b82e7cad29998529df19c4b265ab154dc2a2a8df5861474552c6e99af14"/);
  assert.match(cliNativeWebrtcSource, /"wrtc\.node": "78636a264bb350c8b7d074916ca2a4897a369d1623958dfc1d5daec183433b93"/);
  assert.match(cliNativeWebrtcSource, /"wrtc\.node": "a629f3ee4aa32a097361270f719007e62325068dac347086218027ce4274302f"/);
  assert.match(cliNativeWebrtcSource, /"wrtc\.node": "ca5d94c351e2cff49df4aedb7b3a22f7e8aee19926d0b6bbe9e60689153196e7"/);
  assert.match(cliNativeWebrtcSource, /"webidl2js-wrapper\.js": "7bf1497eb2f68d9f7de614c8d30e854e2015c534df7ac63c96b02e4405986673"/);
  assert.match(cliNativeWebrtcSource, /"lib\/index\.js": "c3b203d992b46905b610d240313d72e96d04b756942d9612878104ee12b107d4"/);
  assert.match(cliNativeWebrtcSource, /assertReviewedNativeWebRtcDependencies\(\)/);
  assert.match(cliNativeWebrtcSource, /assertReviewedNativeDependencyEvidence\(wrtc, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES\.wrtc\)/);
  assert.match(cliNativeWebrtcSource, /assertReviewedNativeDependencyEvidence\(domException, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES\.domException\)/);
  assert.match(cliNativeWebrtcSource, /assertReviewedNativeDependencyEvidence\(webidlConversions, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES\.webidlConversions\)/);
  assert.match(cliNativeWebrtcSource, /function assertReviewedNativeDependencyFileEvidence/);
  assert.match(cliNativeWebrtcSource, /sha256FileEvidenceFromResolvedFile\(resolvedFile, MAX_NATIVE_WEBRTC_FILE_BYTES\) !== digest/);
  assert.match(cliNativeWebrtcSource, /requireFromWrtc\.resolve\(`\$\{prebuiltName\}\/wrtc\.node`\)/);
  assert.match(cliNativeWebrtcSource, /requireFromDomException\.resolve\("webidl-conversions"\)/);
  assert.match(cliNativeWebrtcSource, /assertLoadReviewedNativePrebuilt\(prebuiltBinary\)/);
  assert.match(cliNativeWebrtcSource, /assertNoNativeFallbackSurfaces\(wrtc\.root, reviewedPlatformTriple\(\)\)/);
  assert.match(cliNativeWebrtcSource, /requireFromWrtc\.resolve\("domexception"\)/);
  assert.match(cliNativeWebrtcSource, /Reviewed native WebRTC dependency metadata is not installed\./);
  assert.doesNotMatch(cliNativeWebrtcSource, /console\.|process\.exit|resolvedFile\}/);
  assert.match(packedSmokeScript, /onlyBuiltDependencies:[\s\S]*- '@roamhq\/wrtc'/);
  assert.match(ciWorkflow, /ubuntu-24\.04/);
  assert.match(ciWorkflow, /ubuntu-24\.04-arm/);
  assert.match(ciWorkflow, /macos-15/);
  assert.match(ciWorkflow, /macos-15-intel/);
  assert.match(ciWorkflow, /windows-2025/);
  assert.match(releaseWorkflow, /ubuntu-24\.04/);
  assert.match(releaseWorkflow, /ubuntu-24\.04-arm/);
  assert.match(releaseWorkflow, /macos-15/);
  assert.match(releaseWorkflow, /macos-15-intel/);
  assert.match(releaseWorkflow, /windows-2025/);
  assert.match(securityPolicy, /native smoke and packed-install checks on Linux x64, Linux arm64, macOS arm64, macOS Intel, and Windows x64 for every supported Node major/);
  assert.match(securityPolicy, /explicit hosted runner generations \(`ubuntu-24\.04`, `ubuntu-24\.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`\)/);
  assert.match(nativeWebrtcReview, /# Native WebRTC Dependency Review/);
  assert.match(nativeWebrtcReview, new RegExp(`Package: \`${escapeRegExp(wrtcPackageJson.name ?? "")}\``));
  assert.match(nativeWebrtcReview, new RegExp(`Reviewed package version: \`${escapeRegExp(wrtcPin ?? "")}\``));
  assert.match(nativeWebrtcReview, new RegExp(`Local pin: \`package\\.json\` pins \`@roamhq/wrtc\` to exact version \`${escapeRegExp(wrtcPin ?? "")}\` and pins the reviewed non-native runtime companions \`domexception\` to exact version \`${escapeRegExp(domexceptionPin ?? "")}\` and \`webidl-conversions\` to exact version \`${escapeRegExp(webidlConversionsPin ?? "")}\``));
  assert.match(nativeWebrtcReview, new RegExp(`Installed package identity: \`node_modules/@roamhq/wrtc/package\\.json\` reports name \`${escapeRegExp(wrtcPackageJson.name ?? "")}\` and version \`${escapeRegExp(wrtcPackageJson.version ?? "")}\``));
  assert.match(nativeWebrtcReview, new RegExp(`License: \`${escapeRegExp(wrtcPackageJson.license ?? "")}\``));
  assert.match(nativeWebrtcReview, /Upstream repository: `git\+ssh:\/\/git@github\.com\/WonderInventions\/node-webrtc\.git`/);
  assert.match(nativeWebrtcReview, /Homepage: `https:\/\/github\.com\/WonderInventions\/node-webrtc`/);
  assert.match(nativeWebrtcReview, /Issue tracker: `https:\/\/github\.com\/WonderInventions\/node-webrtc\/issues`/);
  assert.match(nativeWebrtcReview, /`RTCPeerConnection`, `RTCDataChannel`, and `RTCIceCandidate`/);
  assert.match(nativeWebrtcReview, /Module metadata reviewed in installed metadata: `type`, `exports`, `sideEffects`, and direct `dependencies` are absent/);
  assert.match(nativeWebrtcReview, /Package script surface reviewed in installed metadata: only `patch`, `build`, `make-prebuilt`, `install-example`, `lint`, `test`, and `prepare` are present/);
  assert.match(nativeWebrtcReview, /Consumer install lifecycle hooks reviewed: `preinstall`, `install`, and `postinstall` are absent/);
  assert.match(nativeWebrtcReview, /`prepare` is present upstream but is not run during registry consumer installs/);
  assert.match(nativeWebrtcReview, /Runtime consumer-install hardening reviewed: CLI WebRTC helpers load `@roamhq\/wrtc` lazily/);
  assert.match(nativeWebrtcReview, /fail closed unless the resolved package graph matches `@roamhq\/wrtc@0\.10\.0`, the current platform's reviewed `@roamhq\/wrtc-\*` prebuilt, `domexception@4\.0\.0`, and `webidl-conversions@7\.0\.0`/);
  assert.match(nativeWebrtcReview, /including reviewed wrapper metadata, optional prebuilt declarations, current-platform prebuilt metadata, domexception metadata, webidl-conversions metadata, dependency declarations, lifecycle-script surfaces, and exact resolved JS\/native file SHA-256 evidence/);
  assert.match(nativeWebrtcReview, /Runtime resolved-file hash hardening reviewed: CLI WebRTC helpers fail closed unless all runtime wrapper files under `@roamhq\/wrtc\/lib\/\*\.js`/);
  assert.match(securityPolicy, /CLI WebRTC helpers must fail closed unless `@roamhq\/wrtc`, the current platform's `@roamhq\/wrtc-\*` prebuilt, `domexception`, and `webidl-conversions` match the reviewed versions, wrapper metadata, optional prebuilt declarations, current-platform prebuilt metadata, dependency declarations, lifecycle-script surfaces, exact resolved file SHA-256 evidence, and native binary location policy/);
  assert.match(nativeWebrtcReview, /hashes the reviewed platform `wrtc\.node` before native load/);
  assert.match(nativeWebrtcReview, /rejects root `build-\*` fallback outputs, and rejects nested `node_modules\/@roamhq\/wrtc-\*` fallback outputs/);
  assert.match(cliNativeWebrtcSource, /function assertReviewedNativeDependencyEvidence/);
  assert.match(cliNativeWebrtcSource, /function assertNativeMetadata/);
  assert.match(cliNativeWebrtcSource, /Reviewed native WebRTC dependency metadata is not installed\./);
  assert.match(nativeWebrtcReview, /Optional platform prebuilt packages reviewed: `@roamhq\/wrtc-darwin-arm64@0\.10\.0`, `@roamhq\/wrtc-darwin-x64@0\.10\.0`, `@roamhq\/wrtc-linux-arm64@0\.10\.0`, `@roamhq\/wrtc-linux-x64@0\.10\.0`, and `@roamhq\/wrtc-win32-x64@0\.10\.0`/);
  assert.match(nativeWebrtcReview, new RegExp(`Reviewed lockfile integrity for \`@roamhq/wrtc@0\\.10\\.0\`: \`${escapeRegExp(reviewedWrtcIntegrity)}\``));
  for (const name of reviewedWrtcPrebuiltPackages) {
    assert.match(nativeWebrtcReview, new RegExp(`\`${escapeRegExp(name)}@0\\.10\\.0\` is \`${escapeRegExp(reviewedWrtcPrebuiltIntegrities[name] ?? "")}\``));
  }
  assert.match(nativeWebrtcReview, new RegExp(`\`domexception@4\\.0\\.0\` is \`${escapeRegExp(reviewedDomexceptionIntegrity)}\``));
  assert.match(nativeWebrtcReview, new RegExp(`\`webidl-conversions@7\\.0\\.0\` is \`${escapeRegExp(reviewedWebidlConversionsIntegrity)}\``));
  assert.match(nativeWebrtcReview, /This repo does not contain a formal independent audit certificate for the package or its prebuilts/);
  assert.match(nativeWebrtcReview, /does not include Windows ARM64, Linux ARMv7, or other unsupported platforms/);
  assert.match(nativeWebrtcReview, /does not hide endpoint compromise, MDM inspection of local files before encryption or after decryption, or network-level metadata/);
  assert.match(nativeWebrtcReview, /Dependabot must keep `@roamhq\/wrtc`, `@roamhq\/wrtc-\*`, `domexception`, and `webidl-conversions` in the `native-webrtc-dependency` production group and excluded from the bulk production dependency group/);
  assert.match(nativeWebrtcReview, /Native WebRTC dependency updates must update this artifact in the same change as the package pin and lockfile, with the changed package metadata, lifecycle hooks, optional prebuilt set, exact resolved-file SHA-256 evidence/);
  assert.match(nativeWebrtcReview, /Release must stop if any of these are true:/);
  assert.match(nativeWebrtcReview, /current-platform prebuilt metadata, domexception metadata, webidl-conversions metadata, or reviewed resolved-file SHA-256 evidence no longer agree/);
  assert.match(nativeWebrtcReview, /`@roamhq\/wrtc` adds `preinstall`, `install`, or `postinstall` hooks, removes the reviewed registry-consumer install behavior, or changes to a non-registry source/);
  assert.match(nativeWebrtcReview, /The optional platform prebuilt package set changes without explicit platform-support review/);
  assert.match(nativeWebrtcReview, /native smoke, packed-install smoke, platform smoke, browser tests, e2e tests, or release-artifact verification fails/);
});

test("lockfile resolves registry tarballs with integrity for every package", () => {
  assert.match(pnpmLock, /^lockfileVersion: '9\.0'$/m);
  assert.doesNotMatch(pnpmLock, /\b(?:link|file|workspace|github):|git\+|https?:\/\/|tarball:/);
  assert.deepEqual(lockfilePackagesMissingIntegrity(pnpmLock), []);

  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.equal(lockfileImporterHasPinnedSpecifier(pnpmLock, name, version), true, `${name} must be pinned in pnpm-lock.yaml`);
  }
});

test("lockfile resolved package set is explicitly reviewed", () => {
  assert.deepEqual(lockfileResolvedPackages(pnpmLock), [
    "@cipherman/pake-js@0.1.1",
    "@emnapi/core@1.10.0",
    "@emnapi/runtime@1.10.0",
    "@emnapi/wasi-threads@1.2.1",
    "@esbuild/aix-ppc64@0.28.0",
    "@esbuild/android-arm64@0.28.0",
    "@esbuild/android-arm@0.28.0",
    "@esbuild/android-x64@0.28.0",
    "@esbuild/darwin-arm64@0.28.0",
    "@esbuild/darwin-x64@0.28.0",
    "@esbuild/freebsd-arm64@0.28.0",
    "@esbuild/freebsd-x64@0.28.0",
    "@esbuild/linux-arm64@0.28.0",
    "@esbuild/linux-arm@0.28.0",
    "@esbuild/linux-ia32@0.28.0",
    "@esbuild/linux-loong64@0.28.0",
    "@esbuild/linux-mips64el@0.28.0",
    "@esbuild/linux-ppc64@0.28.0",
    "@esbuild/linux-riscv64@0.28.0",
    "@esbuild/linux-s390x@0.28.0",
    "@esbuild/linux-x64@0.28.0",
    "@esbuild/netbsd-arm64@0.28.0",
    "@esbuild/netbsd-x64@0.28.0",
    "@esbuild/openbsd-arm64@0.28.0",
    "@esbuild/openbsd-x64@0.28.0",
    "@esbuild/openharmony-arm64@0.28.0",
    "@esbuild/sunos-x64@0.28.0",
    "@esbuild/win32-arm64@0.28.0",
    "@esbuild/win32-ia32@0.28.0",
    "@esbuild/win32-x64@0.28.0",
    "@napi-rs/wasm-runtime@1.1.4",
    "@noble/curves@1.9.7",
    "@noble/hashes@1.8.0",
    "@noble/hashes@2.2.0",
    "@oxc-project/types@0.132.0",
    "@roamhq/wrtc-darwin-arm64@0.10.0",
    "@roamhq/wrtc-darwin-x64@0.10.0",
    "@roamhq/wrtc-linux-arm64@0.10.0",
    "@roamhq/wrtc-linux-x64@0.10.0",
    "@roamhq/wrtc-win32-x64@0.10.0",
    "@roamhq/wrtc@0.10.0",
    "@rolldown/binding-android-arm64@1.0.2",
    "@rolldown/binding-darwin-arm64@1.0.2",
    "@rolldown/binding-darwin-x64@1.0.2",
    "@rolldown/binding-freebsd-x64@1.0.2",
    "@rolldown/binding-linux-arm-gnueabihf@1.0.2",
    "@rolldown/binding-linux-arm64-gnu@1.0.2",
    "@rolldown/binding-linux-arm64-musl@1.0.2",
    "@rolldown/binding-linux-ppc64-gnu@1.0.2",
    "@rolldown/binding-linux-s390x-gnu@1.0.2",
    "@rolldown/binding-linux-x64-gnu@1.0.2",
    "@rolldown/binding-linux-x64-musl@1.0.2",
    "@rolldown/binding-openharmony-arm64@1.0.2",
    "@rolldown/binding-wasm32-wasi@1.0.2",
    "@rolldown/binding-win32-arm64-msvc@1.0.2",
    "@rolldown/binding-win32-x64-msvc@1.0.2",
    "@rolldown/pluginutils@1.0.1",
    "@scure/base@2.2.0",
    "@scure/bip39@2.2.0",
    "@tybys/wasm-util@0.10.2",
    "@types/node@22.13.14",
    "@types/ws@8.18.1",
    "commander@14.0.3",
    "detect-libc@2.1.2",
    "domexception@4.0.0",
    "esbuild@0.28.0",
    "fdir@6.5.0",
    "fsevents@2.3.2",
    "fsevents@2.3.3",
    "lightningcss-android-arm64@1.32.0",
    "lightningcss-darwin-arm64@1.32.0",
    "lightningcss-darwin-x64@1.32.0",
    "lightningcss-freebsd-x64@1.32.0",
    "lightningcss-linux-arm-gnueabihf@1.32.0",
    "lightningcss-linux-arm64-gnu@1.32.0",
    "lightningcss-linux-arm64-musl@1.32.0",
    "lightningcss-linux-x64-gnu@1.32.0",
    "lightningcss-linux-x64-musl@1.32.0",
    "lightningcss-win32-arm64-msvc@1.32.0",
    "lightningcss-win32-x64-msvc@1.32.0",
    "lightningcss@1.32.0",
    "nanoid@3.3.12",
    "nanoid@5.1.11",
    "picocolors@1.1.1",
    "picomatch@4.0.4",
    "playwright-core@1.60.0",
    "playwright@1.60.0",
    "postcss@8.5.15",
    "rolldown@1.0.2",
    "source-map-js@1.2.1",
    "tinyglobby@0.2.17",
    "tslib@2.8.1",
    "tsx@4.22.3",
    "typescript@6.0.3",
    "undici-types@6.19.1",
    "vite@8.0.14",
    "webidl-conversions@7.0.0",
    "ws@8.21.0"
  ]);
});

function isExactPackageVersion(version: string): boolean {
  return !/^[~^*><=]|(?:\s+\|\|\s+)|(?:\s+-\s+)/.test(version) && !version.includes("x") && !version.includes("*") && path.basename(version) === version;
}

function assertAtLeast(actual: string | undefined, minimum: string, message: string): void {
  assert.equal(typeof actual, "string", message);
  assert.equal(compareSemver(actual!, minimum) >= 0, true, `${message} Current ${actual}, minimum ${minimum}.`);
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected exact semver version, got ${version}.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function packageVersionFromResolvedEntry(entry: string): string {
  const at = entry.lastIndexOf("@");
  if (at <= 0) throw new Error(`Expected resolved package entry, got ${entry}.`);
  return entry.slice(at + 1);
}

function parseAllowBuilds(workspaceYaml: string): string[] {
  const lines = workspaceYaml.split(/\r?\n/);
  const out: string[] = [];
  let inAllowBuilds = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inAllowBuilds = line.trim() === "allowBuilds:";
    if (!inAllowBuilds || !line.startsWith("  ")) continue;
    const match = /^\s+("?[^":]+"?):\s+true\s*$/.exec(line);
    if (match?.[1]) out.push(match[1].replace(/^"|"$/g, ""));
  }
  return out;
}

function lockfilePackagesMissingIntegrity(lockfile: string): string[] {
  const packages = lockfileSection(lockfile, "packages:", "snapshots:");
  const missing: string[] = [];
  const entries = packages.matchAll(/^  (.+):\n([\s\S]*?)(?=^  .+:\n|\Z)/gm);
  for (const entry of entries) {
    const name = entry[1] ?? "";
    const body = entry[2] ?? "";
    if (/^\s+resolution:/m.test(body) && !/^\s+resolution:\s+\{integrity:\s+sha512-/m.test(body)) missing.push(name);
  }
  return missing;
}

function lockfileImporterHasPinnedSpecifier(lockfile: string, name: string, version: string): boolean {
  const importer = lockfileSection(lockfile, "  .:", "\npackages:");
  const key = yamlPackageKey(name);
  const escapedKey = escapeRegExp(key);
  const escapedVersion = escapeRegExp(version);
  return new RegExp(`^      ${escapedKey}:\\n        specifier: ${escapedVersion}\\n        version: ${escapedVersion}(?:\\n|\\(|$)`, "m").test(importer);
}

function lockfileResolvedPackages(lockfile: string): string[] {
  const packages = lockfileSection(lockfile, "packages:", "snapshots:");
  return [...packages.matchAll(/^  (\S.*):$/gm)].map((match) => (match[1] ?? "").replace(/^'|'$/g, "")).sort();
}

function lockfileSection(lockfile: string, start: string, end: string): string {
  const startIndex = lockfile.indexOf(start);
  const endIndex = lockfile.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) return "";
  return lockfile.slice(startIndex, endIndex);
}

function yamlPackageKey(name: string): string {
  return name.startsWith("@") ? `'${name}'` : name;
}

function splitPackageNameAndVersion(packageAndVersion: string): [string, string] {
  const separatorIndex = packageAndVersion.lastIndexOf("@");
  assert.notEqual(separatorIndex, -1);
  return [packageAndVersion.slice(0, separatorIndex), packageAndVersion.slice(separatorIndex + 1)];
}

function lockfilePackageIntegrityPattern(name: string, version: string, integrity: string): RegExp {
  const key = name.startsWith("@") ? `'${escapeRegExp(name)}@${escapeRegExp(version)}'` : `${escapeRegExp(name)}@${escapeRegExp(version)}`;
  return new RegExp(`^  ${key}:\\n    resolution: \\{integrity: ${escapeRegExp(integrity)}\\}`, "m");
}

function sourcePathForBuiltBin(relativePath: string): URL {
  if (relativePath === "dist-node/cli/index.js") return new URL("../src/cli/index.ts", import.meta.url);
  if (relativePath === "dist-node/server/index.js") return new URL("../src/server/index.ts", import.meta.url);
  throw new Error(`Unexpected bin path ${relativePath}.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
