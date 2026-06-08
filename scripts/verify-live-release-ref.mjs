#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_GITHUB_API_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const MAX_ERROR_MESSAGE_CHARS = 1024;
const EXPECTED_GITHUB_REPOSITORY = "VictorHaine/p2p-transfer";

const scriptPath = fileURLToPath(import.meta.url);

if (isMain()) {
  assertLiveReleaseRefFromEnv().catch((error) => {
    console.error("Live release ref verification failed:");
    console.error(`- ${liveReleaseRefErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

export async function assertLiveReleaseRefFromEnv() {
  const tag = requiredReleaseTag(requiredEnvString("GITHUB_REF_NAME"));
  assertReleaseTagRef(tag);
  const expectedSha = requiredCommitSha(requiredEnvString("GITHUB_SHA"));
  const repository = requiredRepository(requiredEnvString("GITHUB_REPOSITORY"));
  const token = releaseRefToken();
  const tagSha = await githubTagCommitSha(token, repository, tag);
  if (tagSha !== expectedSha) throw new Error("GitHub tag ref does not match the release workflow commit.");
  const mainSha = await githubMainCommitSha(token, repository);
  if (mainSha !== expectedSha) throw new Error("GitHub main branch does not match the release workflow commit.");
}

function releaseRefToken() {
  const githubToken = optionalEnvString("GITHUB_TOKEN");
  const ghToken = optionalEnvString("GH_TOKEN");
  if (githubToken !== undefined && ghToken !== undefined) throw new Error("Set only one of GITHUB_TOKEN or GH_TOKEN for live release ref verification.");
  const token = githubToken ?? ghToken;
  if (token === undefined) throw new Error(`GITHUB_TOKEN or GH_TOKEN must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  return token;
}

async function githubTagCommitSha(token, repository, tag) {
  const tagRef = await github(token, `/repos/${repository}/git/ref/tags/${tag}`);
  if (!tagRef || tagRef.ref !== `refs/tags/${tag}` || !tagRef.object || typeof tagRef.object.sha !== "string" || typeof tagRef.object.type !== "string") {
    throw new Error("GitHub tag ref response was invalid.");
  }
  if (tagRef.object.type === "commit") return requiredCommitSha(tagRef.object.sha);
  if (tagRef.object.type !== "tag") throw new Error("GitHub tag ref response was invalid.");
  const tagObject = await github(token, `/repos/${repository}/git/tags/${requiredCommitSha(tagRef.object.sha)}`);
  if (!tagObject || !tagObject.object || tagObject.object.type !== "commit" || typeof tagObject.object.sha !== "string") {
    throw new Error("GitHub tag object response was invalid.");
  }
  return requiredCommitSha(tagObject.object.sha);
}

async function githubMainCommitSha(token, repository) {
  const mainRef = await github(token, `/repos/${repository}/git/ref/heads/main`);
  if (!mainRef || mainRef.ref !== "refs/heads/main" || !mainRef.object || mainRef.object.type !== "commit" || typeof mainRef.object.sha !== "string") {
    throw new Error("GitHub main ref response was invalid.");
  }
  return requiredCommitSha(mainRef.object.sha);
}

async function github(token, apiPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API}${apiPath}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error("GitHub API request timed out.");
    throw new Error("GitHub API request failed.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}.`);
  const text = await boundedGithubResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub API response was not valid JSON.");
  }
}

async function boundedGithubResponseText(response) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error("GitHub API response stream was invalid.");
    total += chunk.byteLength;
    if (total > MAX_GITHUB_API_RESPONSE_BYTES) throw new Error("GitHub API response exceeded the byte limit.");
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new Error("GitHub API response was not valid UTF-8.");
  }
}

function requiredReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) throw new Error("GITHUB_REF_NAME must be an exact release tag.");
  return value;
}

function assertReleaseTagRef(tag) {
  if (requiredEnvString("GITHUB_REF_TYPE") !== "tag" || requiredEnvString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

function requiredCommitSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("GITHUB_SHA must be an exact commit SHA.");
  return value;
}

function requiredRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY must be owner/name.");
  if (value !== EXPECTED_GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY must match the release repository.");
  return value;
}

function requiredEnvString(name) {
  const value = optionalEnvString(name);
  if (value === undefined) throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  return value;
}

function optionalEnvString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === "") return undefined;
  if (typeof descriptor.value !== "string" || /[\p{Cc}\p{Cf}]/u.test(descriptor.value) || utf8ByteLengthExceeds(descriptor.value, MAX_ENV_VALUE_BYTES)) {
    throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function liveReleaseRefErrorMessage(error) {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.length <= MAX_ERROR_MESSAGE_CHARS &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message) &&
    !containsAbsolutePathText(error.message)
  ) {
    return error.message;
  }
  return "live release ref verification failed.";
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
}

function utf8ByteLengthExceeds(value, maxBytes) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
