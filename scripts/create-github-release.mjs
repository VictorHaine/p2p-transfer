#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendBoundedOutput, isolatedChildEnv } from "./smoke-packed.mjs";
import { assertLiveReleaseRefFromEnv } from "./verify-live-release-ref.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TARBALL_OUTPUT_BYTES = 512;
const MAX_RELEASE_NOTES_BYTES = 128 * 1024;
const MAX_CHECKSUM_BYTES = 512;
const MAX_SBOM_BYTES = 1024 * 1024;
const MAX_GITHUB_API_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 120_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

class GitHubApiError extends Error {
  constructor(status) {
    super(`GitHub API request failed with HTTP status ${status}.`);
    this.status = status;
  }
}

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("GitHub Release creation failed:");
    console.error(`- ${githubReleaseErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const tag = requiredReleaseTag(requiredEnvString("GITHUB_REF_NAME"));
  assertReleaseTagRef(tag);
  const sha = requiredCommitSha(requiredEnvString("GITHUB_SHA"));
  const repository = requiredRepository(requiredEnvString("GITHUB_REPOSITORY"));
  const token = requiredEnvString("GH_TOKEN");
  await assertLiveReleaseRefFromEnv();
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-github-release-"));
  try {
    const childEnv = await privateChildEnv(path.join(tmp, "home"));
    const tarball = await verifiedTarballPath({ ...childEnv, GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/${tag}` });
    await run(process.execPath, ["scripts/write-release-notes.mjs"], { env: childEnv, timeoutMs: CHILD_TIMEOUT_MS });
    const assets = [
      await readArtifactFile(tarball, 50 * 1024 * 1024, "release tarball"),
      await readArtifactFile("release-artifacts/SHA256SUMS", MAX_CHECKSUM_BYTES, "SHA256SUMS"),
      await readArtifactFile("release-artifacts/SBOM.cdx.json", MAX_SBOM_BYTES, "release SBOM")
    ];
    const notes = UTF8.decode((await readArtifactFile("release-artifacts/RELEASE_NOTES.md", MAX_RELEASE_NOTES_BYTES, "release notes")).bytes);
    await createGitHubRelease(token, repository, tag, sha, notes, assets);
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

async function readArtifactFile(relative, maxBytes, description) {
  if (typeof relative !== "string" || !/^release-artifacts\/[A-Za-z0-9._-]+(?:\.tgz|\.md|\.json)?$/.test(relative) || relative.endsWith("/")) {
    throw new Error(`${description} path is invalid.`);
  }
  const file = path.join(root, relative);
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`${description} must be a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${description} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${description} must be a regular file.`);
    if (opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${description} changed before release creation.`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error(`${description} could not be read completely.`);
    return { name: path.basename(relative), bytes };
  } finally {
    await handle.close();
  }
}

export async function createGitHubRelease(token, repository, tag, expectedSha, notes, assets) {
  if (!isSafeEnvValue(token)) throw new Error(`GH_TOKEN must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  requiredRepository(repository);
  requiredReleaseTag(tag);
  requiredCommitSha(expectedSha);
  if (typeof notes !== "string" || notes.length < 1 || utf8ByteLengthExceeds(notes, MAX_RELEASE_NOTES_BYTES)) throw new Error("release notes are invalid.");
  if (!Array.isArray(assets) || assets.length !== 3) throw new Error("release assets are invalid.");
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !/^[A-Za-z0-9._-]+(?:\.tgz|\.json)?$/.test(asset.name) || !Buffer.isBuffer(asset.bytes) || asset.bytes.length < 1) {
      throw new Error("release assets are invalid.");
    }
  }
  const assetNames = assets.map((asset) => asset.name);
  if (new Set(assetNames).size !== assets.length || assetNames.filter((name) => name.endsWith(".tgz")).length !== 1 || !assetNames.includes("SHA256SUMS") || !assetNames.includes("SBOM.cdx.json")) {
    throw new Error("release assets are invalid.");
  }

  if ((await githubReleaseTagCommitSha(token, repository, tag)) !== expectedSha) throw new Error("GitHub tag ref does not match the release workflow commit.");
  const release = await github(token, "POST", `/repos/${repository}/releases`, {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: true,
    prerelease: false
  });
  const { id, uploadUrl } = releaseDraftInfo(release, tag);
  try {
    for (const asset of assets) {
      await uploadReleaseAsset(token, uploadUrl, asset);
    }
  } catch (error) {
    await deleteDraftRelease(token, repository, id).catch(() => undefined);
    throw error;
  }
  await github(token, "PATCH", `/repos/${repository}/releases/${id}`, { draft: false });
}

async function githubReleaseTagCommitSha(token, repository, tag) {
  const tagRef = await github(token, "GET", `/repos/${repository}/git/ref/tags/${tag}`);
  if (!tagRef || tagRef.ref !== `refs/tags/${tag}` || !tagRef.object || typeof tagRef.object.sha !== "string" || typeof tagRef.object.type !== "string") {
    throw new Error("GitHub tag ref response was invalid.");
  }
  if (tagRef.object.type === "commit") return requiredCommitSha(tagRef.object.sha);
  if (tagRef.object.type !== "tag") throw new Error("GitHub tag ref response was invalid.");
  const tagObject = await github(token, "GET", `/repos/${repository}/git/tags/${requiredCommitSha(tagRef.object.sha)}`);
  if (!tagObject || !tagObject.object || tagObject.object.type !== "commit" || typeof tagObject.object.sha !== "string") {
    throw new Error("GitHub tag object response was invalid.");
  }
  return requiredCommitSha(tagObject.object.sha);
}

async function github(token, method, requestPath, body, options = {}) {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/")) throw new Error("GitHub API request path was invalid.");
  return githubFetchJson(`${API}${requestPath}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    expectedStatus: options.expectedStatus ?? (method === "POST" ? 201 : 200),
    parseJson: options.parseJson ?? true
  });
}

function releaseDraftInfo(release, tag) {
  if (!release || release.tag_name !== tag || release.draft !== true || !Number.isSafeInteger(release.id) || release.id < 1 || typeof release.upload_url !== "string") {
    throw new Error("GitHub release response was invalid.");
  }
  const uploadUrl = release.upload_url.replace(/\{[^{}]*\}$/, "");
  const parsed = new URL(uploadUrl);
  if (parsed.origin !== "https://uploads.github.com" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("GitHub release upload URL was invalid.");
  }
  return { id: release.id, uploadUrl };
}

async function deleteDraftRelease(token, repository, id) {
  await github(token, "DELETE", `/repos/${repository}/releases/${id}`, undefined, { expectedStatus: 204, parseJson: false });
}

async function uploadReleaseAsset(token, uploadUrl, asset) {
  const separator = uploadUrl.includes("?") ? "&" : "?";
  await githubFetchJson(`${uploadUrl}${separator}name=${encodeURIComponent(asset.name)}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": assetContentType(asset.name),
      "x-github-api-version": "2022-11-28"
    },
    body: asset.bytes,
    expectedStatus: 201,
    parseJson: true
  });
}

async function githubFetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: options.method, headers: options.headers, body: options.body, signal: controller.signal });
    const body = await readResponseBody(response);
    if (response.status !== options.expectedStatus) throw new GitHubApiError(response.status);
    if (!options.parseJson) return undefined;
    return parseJsonBody(body);
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new Error("GitHub API request timed out.");
    if (error instanceof Error && /^GitHub API response /.test(error.message)) throw error;
    throw new Error("GitHub API request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("GitHub API response body was invalid.");
      total += value.byteLength;
      if (total > MAX_GITHUB_API_RESPONSE_BYTES) throw new Error("GitHub API response exceeded the byte limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return UTF8.decode(Buffer.concat(chunks, total));
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub API response was not valid JSON.");
  }
}

function assetContentType(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".tgz")) return "application/gzip";
  return "text/plain; charset=utf-8";
}

function requiredReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("GITHUB_REF_NAME must be an exact release tag.");
  }
  return value;
}

function requiredCommitSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("GITHUB_SHA must be an exact commit SHA.");
  }
  return value;
}

function assertReleaseTagRef(tag) {
  if (requiredEnvString("GITHUB_REF_TYPE") !== "tag" || requiredEnvString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

function requiredRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPOSITORY must be an exact owner/name repository.");
  }
  return value;
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
      timeoutError = new Error("GitHub Release subprocess timed out.");
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
      else rejectOnce(new Error(`GitHub Release subprocess failed with ${childExitStatus(code, signal)}.`));
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

function githubReleaseErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 200_000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "GitHub Release creation failed with an internal error.";
  }
  if (containsAbsolutePathText(error.message)) return "GitHub Release creation failed with path-sensitive evidence.";
  return error.message;
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}
