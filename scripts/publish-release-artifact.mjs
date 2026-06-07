#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendBoundedOutput, isolatedChildEnv } from "./smoke-packed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TARBALL_OUTPUT_BYTES = 512;
const CHILD_TIMEOUT_MS = 240_000;
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
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-release-publish-"));
  try {
    const childEnv = await privateChildEnv(path.join(tmp, "home"));
    const tarball = await verifiedTarballPath({ ...childEnv, GITHUB_REF_NAME: tag });
    await run(process.execPath, ["scripts/smoke-packed.mjs"], {
      env: { ...childEnv, PACKED_SMOKE_TARBALL: tarball },
      timeoutMs: CHILD_TIMEOUT_MS
    });
    await run(pnpm, ["publish", tarball, "--provenance", "--access", "public", "--ignore-scripts"], {
      env: { ...childEnv, ...requiredPublishEnv() },
      timeoutMs: CHILD_TIMEOUT_MS
    });
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
