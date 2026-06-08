#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendBoundedOutput, isolatedChildEnv } from "./smoke-packed.mjs";
import { assertLiveReleaseRefFromEnv } from "./verify-live-release-ref.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TARBALL_OUTPUT_BYTES = 512;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_NPM_RESPONSE_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 240_000;
const NPM_TIMEOUT_MS = 20_000;
const NPM_REGISTRY = "https://registry.npmjs.org";
const EXPECTED_GITHUB_REPOSITORY = "VictorHaine/p2p-transfer";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const REQUIRED_PUBLISH_ENV = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITHUB_SHA"
];
const STATIC_NPM_TOKEN_ENV = ["NODE_AUTH_TOKEN", "NPM_TOKEN"];

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Release publish failed:");
    console.error(`- ${releasePublishErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  rejectStaticNpmTokens();
  const tag = requiredReleaseTag(requiredEnvString("GITHUB_REF_NAME"));
  assertReleaseTagRef(tag);
  const packageMetadata = await readPackageMetadata();
  if (tag !== `v${packageMetadata.version}`) throw new Error("release tag does not match package version.");
  const publishEnv = requiredPublishEnv();
  await assertLiveReleaseRefFromEnv();
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-release-publish-"));
  try {
    const childEnv = await privateChildEnv(path.join(tmp, "home"));
    const tarball = await verifiedTarballPath({ ...childEnv, ...releaseVerifierEnv(tag) });
    await run(process.execPath, ["scripts/smoke-packed.mjs"], {
      env: { ...childEnv, PACKED_SMOKE_TARBALL: tarball },
      timeoutMs: CHILD_TIMEOUT_MS
    });
    await assertLiveReleaseRefFromEnv();
    const tarballDigests = await localTarballDigests(tarball);
    await run(pnpm, ["publish", tarball, "--provenance", "--access", "public", "--registry", NPM_REGISTRY, "--tag", "latest", "--ignore-scripts"], {
      env: { ...childEnv, ...publishEnv },
      timeoutMs: CHILD_TIMEOUT_MS
    });
    await assertNpmPublished(packageMetadata, tarballDigests);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

async function privateChildEnv(privateHome) {
  const env = isolatedChildEnv(privateHome);
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.PNPM_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.COREPACK_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.LOCALAPPDATA, { recursive: true, mode: 0o700 });
  await mkdir(env.APPDATA, { recursive: true, mode: 0o700 });
  return env;
}

async function verifiedTarballPath(env) {
  const result = await run(process.execPath, ["scripts/verify-release-artifact.mjs", "--print-tarball"], {
    env,
    timeoutMs: 60_000
  });
  const output = result.stdout;
  if (Buffer.byteLength(output, "utf8") > MAX_TARBALL_OUTPUT_BYTES || !/^release-artifacts\/[A-Za-z0-9._-]+\.tgz\n$/.test(output) || result.stderr.length > 0) {
    throw new Error("release artifact verifier did not emit exactly one safe tarball path.");
  }
  return output.trimEnd();
}

function requiredPublishEnv() {
  const out = {};
  for (const name of REQUIRED_PUBLISH_ENV) out[name] = requiredEnvString(name);
  if (out.GITHUB_ACTIONS !== "true") throw new Error("GITHUB_ACTIONS must be true for trusted publishing.");
  if (out.GITHUB_REPOSITORY !== EXPECTED_GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY must match the trusted publishing repository.");
  if (!/^[1-9]\d{0,19}$/.test(out.GITHUB_RUN_ID)) throw new Error("GITHUB_RUN_ID must be a positive decimal GitHub Actions run id.");
  return out;
}

function requiredReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("GITHUB_REF_NAME must be an exact release tag.");
  }
  return value;
}

function assertReleaseTagRef(tag) {
  if (requiredEnvString("GITHUB_REF_TYPE") !== "tag" || requiredEnvString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

function releaseVerifierEnv(tag) {
  return { GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/${tag}` };
}

async function readPackageMetadata() {
  const text = await readCheckedText(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata");
  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch {
    throw new Error("package metadata is not valid JSON.");
  }
  const name = packageJson?.name;
  const version = packageJson?.version;
  if (typeof name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/.test(name)) {
    throw new Error("package name must be an exact npm package name.");
  }
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error("package version must be an exact semver release.");
  }
  return { name, version };
}

async function readCheckedText(file, maxBytes, label) {
  const info = await lstat(file).catch(() => {
    throw new Error(`${label} could not be read.`);
  });
  if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${label} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new Error(`${label} could not be opened.`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} is not a regular file.`);
    if (opened.size < 1 || opened.size > maxBytes) throw new Error(`${label} size is outside the allowed range.`);
    if (!sameFile(info, opened)) throw new Error(`${label} changed before verification.`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error(`${label} changed while being read.`);
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead)) throw new Error(`${label} changed while being read.`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`${label} is not valid UTF-8.`);
    }
  } finally {
    await handle.close();
  }
}

async function localTarballDigests(tarballPath) {
  const file = path.resolve(root, tarballPath);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("release tarball path is invalid.");
  const info = await lstat(file).catch(() => {
    throw new Error("release tarball could not be read.");
  });
  if (!info.isFile()) throw new Error("release tarball is not a regular file.");
  if (info.size < 1 || info.size > MAX_TARBALL_BYTES) throw new Error("release tarball size is outside the allowed range.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new Error("release tarball could not be opened.");
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("release tarball is not a regular file.");
    if (opened.size < 1 || opened.size > MAX_TARBALL_BYTES) throw new Error("release tarball size is outside the allowed range.");
    if (!sameFile(info, opened)) throw new Error("release tarball changed before verification.");
    const sha1 = createHash("sha1");
    const sha512 = createHash("sha512");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.byteLength, opened.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      sha1.update(chunk);
      sha512.update(chunk);
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("release tarball changed while being read.");
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead)) throw new Error("release tarball changed while being read.");
    return {
      integrity: `sha512-${sha512.digest("base64")}`,
      shasum: sha1.digest("hex")
    };
  } finally {
    await handle.close();
  }
}

async function assertNpmPublished(packageMetadata, tarballDigests) {
  const metadata = await npmPackageMetadata(packageMetadata.name);
  const versions = plainRecord(metadata?.versions, "npm registry versions");
  const publishedVersion = plainRecord(versions[packageMetadata.version], "npm registry published version");
  if (publishedVersion.name !== packageMetadata.name || publishedVersion.version !== packageMetadata.version) {
    throw new Error("npm registry published package identity does not match the release artifact.");
  }
  const dist = plainRecord(publishedVersion.dist, "npm registry published dist metadata");
  if (dist.integrity !== tarballDigests.integrity || dist.shasum !== tarballDigests.shasum) {
    throw new Error("npm registry published tarball integrity does not match the release artifact.");
  }
  assertRegistryTarballUrl(dist.tarball, packageMetadata);
  const distTags = plainRecord(metadata?.["dist-tags"], "npm registry dist-tags");
  if (distTags.latest !== packageMetadata.version) {
    throw new Error("npm registry latest dist-tag does not point to the published release.");
  }
}

async function npmPackageMetadata(name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPM_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error("npm registry request timed out.");
    throw new Error("npm registry request failed.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) throw new Error("npm registry does not contain the published package.");
  if (!response.ok) throw new Error("npm registry returned an unexpected status.");
  const text = await boundedResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("npm registry response was not valid JSON.");
  }
}

async function boundedResponseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("npm registry response body was invalid.");
      total += value.byteLength;
      if (total > MAX_NPM_RESPONSE_BYTES) throw new Error("npm registry response exceeded the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve the original registry failure; releasing the stream lock is best-effort cleanup.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("npm registry response was not valid UTF-8.");
  }
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertRegistryTarballUrl(value, packageMetadata) {
  if (typeof value !== "string" || value.length > 512 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error("npm registry published tarball URL is invalid.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("npm registry published tarball URL is invalid.");
  }
  if (
    parsed.origin !== NPM_REGISTRY ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.endsWith(`/${packageLocalName(packageMetadata.name)}-${packageMetadata.version}.tgz`)
  ) {
    throw new Error("npm registry published tarball URL is invalid.");
  }
}

function packageLocalName(name) {
  return name.startsWith("@") ? name.slice(1).split("/")[1] : name;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function rejectStaticNpmTokens() {
  for (const name of STATIC_NPM_TOKEN_ENV) {
    const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
    if (descriptor && "value" in descriptor && descriptor.value !== undefined && descriptor.value !== "") {
      throw new Error(`${name} must not be present for trusted publishing.`);
    }
  }
}

function requiredEnvString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || !isSafeEnvValue(descriptor.value)) {
    throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function isSafeEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_ENV_VALUE_BYTES);
}

function utf8ByteLengthExceeds(value, limit) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error("release publish subprocess timed out.");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.on("error", rejectOnce);
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      if (code === 0) resolveOnce({ stdout, stderr });
      else rejectOnce(new Error(`release publish subprocess failed with ${childExitStatus(code, signal)}.`));
    });
    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    }
    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    }
  });
}

function childExitStatus(code, signal) {
  if (typeof code === "number") return `exit code ${code}`;
  if (typeof signal === "string" && /^[A-Z0-9]+$/.test(signal)) return `signal ${signal}`;
  return "unknown status";
}

function releasePublishErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 200_000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release publish failed with an internal error.";
  }
  if (containsAbsolutePathText(error.message)) return "release publish failed with path-sensitive evidence.";
  return error.message;
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}
