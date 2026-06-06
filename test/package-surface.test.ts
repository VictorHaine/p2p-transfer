import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  author?: string;
  homepage?: string;
  bugs?: { url?: string };
  license?: string;
  repository?: { type?: string; url?: string };
  packageManager?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  pnpm?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
const pnpmWorkspace = fs.readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const pnpmLock = fs.readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const packedSmokeScript = fs.readFileSync(new URL("../scripts/smoke-packed.mjs", import.meta.url), "utf8");
const nativeSmokeScript = fs.readFileSync(new URL("../scripts/smoke-native.mjs", import.meta.url), "utf8");
const installStateScript = fs.readFileSync(new URL("../scripts/check-install-state.mjs", import.meta.url), "utf8");
const releaseArtifactScript = fs.readFileSync(new URL("../scripts/verify-release-artifact.mjs", import.meta.url), "utf8");
const releaseChecksumScript = fs.readFileSync(new URL("../scripts/write-release-checksum.mjs", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const dependabotConfig = fs.readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const conformanceFiles = fs.readdirSync(new URL("../conformance", import.meta.url));
const pakePackageJson = JSON.parse(fs.readFileSync(new URL("../node_modules/@cipherman/pake-js/package.json", import.meta.url), "utf8")) as PackageJson;

test("npm package surface is restricted to built artifacts and required docs", () => {
  assert.deepEqual(packageJson.files, [
    "conformance",
    "dist-node/cli",
    "dist-node/server",
    "dist-node/shared",
    "dist-web",
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
  assert.deepEqual(conformanceFiles, ["protocol-v4.json"]);
});

test("package publishing config keeps provenance and reproducible dependency pins", () => {
  assert.equal(packageJson.name, "@victorhaine/p2p-transfer");
  assert.match(packageJson.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.author, "Victor Haine");
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.homepage, "https://github.com/victorhaine/p2p-transfer#readme");
  assert.deepEqual(packageJson.bugs, { url: "https://github.com/victorhaine/p2p-transfer/issues" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/victorhaine/p2p-transfer.git"
  });
  assert.equal(packageJson.packageManager, "pnpm@11.1.1");
  assert.equal(packageJson.publishConfig?.provenance, true);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.scripts?.prepack, "pnpm build");
  assert.equal(packageJson.scripts?.check, "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.test.json");
  assert.equal(packageJson.scripts?.["security:audit"], "pnpm audit --audit-level low");
  assert.equal(packageJson.scripts?.["security:signatures"], "pnpm audit signatures");
  assert.equal(packageJson.scripts?.["smoke:native"], "node scripts/smoke-native.mjs");
  assert.equal(packageJson.scripts?.["smoke:packed"], "node scripts/smoke-packed.mjs");
  assert.equal(packageJson.scripts?.["check:install-state"], "node scripts/check-install-state.mjs");
  assert.match(securityPolicy, /typecheck gates must explicitly run the shipping Node project config and the test project config/);
  assert.match(securityPolicy, /release dependency audits must fail on known vulnerabilities at low severity or higher/);
  assert.match(securityPolicy, /release dependency verification must run registry package signature checks/);
  assert.match(securityPolicy, /installed direct dependency tree does not match the exact `package\.json` pins or when `node_modules\/\.pnpm\/lock\.yaml` diverges from `pnpm-lock\.yaml`/);
  assert.match(securityPolicy, /installed-state verification must validate direct dependency names and package pins before installed package reads, check both installed direct package identity and installed direct package version against `package\.json` pins before accepting the local dependency tree, and mismatch output must not echo raw workspace paths, raw filesystem errors, stack traces, or installed package metadata/);
  assert.match(securityPolicy, /installed-state verification must resolve the project root from the checked script location, use a symlink-safe realpath entrypoint check, avoid filesystem verification side effects when imported, and use verifier-owned top-level failure reporting/);
  assert.match(securityPolicy, /installed-state verification must byte-cap, no-follow-open, identity-check, handle-read, and fatal-UTF-8-decode package and lockfile evidence/);
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
  assert.equal(packageJson.scripts?.["verify:local"], "pnpm check:install-state && pnpm build && pnpm check && pnpm test:unit && pnpm smoke:native && pnpm smoke:packed");
  assert.equal(
    packageJson.scripts?.["verify:release"],
    "pnpm check:install-state && pnpm build && pnpm check && pnpm test:unit && pnpm smoke:native && pnpm smoke:packed && pnpm test:e2e && pnpm test:browser && pnpm security:audit && pnpm security:signatures"
  );
  assert.equal(packageJson.scripts?.test, "pnpm build && pnpm test:unit && pnpm test:e2e && pnpm test:browser");
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.equal(isExactPackageVersion(version), true, `${name} must use an exact dependency version`);
  }
});

test("native WebRTC smoke negotiates local session descriptions", () => {
  assert.match(securityPolicy, /native WebRTC smoke must import `@roamhq\/wrtc` inside the controlled smoke path, instantiate PeerConnections, create a DataChannel, and complete local offer\/answer SDP negotiation/);
  assert.match(nativeSmokeScript, /async function importNativeWebRtc\(\)/);
  assert.match(nativeSmokeScript, /const mod = await import\("@roamhq\/wrtc"\)/);
  assert.match(nativeSmokeScript, /return mod\.default \?\? mod/);
  assert.match(nativeSmokeScript, /throw new Error\("Native WebRTC package could not be loaded\."\)/);
  assert.doesNotMatch(nativeSmokeScript, /import wrtc from "@roamhq\/wrtc"/);
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
  assert.match(securityPolicy, /native WebRTC smoke must import `@roamhq\/wrtc` inside the controlled smoke path/);
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
  assert.match(packedSmokeScript, /const protocolVersion = requiredProtocolVersion\(parseJsonEvidence\(await readText\(path\.join\(root, "conformance", "protocol-v4\.json"\), MAX_CONFORMANCE_JSON_BYTES\), "conformance\/protocol-v4\.json"\)\.protocolVersion\)/);
  assert.match(packedSmokeScript, /const packageVersion = requiredPackageVersion\(packageJson\.version\)/);
  assert.match(packedSmokeScript, /function requiredPackageVersion\(value\)/);
  assert.match(packedSmokeScript, /function requiredProtocolVersion\(value\)/);
  assert.match(packedSmokeScript, /const expectedVersion = `\$\{packageVersion\} protocol \$\{protocolVersion\}`/);
  assert.match(packedSmokeScript, /version\.stdout\.trimEnd\(\) !== expectedVersion \|\| version\.stderr\.length > 0/);
  assert.doesNotMatch(packedSmokeScript, /version\.stdout\.includes/);
  assert.match(packedSmokeScript, /pnpm.*exec", "ff-server"/);
  assert.match(packedSmokeScript, /strictDepBuilds: true/);
  assert.match(packedSmokeScript, /onlyBuiltDependencies:/);
  assert.match(packedSmokeScript, /@roamhq\/wrtc/);
  assert.match(packedSmokeScript, /\/healthz/);
  assert.match(packedSmokeScript, /ff transfer/);
  assert.match(securityPolicy, /packed-install smoke must use an OS-assigned loopback port/);
  assert.match(securityPolicy, /packed-install smoke subprocesses must run with a minimal allowlisted environment/);
  assert.match(securityPolicy, /packed-install smoke must use a symlink-safe realpath entrypoint check and smoke-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, strip terminal control and format characters from captured subprocess output and rendered command labels, reject non-string command label parts and non-Buffer child output chunks before coercion, bound that sanitized output, and force-kill timed-out subprocesses/);
  assert.match(securityPolicy, /packed-install smoke command timeouts must reject only after the timed-out subprocess exits/);
  assert.match(securityPolicy, /packed-install smoke startup waits must clean up listeners and terminate timed-out server subprocesses/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap server health and web UI response bodies/);
  assert.match(securityPolicy, /packed-install smoke HTTP probes must use an abort deadline that covers both headers and response body reads/);
  assert.match(securityPolicy, /packed-install smoke must fatal-UTF-8-decode project metadata and HTTP probe responses, parse project metadata and health response JSON with smoke-owned deterministic errors, and reject invalid health bodies without echoing response content/);
  assert.match(securityPolicy, /packed-install smoke must require exact `ff --version` stdout and empty stderr/);
  assert.match(securityPolicy, /packed-install smoke must validate the project `version` is an exact semver release/);
  assert.match(securityPolicy, /packed-install smoke must validate the project `packageManager` is an exact `pnpm@\d+\.\d+\.\d+` pin/);
  assert.match(securityPolicy, /provided tarball paths must reject terminal control\/format characters and staging\/open failures must not echo raw tarball paths/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap the provided tarball path by UTF-8 bytes, no-follow-open, identity-check, and stage the verified tarball into a distinct no-follow-copied file in its private temp workspace before fresh-project install/);
  assert.match(packedSmokeScript, /const MAX_CHILD_OUTPUT_CHARS = 200_000/);
  assert.match(packedSmokeScript, /const MAX_PACKED_SMOKE_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(packedSmokeScript, /const MAX_PACKED_SMOKE_TARBALL_PATH_BYTES = 4_096/);
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
  assert.equal(packedSmokeScript.match(/child\.kill\("SIGKILL"\)/g)?.length, 2);
  assert.match(packedSmokeScript, /function waitForOutput\(child, pattern, timeoutMs\)[\s\S]*let settled = false[\s\S]*child\.kill\("SIGTERM"\)[\s\S]*rejectOnce/);
  assert.match(packedSmokeScript, /function waitForOutput\(child, pattern, timeoutMs\)[\s\S]*child\.stdout\.off\("data", onStdout\)[\s\S]*child\.stderr\.off\("data", onStderr\)[\s\S]*child\.off\("exit", onExit\)/);
  assert.match(packedSmokeScript, /const packageManager = requiredPackageManager\(packageJson\.packageManager\)/);
  assert.match(packedSmokeScript, /function requiredPackageManager\(value\)/);
  assert.match(packedSmokeScript, /\^pnpm@\\d\+\\\.\\d\+\\\.\\d\+\$/);
  assert.match(packedSmokeScript, /const providedTarball = optionalProvidedTarball\(\)/);
  assert.match(packedSmokeScript, /function optionalProvidedTarball\(\)/);
  assert.match(packedSmokeScript, /PACKED_SMOKE_TARBALL/);
  assert.match(packedSmokeScript, /hasUnsafePathText\(value\)/);
  assert.match(packedSmokeScript, /utf8ByteLengthExceeds\(value, MAX_PACKED_SMOKE_TARBALL_PATH_BYTES\)/);
  assert.match(packedSmokeScript, /const childEnv = isolatedChildEnv\(privateHome\)/);
  assert.match(packedSmokeScript, /providedTarball \?\? \(await packCurrentProject\(packDir, childEnv\)\)/);
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
  assert.match(packedSmokeScript, /function isolatedChildEnv\(privateHome\)/);
  assert.match(packedSmokeScript, /const MAX_CHILD_ENV_VALUE_BYTES = 8_192/);
  assert.match(packedSmokeScript, /\["PATH", true\]/);
  assert.match(packedSmokeScript, /HOME: home/);
  assert.match(packedSmokeScript, /USERPROFILE: home/);
  assert.match(packedSmokeScript, /NPM_CONFIG_USERCONFIG: path\.join\(home, "\.npmrc"\)/);
  assert.match(packedSmokeScript, /PNPM_HOME: path\.join\(home, "pnpm-home"\)/);
  assert.match(packedSmokeScript, /COREPACK_HOME: path\.join\(home, "corepack-home"\)/);
  assert.match(packedSmokeScript, /throw new Error\(`\$\{name\} must be a non-empty NUL-free child environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\.`\)/);
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
  assert.match(ciWorkflow, /pnpm check/);
  assert.match(ciWorkflow, /pnpm build/);
  assert.match(ciWorkflow, /pnpm test:unit/);
  assert.match(ciWorkflow, /pnpm smoke:native/);
  assert.match(ciWorkflow, /pnpm smoke:packed/);
  assert.match(ciWorkflow, /pnpm exec playwright install --with-deps chromium/);
  assert.match(ciWorkflow, /pnpm test:e2e/);
  assert.match(ciWorkflow, /pnpm test:browser/);
  assert.match(ciWorkflow, /ubuntu-latest/);
  assert.match(ciWorkflow, /macos-latest/);
  assert.match(ciWorkflow, /windows-latest/);
  assert.match(ciWorkflow, /docker build -t p2p-transfer:test \./);
  assert.match(ciWorkflow, /container started without ALLOWED_ORIGINS in production/);
  assert.match(ciWorkflow, /container started without SIGNALING_TOPOLOGY in production/);
  assert.match(ciWorkflow, /--read-only --cap-drop=ALL --security-opt no-new-privileges/);
  assert.match(ciWorkflow, /https:\/\/evil\.example/);
  assert.doesNotMatch(ciWorkflow, /\bnpm\s+(?:install|ci|publish)\b|npx\b/);
});

test("release workflow is tag-only, verifies one artifact, and publishes with trusted provenance", () => {
  assert.match(securityPolicy, /release workflow is tag-only/);
  assert.match(securityPolicy, /Release publishing must use npm trusted publishing with OIDC provenance/);
  assert.match(securityPolicy, /GitHub Releases must be tag-only, run only after npm publishing succeeds, re-verify the downloaded npm tarball/);
  assert.match(releaseWorkflow, /tags:\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.doesNotMatch(releaseWorkflow, /pull_request:/);
  assert.doesNotMatch(releaseWorkflow, /branches:/);
  assert.match(releaseWorkflow, /test "\$\{GITHUB_REF_NAME\}" = "v\$\{version\}"/);
  assert.match(releaseWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(releaseWorkflow, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed[\s\S]*pnpm test:e2e[\s\S]*pnpm test:browser[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.match(releaseWorkflow, /pnpm --config\.ignore-scripts=true pack --pack-destination release-artifacts/);
  assert.match(releaseWorkflow, /node scripts\/write-release-checksum\.mjs/);
  assert.match(releaseChecksumScript, /return `\$\{packedPackageName\(name\)\}-\$\{version\}\.tgz`[\s\S]*const expectedTarballName = expectedTarballNameFor\(packageJson\)[\s\S]*entries\.length !== 1 \|\| !entries\[0\]\?\.isFile\(\) \|\| entries\[0\]\.name !== expectedTarballName[\s\S]*createHash\("sha256"\)[\s\S]*writeFile\(path\.join\(artifactDir, "SHA256SUMS"\), `\$\{checksum\}  \$\{expectedTarballName\}\\n`, \{ flag: "wx" \}\)/);
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
  assert.match(securityPolicy, /release artifact verification must use the checked script with a symlink-safe realpath entrypoint check and verifier-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, validate artifact directory entry names before sorting, filtering, or reporting them/);
  assert.match(securityPolicy, /reject control\/format\/path-shaped or over-byte-budget entry names without echoing them/);
  assert.match(securityPolicy, /prove the downloaded artifact directory contains only `SHA256SUMS` and the expected tarball/);
  assert.match(securityPolicy, /release artifact verification must extract exactly one regular-file `package\/package\.json` with bounded in-process gzip\/tar parsing/);
  assert.match(securityPolicy, /reject invalid gzip archives with verifier-owned deterministic errors/);
  assert.match(securityPolicy, /release artifact verification must fatal-UTF-8-decode workspace metadata, checksum files, tar header text, and packed metadata through verifier-owned deterministic errors/);
  assert.match(securityPolicy, /release artifact verification must cap the checked workspace `package\.json files` expansion by file count and total bytes before hashing expected package files/);
  assert.match(securityPolicy, /release artifact verification must reject packed package install lifecycle scripts and must compare critical packed package metadata including package manager, publish config, module type, Node engine, published bin paths, package file list, runtime dependency pins, dependency-class fields, import entrypoint fields/);
  assert.match(releaseArtifactScript, /const MAX_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_EXPECTED_PACKED_FILES = 4096/);
  assert.match(releaseArtifactScript, /const MAX_EXPECTED_PACKED_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseArtifactScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseArtifactScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(releaseArtifactScript, /console\.error\("Release artifact verification failed:"\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactErrorMessage\(error\)/);
  assert.match(releaseArtifactScript, /function containsAbsolutePathText\(value\)/);
  assert.match(releaseArtifactScript, /function shouldPrintTarballPath\(\)/);
  assert.match(releaseArtifactScript, /args\.length === 1 && args\[0\] === "--print-tarball"/);
  assert.match(releaseArtifactScript, /function verifiedTarballPath\(tarball\)/);
  assert.match(releaseArtifactScript, /relative !== path\.join\("release-artifacts", tarball\.basename\)/);
  assert.doesNotMatch(releaseArtifactScript, /process\.cwd\(\)/);
  assert.match(releaseArtifactScript, /const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\(`\$\{path\.relative\(root, file\)\} changed before verification\.`\)/);
  assert.match(releaseArtifactScript, /return await readHandleText\(handle, opened\.size, path\.relative\(root, file\)\)/);
  assert.doesNotMatch(releaseArtifactScript, /readFile\(file, "utf8"\)/);
  assert.match(releaseArtifactScript, /const MAX_PACKED_PACKAGE_JSON_BYTES = 64 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_TAR_SCAN_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_CHECKSUM_FILE_BYTES = 256/);
  assert.match(releaseArtifactScript, /requiredPackageVersion\(expected\.version\)/);
  assert.match(releaseArtifactScript, /assertPackedPackageMetadataMatchesWorkspace\(expected, packed\)/);
  assert.match(releaseArtifactScript, /function releasePackageMetadata\(record, label\)/);
  assert.match(releaseArtifactScript, /function assertNoInstallLifecycleScripts\(scripts, label\)/);
  assert.match(releaseArtifactScript, /new Set\(\["preinstall", "install", "postinstall", "prepare"\]\)/);
  assert.match(releaseArtifactScript, /packageManager: exactStringField\(record, "packageManager", label\)/);
  assert.match(releaseArtifactScript, /publishConfig: canonicalJsonValue\(requiredPlainRecord\(record, "publishConfig", label\)/);
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
  assert.match(releaseArtifactScript, /utf8ByteLengthExceeds\(descriptor\.value, MAX_RELEASE_ENV_VALUE_BYTES\)/);
  assert.match(releaseArtifactScript, /release tag does not match package version \$\{version\}/);
  assert.doesNotMatch(releaseArtifactScript, /release tag \$\{value\} does not match/);
  assert.match(releaseArtifactScript, /release artifact package metadata does not match the checked workspace metadata/);
  assert.doesNotMatch(releaseArtifactScript, /String\(packed\.name\)|String\(packed\.version\)/);
  assert.match(releaseArtifactScript, /const MAX_ARTIFACT_ENTRY_NAME_BYTES = 255/);
  assert.match(releaseArtifactScript, /\(await readdir\(artifactDir\)\)\.map\(releaseArtifactEntryName\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactEntryName\(value\)/);
  assert.match(releaseArtifactScript, /release-artifacts contains an invalid artifact entry name/);
  assert.match(releaseArtifactScript, /assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /release-artifacts must contain only/);
  assert.match(releaseArtifactScript, /await verifyChecksumFile\(tarball\)/);
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
  assert.match(releaseArtifactScript, /release tarball changed while being read/);
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
  assert.match(releaseWorkflow, /needs:\n\s+- verify\n\s+- docker\n\s+- platform-smoke/);
  assert.match(releaseWorkflow, /environment: npm/);
  assert.match(releaseWorkflow, /id-token: write/);
  assert.match(securityPolicy, /release publishing must pass the verifier-emitted tarball path to packed smoke and `pnpm publish` instead of rediscovering the artifact with `find` or a shell glob after verification/);
  assert.match(releaseWorkflow, /verify downloaded release artifact[\s\S]*id: verify_artifact[\s\S]*tgz="\$\(node scripts\/verify-release-artifact\.mjs --print-tarball\)"[\s\S]*printf 'tarball=%s\\n' "\$tgz" >> "\$GITHUB_OUTPUT"/);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*tgz="\$\{\{ steps\.verify_artifact\.outputs\.tarball \}\}"[\s\S]*test -f "\$tgz"[\s\S]*pnpm publish "\$tgz" --provenance --access public --ignore-scripts/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*needs:\n      - publish[\s\S]*permissions:\n      contents: write[\s\S]*node scripts\/verify-release-artifact\.mjs --print-tarball[\s\S]*gh release create "\$GITHUB_REF_NAME" "\$tgz" release-artifacts\/SHA256SUMS --title "\$GITHUB_REF_NAME" --notes-file CHANGELOG\.md/);
  assert.doesNotMatch(releaseWorkflow, /pnpm publish release-artifacts\/\*\.tgz/);
  assert.doesNotMatch(releaseWorkflow, /smoke downloaded release artifact[\s\S]*find release-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /publish npm package[\s\S]*find release-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /sha256sum -c SHA256SUMS|execFileSync\('tar'/);
  assert.match(releaseWorkflow, /smoke downloaded release artifact[\s\S]*tgz="\$\{\{ steps\.verify_artifact\.outputs\.tarball \}\}"[\s\S]*test -f "\$tgz"[\s\S]*PACKED_SMOKE_TARBALL="\$tgz" node scripts\/smoke-packed\.mjs[\s\S]*publish npm package/);
  assert.match(releaseWorkflow, /docker build -t p2p-transfer:release \./);
  assert.match(releaseWorkflow, /container started without ALLOWED_ORIGINS in production/);
  assert.match(releaseWorkflow, /container started without SIGNALING_TOPOLOGY in production/);
  assert.match(releaseWorkflow, /--read-only --cap-drop=ALL --security-opt no-new-privileges/);
  assert.match(releaseWorkflow, /ubuntu-latest/);
  assert.match(releaseWorkflow, /macos-latest/);
  assert.match(releaseWorkflow, /windows-latest/);
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
  assert.equal(packageJson.dependencies?.ws, "8.20.1", "ws must stay on the reviewed patched floor until newer releases satisfy the pnpm minimum-release-age policy.");
  assertAtLeast(packageJson.devDependencies?.vite, "8.0.5", "vite must include the CVE-2026-39363/CVE-2026-39364/CVE-2026-39365 fixes.");
  assertAtLeast(packageJson.dependencies?.nanoid, "5.0.9", "nanoid must include the CVE-2024-55565 fix.");
  for (const resolved of lockfileResolvedPackages(pnpmLock).filter((entry) => entry.startsWith("nanoid@"))) {
    const version = packageVersionFromResolvedEntry(resolved);
    assertAtLeast(version, version.startsWith("3.") ? "3.3.8" : "5.0.9", `${resolved} must include the CVE-2024-55565 fix.`);
  }
});

test("critical PAKE dependency identity and install surface stay reviewed", () => {
  assert.match(securityPolicy, /critical PAKE dependency metadata must stay reviewed and must not add install lifecycle hooks/);
  assert.match(securityPolicy, /Dependabot must track the critical `@cipherman\/pake-js` PAKE dependency in its own production update group/);
  assert.match(dependabotConfig, /critical-pake-dependency:\n\s+patterns:\n\s+- "@cipherman\/pake-js"\n\s+dependency-type: production/);
  assert.match(dependabotConfig, /production-dependencies:\n\s+dependency-type: production\n\s+exclude-patterns:\n\s+- "@cipherman\/pake-js"/);
  assert.equal(packageJson.dependencies?.["@cipherman/pake-js"], "0.1.1");
  assert.equal(pakePackageJson.name, "@cipherman/pake-js");
  assert.equal(pakePackageJson.version, "0.1.1");
  assert.equal(pakePackageJson.license, "MIT");
  assert.deepEqual(pakePackageJson.repository, {
    type: "git",
    url: "git+https://github.com/alicommit-malp/pake-js.git"
  });
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
    assert.equal(pakePackageJson.scripts?.[lifecycle], lifecycle === "prepublishOnly" ? "npm run clean && npm run typecheck && npm run lint && npm run test && npm run build" : undefined);
  }
  assert.match(pnpmLock, /^  '@cipherman\/pake-js@0\.1\.1':\n    resolution: \{integrity: sha512-/m);
  assert.match(pnpmLock, /^  '@noble\/curves@1\.9\.7':\n    resolution: \{integrity: sha512-/m);
  assert.match(pnpmLock, /^  '@noble\/hashes@1\.8\.0':\n    resolution: \{integrity: sha512-/m);
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
    "@types/node@22.19.17",
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
    "tinyglobby@0.2.16",
    "tslib@2.8.1",
    "tsx@4.22.3",
    "typescript@6.0.3",
    "undici-types@6.21.0",
    "vite@8.0.14",
    "webidl-conversions@7.0.0",
    "ws@8.20.1"
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

function sourcePathForBuiltBin(relativePath: string): URL {
  if (relativePath === "dist-node/cli/index.js") return new URL("../src/cli/index.ts", import.meta.url);
  if (relativePath === "dist-node/server/index.js") return new URL("../src/server/index.ts", import.meta.url);
  throw new Error(`Unexpected bin path ${relativePath}.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
