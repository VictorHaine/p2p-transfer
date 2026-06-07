#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedChildEnv } from "./smoke-packed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, "release-artifacts");
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_KILL_GRACE_MS = 5_000;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Release artifact smoke failed:");
    console.error(`- ${smokeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = parsePackageMetadata(await readBoundedRegularFile(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"));
  const version = requiredVersion(packageJson.version);
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-release-artifact-smoke-"));
  const childEnv = await privateReleaseArtifactEnv(path.join(tmp, "home"));
  await rm(artifactDir, { recursive: true, force: true });
  try {
    await run(pnpm, ["--config.ignore-scripts=true", "pack", "--pack-destination", "release-artifacts"], childEnv, {}, "release artifact pack");
    await run(process.execPath, ["scripts/write-release-sbom.mjs"], childEnv, {}, "release SBOM generation");
    await run(process.execPath, ["scripts/write-release-checksum.mjs"], childEnv, {}, "release checksum generation");
    await run(
      process.execPath,
      ["scripts/verify-release-artifact.mjs"],
      childEnv,
      { GITHUB_REF_NAME: `v${version}`, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/v${version}` },
      "release artifact verification"
    );
  } finally {
    if (!options.keepArtifacts) await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function privateReleaseArtifactEnv(homeDir) {
  const env = isolatedChildEnv(homeDir);
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.PNPM_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.COREPACK_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.LOCALAPPDATA, { recursive: true, mode: 0o700 });
  await mkdir(env.APPDATA, { recursive: true, mode: 0o700 });
  return env;
}

function parseArgs(args) {
  if (args.length === 0) return { keepArtifacts: false };
  if (args.length === 1 && args[0] === "--keep-artifacts") return { keepArtifacts: true };
  throw new Error("Unsupported release artifact smoke arguments.");
}

function noFollowReadFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

async function readBoundedRegularFile(filePath, maxBytes, description) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error(`${description} could not be read.`);
  }
  if (!info.isFile()) throw new Error(`${description} must be a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${description} exceeds the byte limit.`);

  let handle;
  try {
    handle = await open(filePath, noFollowReadFlags());
  } catch {
    throw new Error(`${description} could not be opened.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${description} must be a regular file.`);
    if (stat.size < 1 || stat.size > maxBytes) throw new Error(`${description} exceeds the byte limit.`);
    if (!sameFile(info, stat)) throw new Error(`${description} changed before verification.`);
    const bytes = await readVerifiedHandleBytes(handle, stat.size, description);
    const opened = await handle.stat();
    if (opened.size !== stat.size || !sameFile(stat, opened)) throw new Error(`${description} changed while being read.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readVerifiedHandleBytes(handle, size, description) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error(`${description} changed while being read.`);
  return buffer;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function parsePackageMetadata(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("package metadata must be valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("package metadata must be valid JSON.");
  }
}

function run(command, args, childEnv, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...childEnv, ...env },
      stdio: "ignore"
    });
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${label} timed out.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, CHILD_TIMEOUT_MS);

    child.on("error", rejectOnce);
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      if (code !== 0) {
        rejectOnce(new Error(`${label} failed with ${childExitStatus(code, signal)}.`));
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
  });
}

function childExitStatus(code, signal) {
  if (typeof code === "number") return `exit status ${code}`;
  if (typeof signal === "string" && /^[A-Z0-9]+$/u.test(signal)) return `signal ${signal}`;
  return "unknown child status";
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error("package version must be an exact semver release.");
  return value;
}

function smokeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release artifact smoke failed with an internal error.";
  }
  if (containsPathLikeText(error.message)) return "release artifact smoke failed with path-sensitive evidence.";
  return error.message;
}

function containsPathLikeText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
