#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const EXPECTED_GITHUB_REPOSITORY = "VictorHaine/p2p-transfer";
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
  requiredGitHubActionsContext();
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
    await createGitHubRelease(token, repository, tag, sha, notes, assets, assertLiveReleaseRefFromEnv);
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
    if (!sameFile(info, opened)) throw new Error(`${description} changed before release creation.`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error(`${description} could not be read completely.`);
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead)) throw new Error(`${description} changed while being read.`);
    return { name: path.basename(relative), bytes };
  } finally {
    await handle.close();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function createGitHubRelease(token, repository, tag, expectedSha, notes, assets, liveRefCheck = async () => {}) {
  if (!isSafeEnvValue(token)) throw new Error(`GH_TOKEN must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  requiredRepository(repository);
  requiredReleaseTag(tag);
  requiredCommitSha(expectedSha);
  if (typeof liveRefCheck !== "function") throw new Error("live release ref checker is invalid.");
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
  assertReleaseAssetChecksums(assets);

  if ((await githubReleaseTagCommitSha(token, repository, tag)) !== expectedSha) throw new Error("GitHub tag ref does not match the release workflow commit.");
  await liveRefCheck();
  const release = await createDraftRelease(token, repository, tag, notes, assets, liveRefCheck);
  if (release.alreadyPublished === true) return;
  const { id, uploadUrl } = releaseDraftInfo(release, tag);
  try {
    for (const asset of assets) {
      await uploadReleaseAsset(token, uploadUrl, asset);
    }
    await assertRemoteReleaseAssetsMatch(token, repository, id, assets);
  } catch (error) {
    await deleteDraftRelease(token, repository, id).catch(() => undefined);
    throw error;
  }
  try {
    await liveRefCheck();
    await publishDraftRelease(token, repository, id);
    await assertPublishedReleaseMatches(token, repository, id, tag, notes, assets);
  } catch (error) {
    if (await reconcileDraftPublishFailure(token, repository, id, tag, notes, assets).catch(() => false)) return;
    throw error;
  }
}

async function createDraftRelease(token, repository, tag, notes, assets, liveRefCheck) {
  try {
    return await postDraftRelease(token, repository, tag, notes);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
    const existing = await existingReleaseForTag(token, repository, tag, notes);
    if (existing.state === "published") {
      await assertRemoteReleaseAssetsMatch(token, repository, existing.id, assets);
      return { alreadyPublished: true };
    }
    await deleteDraftRelease(token, repository, existing.id);
    await liveRefCheck();
    return await postDraftRelease(token, repository, tag, notes);
  }
}

async function postDraftRelease(token, repository, tag, notes) {
  return await github(token, "POST", `/repos/${repository}/releases`, {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: true,
    prerelease: false
  });
}

async function existingReleaseForTag(token, repository, tag, notes) {
  const release = await github(token, "GET", `/repos/${repository}/releases/tags/${tag}`);
  return existingReleaseInfo(release, tag, notes);
}

function existingReleaseInfo(release, tag, notes) {
  if (!release || release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id < 1 || typeof release.draft !== "boolean") {
    throw new Error("GitHub release response was invalid.");
  }
  if (release.draft === false) assertPublishedReleaseMetadata(release, tag, notes);
  return { id: release.id, state: release.draft ? "draft" : "published" };
}

function assertPublishedReleaseMetadata(release, tag, notes) {
  if (release.name !== tag || release.body !== notes || release.prerelease !== false) {
    throw new Error("existing published GitHub release metadata does not match verified release metadata.");
  }
}

function assertReleaseAssetChecksums(assets) {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const tarball = assets.find((asset) => asset.name.endsWith(".tgz"));
  const checksums = byName.get("SHA256SUMS");
  const sbom = byName.get("SBOM.cdx.json");
  if (!tarball || !checksums || !sbom) throw new Error("release assets are invalid.");

  let text;
  try {
    text = UTF8.decode(checksums.bytes);
  } catch {
    throw new Error("release asset checksums are invalid.");
  }
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.tgz)\n([a-f0-9]{64})  (SBOM\.cdx\.json)\n$/.exec(text);
  if (!match || match[2] !== tarball.name || match[4] !== sbom.name) throw new Error("release asset checksums are invalid.");
  if (sha256Hex(tarball.bytes) !== match[1] || sha256Hex(sbom.bytes) !== match[3]) {
    throw new Error("release asset checksums are invalid.");
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function publishDraftRelease(token, repository, id) {
  await github(token, "PATCH", `/repos/${repository}/releases/${id}`, { draft: false });
}

async function assertPublishedReleaseMatches(token, repository, id, tag, notes, assets) {
  const release = await github(token, "GET", `/repos/${repository}/releases/${id}`);
  if (releaseState(release, id, tag, notes) !== "published") throw new Error("GitHub release was not published.");
  await assertRemoteReleaseAssetsMatch(token, repository, id, assets);
}

async function assertRemoteReleaseAssetsMatch(token, repository, releaseId, assets) {
  const remoteAssets = await github(token, "GET", `/repos/${repository}/releases/${releaseId}/assets?per_page=100`);
  const byName = releaseAssetMetadataByName(remoteAssets, repository, assets);
  try {
    for (const asset of assets) {
      const remote = byName.get(asset.name);
      if (!remote || remote.size !== asset.bytes.length) throw new Error("mismatch");
      const remoteBytes = await githubFetchBytes(remote.url, {
        method: "GET",
        headers: {
          accept: "application/octet-stream",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28"
        },
        expectedStatus: 200,
        maxBytes: asset.bytes.length
      });
      if (!remoteBytes.equals(asset.bytes)) throw new Error("mismatch");
    }
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (error instanceof Error && /^GitHub API /.test(error.message)) throw error;
    throw new Error("existing published GitHub release assets do not match verified release artifacts.");
  }
}

function releaseAssetMetadataByName(remoteAssets, repository, expectedAssets) {
  if (!Array.isArray(remoteAssets) || remoteAssets.length !== expectedAssets.length) {
    throw new Error("existing published GitHub release assets do not match verified release artifacts.");
  }
  const expectedNames = new Set(expectedAssets.map((asset) => asset.name));
  const byName = new Map();
  for (const asset of remoteAssets) {
    if (
      !asset ||
      typeof asset.name !== "string" ||
      !expectedNames.has(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      typeof asset.url !== "string"
    ) {
      throw new Error("existing published GitHub release assets do not match verified release artifacts.");
    }
    let parsed;
    try {
      parsed = new URL(asset.url);
    } catch {
      throw new Error("existing published GitHub release assets do not match verified release artifacts.");
    }
    if (parsed.origin !== API || parsed.pathname !== `/repos/${repository}/releases/assets/${asset.id}` || parsed.search !== "" || parsed.hash !== "" || !Number.isSafeInteger(asset.id) || asset.id < 1) {
      throw new Error("existing published GitHub release assets do not match verified release artifacts.");
    }
    if (byName.has(asset.name)) throw new Error("existing published GitHub release assets do not match verified release artifacts.");
    byName.set(asset.name, { size: asset.size, url: asset.url });
  }
  return byName;
}

async function reconcileDraftPublishFailure(token, repository, id, tag, notes, assets) {
  const release = await github(token, "GET", `/repos/${repository}/releases/${id}`);
  const state = releaseState(release, id, tag, notes);
  if (state === "published") {
    await assertRemoteReleaseAssetsMatch(token, repository, id, assets);
    return true;
  }
  await deleteDraftRelease(token, repository, id).catch(() => undefined);
  return false;
}

function releaseState(release, id, tag, notes) {
  if (!release || release.id !== id || release.tag_name !== tag || typeof release.draft !== "boolean") {
    throw new Error("GitHub release response was invalid.");
  }
  if (release.draft === false) assertPublishedReleaseMetadata(release, tag, notes);
  return release.draft ? "draft" : "published";
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
    const body = await readResponseBytes(response, MAX_GITHUB_API_RESPONSE_BYTES);
    if (response.status !== options.expectedStatus) throw new GitHubApiError(response.status);
    if (!options.parseJson) return undefined;
    return parseJsonBody(UTF8.decode(body));
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new Error("GitHub API request timed out.");
    if (error instanceof Error && /^GitHub API response /.test(error.message)) throw error;
    throw new Error("GitHub API request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function githubFetchBytes(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: options.method, headers: options.headers, signal: controller.signal });
    const body = await readResponseBytes(response, options.maxBytes);
    if (response.status !== options.expectedStatus) throw new GitHubApiError(response.status);
    return body;
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new Error("GitHub API request timed out.");
    if (error instanceof Error && /^GitHub API response /.test(error.message)) throw error;
    throw new Error("GitHub API request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytes(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("GitHub API response body was invalid.");
      total += value.byteLength;
      if (total > maxBytes) throw new Error("GitHub API response exceeded the byte limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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
  if (value !== EXPECTED_GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY must match the release repository.");
  return value;
}

function requiredGitHubActionsContext() {
  if (requiredEnvString("GITHUB_ACTIONS") !== "true") throw new Error("GITHUB_ACTIONS must be true for GitHub Release creation.");
  if (!/^[1-9]\d{0,19}$/.test(requiredEnvString("GITHUB_RUN_ID"))) throw new Error("GITHUB_RUN_ID must be a positive decimal GitHub Actions run id.");
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
