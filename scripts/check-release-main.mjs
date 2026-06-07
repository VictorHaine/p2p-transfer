#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_RELEASE_ENV_VALUE_BYTES = 256;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const GIT_TIMEOUT_MS = 120_000;
const CHILD_KILL_GRACE_MS = 5_000;
const MAX_ERROR_MESSAGE_CHARS = 1024;

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

if (isMain()) {
  verifyReleaseMain().catch((error) => {
    console.error("Release main reachability check failed:");
    console.error(`- ${releaseMainErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function verifyReleaseMain() {
  assertNoArgs(process.argv.slice(2));
  assertEntrypoint();
  const sha = requiredGitSha(envString("GITHUB_SHA"));
  await runGit(["fetch", "--no-tags", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], "remote main branch could not be fetched.");
  await assertSameCommit(["merge-base", "--is-ancestor", sha, "origin/main"]);
  await assertSameCommit(["merge-base", "--is-ancestor", "origin/main", sha]);
}

async function assertSameCommit(args) {
  const result = await runGit(args, "release tag current-main check failed.", { allowFailure: true });
  if (result.status === 0) return;
  if (result.status === 1) throw new Error("release tag commit does not match current main.");
  throw new Error("release tag current-main check failed.");
}

function assertNoArgs(args) {
  if (args.length !== 0) throw new Error("Unsupported release main reachability arguments.");
}

function assertEntrypoint() {
  if (!isMain()) throw new Error("Release main verifier must be executed directly.");
}

function runGit(args, failureMessage, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      env: safeChildEnv(),
      stdio: "ignore"
    });
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
  });
}

function requiredGitSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error("GITHUB_SHA must be a 40-character hex commit id.");
  return value;
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

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function releaseMainErrorMessage(error) {
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
  return "release main reachability check failed.";
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
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
