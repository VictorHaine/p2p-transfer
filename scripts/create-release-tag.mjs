#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const GIT_TIMEOUT_MS = 30_000;
const CHILD_KILL_GRACE_MS = 5_000;

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

if (isMain()) {
  createReleaseTag().catch((error) => {
    console.error("Release tag creation failed:");
    console.error(`- ${releaseTagCreateErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function createReleaseTag() {
  assertEntrypoint();
  const tag = parseArgs(process.argv.slice(2));
  const packageJson = parseJson(await readText(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES), "package metadata");
  const version = requiredPackageVersion(ownDataValue(packageJson, "version"));
  if (tag !== `v${version}`) throw new Error("release tag must match package version.");

  const headSha = await localHeadSha();
  await assertLocalReleaseCommitSigned(headSha);
  await assertLocalReleaseWorktreeClean();
  await fetchReleaseMain();
  await assertLocalHeadMatchesRemoteMain(headSha);
  await assertLocalReleaseTagMissing(tag);
  await assertRemoteReleaseTagMissing(tag);

  let created = false;
  try {
    await runGit(["tag", "-s", "-m", tag, tag, headSha], "release tag could not be signed.");
    created = true;
    await assertReleaseTagPointsAt(tag, headSha);
    await runGit(["tag", "-v", tag], "release tag signature verification failed.");
  } catch (error) {
    if (created) await deleteCreatedTag(tag);
    throw error;
  }

  console.log(JSON.stringify({ ok: true, tag, commit: headSha }, null, 2));
}

function parseArgs(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 1) throw new Error("Usage: node scripts/create-release-tag.mjs [--] vX.Y.Z");
  const tag = values[0];
  if (typeof tag !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error("release tag must be an exact v-prefixed semver release.");
  }
  return tag;
}

function assertEntrypoint() {
  if (!isMain()) throw new Error("Release tag creator must be executed directly.");
}

async function localHeadSha() {
  const output = await runGitOutput(["rev-parse", "--verify", "HEAD^{commit}"], "release target commit could not be resolved.");
  const value = output.trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("release target commit could not be resolved.");
  return value;
}

async function assertLocalReleaseCommitSigned(headSha) {
  const result = await runGit(["verify-commit", headSha], "release commit signature verification failed.", { allowFailure: true });
  if (result.status !== 0) throw new Error("Release target commit must have a valid Git commit signature before tagging.");
}

async function assertLocalReleaseWorktreeClean() {
  const output = await runGitOutput(["status", "--porcelain=v1", "--untracked-files=normal"], "release worktree status could not be checked.");
  if (output.trim().length > 0) throw new Error("Release tag creation must run from a clean worktree.");
}

async function fetchReleaseMain() {
  await runGit(["fetch", "--no-tags", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], "remote main could not be refreshed.");
}

async function assertLocalHeadMatchesRemoteMain(headSha) {
  const output = await runGitOutput(["rev-parse", "--verify", "origin/main^{commit}"], "remote main commit could not be resolved.");
  if (output.trim() !== headSha) throw new Error("Release tag creation must run from the current remote main commit.");
}

async function assertLocalReleaseTagMissing(tag) {
  const result = await runGit(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], "local release tag existence could not be checked.", { allowFailure: true });
  if (result.status === 0) throw new Error("Release tag already exists locally.");
}

async function assertRemoteReleaseTagMissing(tag) {
  const result = await runGit(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], "remote release tag existence could not be checked.", { allowFailure: true });
  if (result.status === 0) throw new Error("Release tag already exists on origin.");
  if (result.status !== 2) throw new Error("remote release tag existence could not be checked.");
}

async function assertReleaseTagPointsAt(tag, headSha) {
  const output = await runGitOutput(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], "release tag target could not be verified.");
  if (output.trim() !== headSha) throw new Error("release tag does not point at the preflighted commit.");
}

async function deleteCreatedTag(tag) {
  await runGit(["tag", "-d", tag], "created release tag cleanup failed.", { allowFailure: true }).catch(() => undefined);
}

async function readText(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`${path.relative(root, file)} is not a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${path.relative(root, file)} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path.relative(root, file)} is not a regular file.`);
    if (opened.size < 1 || opened.size > maxBytes) throw new Error(`${path.relative(root, file)} size is outside the allowed range.`);
    if (!sameFile(info, opened)) throw new Error(`${path.relative(root, file)} changed before verification.`);
    return await readHandleText(handle, opened.size, path.relative(root, file));
  } finally {
    await handle.close();
  }
}

async function readHandleText(handle, size, label) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error(`${label} changed while being read.`);
  const opened = await handle.stat();
  if (opened.size !== size) throw new Error(`${label} changed while being read.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function ownDataValue(record, key) {
  if (!isPlainRecord(record)) throw new Error("package metadata must be a JSON object.");
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredPackageVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("package version must be an exact semver release.");
  }
  return value;
}

function runGit(args, failureMessage, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      env: safeChildEnv(),
      stdio: "ignore"
    });
    settleGitChild(child, failureMessage, options, resolve, reject);
  });
}

function runGitOutput(args, failureMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      env: safeChildEnv(),
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    let total = 0;
    let outputError;
    child.stdout.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        outputError = new Error(failureMessage);
        child.kill("SIGTERM");
        return;
      }
      total += chunk.byteLength;
      if (total > 1024) {
        outputError = new Error(failureMessage);
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });
    settleGitChild(child, failureMessage, {}, () => {
      if (outputError) {
        reject(outputError);
        return;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
      } catch {
        reject(new Error(failureMessage));
      }
    }, reject);
  });
}

function settleGitChild(child, failureMessage, options, resolve, reject) {
  let settled = false;
  let killTimer;
  let timeoutError;
  const timer = setTimeout(() => {
    timeoutError = new Error(`${failureMessage} Git subprocess timed out.`);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
  }, GIT_TIMEOUT_MS);

  child.on("error", () => {
    rejectOnce(new Error(failureMessage));
  });
  child.on("exit", (code) => {
    if (killTimer) clearTimeout(killTimer);
    if (timeoutError) {
      rejectOnce(timeoutError);
      return;
    }
    const status = typeof code === "number" ? code : null;
    if (!options.allowFailure && status !== 0) {
      rejectOnce(new Error(failureMessage));
      return;
    }
    resolveOnce({ status });
  });

  function resolveOnce(result) {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(result);
  }

  function rejectOnce(error) {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  }

  function cleanup() {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

function safeChildEnv() {
  const allowed = [
    ["PATH", true],
    ["HOME", false],
    ["TMPDIR", false],
    ["TMP", false],
    ["TEMP", false],
    ["SystemRoot", false],
    ["SYSTEMROOT", false],
    ["COMSPEC", false],
    ["PATHEXT", false],
    ["SSH_AUTH_SOCK", false],
    ["SSH_AGENT_PID", false],
    ["GPG_TTY", false],
    ["GNUPGHOME", false],
    ["XDG_RUNTIME_DIR", false]
  ];
  const env = {};
  for (const [name, required] of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
    if (descriptor && "value" in descriptor && isSafeChildEnvValue(descriptor.value)) {
      env[name] = descriptor.value;
    } else if (required) {
      throw new Error(`${name} must be a non-empty control-free child environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
    }
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function releaseTagCreateErrorMessage(error) {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.length <= 1024 &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message) &&
    !containsAbsolutePathText(error.message)
  ) {
    return error.message;
  }
  return "release tag creation failed.";
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function utf8ByteLengthExceeds(value, maxBytes) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
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
