#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendBoundedOutput, isolatedChildEnv } from "./smoke-packed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TARBALL_OUTPUT_BYTES = 512;
const MAX_RELEASE_NOTES_BYTES = 128 * 1024;
const MAX_CHECKSUM_BYTES = 512;
const MAX_SBOM_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 120_000;

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
  const repository = requiredRepository(requiredEnvString("GITHUB_REPOSITORY"));
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-github-release-"));
  try {
    const childEnv = await privateChildEnv(path.join(tmp, "home"));
    const tarball = await verifiedTarballPath({ ...childEnv, GITHUB_REF_NAME: tag });
    await run(process.execPath, ["scripts/write-release-notes.mjs"], { env: childEnv, timeoutMs: CHILD_TIMEOUT_MS });
    await assertArtifactFile(tarball, 50 * 1024 * 1024, "release tarball");
    await assertArtifactFile("release-artifacts/SHA256SUMS", MAX_CHECKSUM_BYTES, "SHA256SUMS");
    await assertArtifactFile("release-artifacts/SBOM.cdx.json", MAX_SBOM_BYTES, "release SBOM");
    await assertArtifactFile("release-artifacts/RELEASE_NOTES.md", MAX_RELEASE_NOTES_BYTES, "release notes");
    await run(
      "gh",
      [
        "release",
        "create",
        tag,
        tarball,
        "release-artifacts/SHA256SUMS",
        "release-artifacts/SBOM.cdx.json",
        "--title",
        tag,
        "--notes-file",
        "release-artifacts/RELEASE_NOTES.md",
        "--repo",
        repository
      ],
      { env: { ...childEnv, GH_TOKEN: requiredEnvString("GH_TOKEN"), GITHUB_REPOSITORY: repository }, timeoutMs: CHILD_TIMEOUT_MS }
    );
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

async function assertArtifactFile(relative, maxBytes, description) {
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
  } finally {
    await handle.close();
  }
}

function requiredReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("GITHUB_REF_NAME must be an exact release tag.");
  }
  return value;
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
    throw new Error(`${name} must be a non-empty NUL-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function isSafeEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !utf8ByteLengthExceeds(value, MAX_ENV_VALUE_BYTES);
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
