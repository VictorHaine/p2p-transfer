#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_RELEASE_ENV_VALUE_BYTES = 256;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const MAX_ERROR_MESSAGE_CHARS = 1024;
const GIT_TIMEOUT_MS = 30_000;
const CHILD_KILL_GRACE_MS = 5_000;

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

if (isMain()) {
  verifyReleaseTag().catch((error) => {
    console.error("Release tag verification failed:");
    console.error(`- ${releaseTagErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function verifyReleaseTag() {
  assertNoArgs(process.argv.slice(2));
  assertEntrypoint();
  const packageJson = parseJson(await readText(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES), "package metadata");
  const version = requiredPackageVersion(ownDataValue(packageJson, "version"));
  const tag = requiredReleaseTag(envString("GITHUB_REF_NAME"));
  assertReleaseTagRef(tag);
  if (tag !== `v${version}`) {
    throw new Error("release tag does not match package version.");
  }
  await assertReleaseTagAnnotated(tag);
}

function assertNoArgs(args) {
  if (args.length !== 0) throw new Error("Unsupported release tag verification arguments.");
}

function assertEntrypoint() {
  if (!isMain()) throw new Error("Release tag verifier must be executed directly.");
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

function requiredReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("release tag must be an exact v-prefixed semver release.");
  }
  return value;
}

function assertReleaseTagRef(tag) {
  if (envString("GITHUB_REF_TYPE") !== "tag" || envString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

async function assertReleaseTagAnnotated(tag) {
  const output = await runGitOutput(["cat-file", "-t", `refs/tags/${tag}`], "release tag object could not be inspected.");
  if (output.trim() !== "tag") throw new Error("release tag must be an annotated tag.");
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
    settleGitChild(child, failureMessage, () => {
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

function settleGitChild(child, failureMessage, resolve, reject) {
  let settled = false;
  let killTimer;
  let timeoutError;
  const timer = setTimeout(() => {
    timeoutError = new Error(`${failureMessage} Git subprocess timed out.`);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
  }, GIT_TIMEOUT_MS);

  child.on("error", () => rejectOnce(new Error(failureMessage)));
  child.on("exit", (code) => {
    if (killTimer) clearTimeout(killTimer);
    if (timeoutError) {
      rejectOnce(timeoutError);
      return;
    }
    if (code !== 0) {
      rejectOnce(new Error(failureMessage));
      return;
    }
    resolveOnce();
  });

  function resolveOnce() {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
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
    ["SystemRoot", false],
    ["SYSTEMROOT", false],
    ["COMSPEC", false],
    ["PATHEXT", false]
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
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function envString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length < 1 ||
    /[\p{Cc}\p{Cf}]/u.test(descriptor.value) ||
    utf8ByteLengthExceeds(descriptor.value, MAX_RELEASE_ENV_VALUE_BYTES)
  ) {
    throw new Error(`${name} must be a non-empty control-free string under ${MAX_RELEASE_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function releaseTagErrorMessage(error) {
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
  return "release tag verification failed.";
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
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

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
