#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeChildEnv } from "./smoke-packed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, "release-artifacts");
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;

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
  const packageJson = parsePackageMetadata(await readBoundedRegularFile(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"));
  const version = requiredVersion(packageJson.version);
  await rm(artifactDir, { recursive: true, force: true });
  try {
    run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", "release-artifacts"], {});
    run(process.execPath, ["scripts/write-release-checksum.mjs"], {});
    run(process.execPath, ["scripts/verify-release-artifact.mjs"], { GITHUB_REF_NAME: `v${version}` });
  } finally {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
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

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...safeChildEnv(), ...env },
    stdio: "pipe",
    timeout: 120_000
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error("package version must be an exact semver release.");
  return value;
}

function smokeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release artifact smoke failed with an internal error.";
  }
  return error.message;
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
