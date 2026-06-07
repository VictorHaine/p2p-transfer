#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_PNPM_COREPACK_HASH = "sha512.c85357fe17ca12dd23dd7071822666dfd7e3cb76fe214e3370b5ea2fb34f2a231185509b63e717f3cd0acb38dd3f8d82bcd5e8172400ae678b70ea4fbed0896d";
const MAX_OUTPUT_CHARS = 200_000;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const MAX_PRIVATE_HOME_BYTES = 4_096;
const CHILD_KILL_GRACE_MS = 5_000;

try {
  await main();
} catch (error) {
  console.error("Checked pnpm preparation failed:");
  console.error(`- ${safeErrorMessage(error)}`);
  process.exitCode = 1;
}

async function main() {
  const packageJson = JSON.parse(await readCheckedText(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"));
  const version = checkedPnpmVersion(packageJson.packageManager);
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-checked-pnpm-"));
  const archive = path.join(tmp, "corepack-pnpm.tgz");
  const childEnv = await privateChildEnv(path.join(tmp, "home"));
  try {
    await run("corepack", ["pack", `pnpm@${version}`, "-o", archive], { cwd: root, env: childEnv, timeoutMs: 120_000 });
    const metadataText = await run("tar", ["-xOzf", archive, `pnpm/${version}/.corepack`], { cwd: root, env: childEnv, timeoutMs: 30_000 });
    assertCorepackMetadata(metadataText.stdout, version);
    await run("corepack", ["enable"], { cwd: root, env: childEnv, timeoutMs: 30_000 });
    await run("corepack", ["install", "-g", "--cache-only", archive], { cwd: root, env: childEnv, timeoutMs: 60_000 });
    const prepared = await run("corepack", ["pnpm", "--version"], { cwd: root, env: childEnv, timeoutMs: 30_000 });
    if (prepared.stdout.trim() !== version) throw new Error("Prepared pnpm version did not match the checked package manager pin.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readCheckedText(file, maxBytes, label) {
  const info = await openCheckedFile(file, maxBytes, label);
  const handle = info.handle;
  try {
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error(`${label} changed while being read.`);
    const afterRead = await handle.stat();
    if (!sameFile(info.stat, afterRead)) throw new Error(`${label} changed while being read.`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function openCheckedFile(file, maxBytes, label) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${label} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(info, opened)) throw new Error(`${label} changed before verification.`);
    return { handle, size: opened.size, stat: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function privateChildEnv(privateHome) {
  const home = checkedPrivateHome(privateHome);
  const env = safeChildEnv();
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    PNPM_HOME: path.join(home, "pnpm-home"),
    COREPACK_HOME: path.join(home, "corepack-home"),
    LOCALAPPDATA: path.join(home, "local-app-data"),
    APPDATA: path.join(home, "app-data")
  });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.PNPM_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.COREPACK_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.LOCALAPPDATA, { recursive: true, mode: 0o700 });
  await mkdir(env.APPDATA, { recursive: true, mode: 0o700 });
  return env;
}

function checkedPrivateHome(value) {
  if (typeof value !== "string" || value.length < 1 || /[\p{Cc}\p{Cf}]/u.test(value) || utf8ByteLengthExceeds(value, MAX_PRIVATE_HOME_BYTES)) {
    throw new Error(`Checked pnpm private home must be a non-empty control-free path under ${MAX_PRIVATE_HOME_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function safeChildEnv() {
  return Object.fromEntries(
    [
      ["PATH", true],
      ["SystemRoot", false],
      ["COMSPEC", false],
      ["ComSpec", false],
      ["PATHEXT", false]
    ].flatMap(([name, required]) => {
      const value = childEnvValue(name, required);
      return value === undefined ? [] : [[name, value]];
    })
  );
}

function childEnvValue(name, required) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
    if (required) throw new Error(`${name} must be a non-empty control-free child environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
    return undefined;
  }
  const value = descriptor.value;
  if (typeof value !== "string" || value.length < 1 || /[\p{Cc}\p{Cf}]/u.test(value) || utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES)) {
    throw new Error(`${name} must be a non-empty control-free child environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function checkedPnpmVersion(value) {
  if (typeof value !== "string") throw new Error("packageManager must be an exact pnpm version pin.");
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) throw new Error("packageManager must be an exact pnpm version pin.");
  return match[1];
}

function assertCorepackMetadata(text, version) {
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new Error("Corepack pnpm metadata is not valid JSON.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Corepack pnpm metadata is invalid.");
  const locator = metadata.locator;
  const bin = metadata.bin;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) throw new Error("Corepack pnpm locator is invalid.");
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) throw new Error("Corepack pnpm bin metadata is invalid.");
  if (locator.name !== "pnpm" || locator.reference !== version) throw new Error("Corepack pnpm locator did not match the checked package manager pin.");
  if (bin.pnpm !== "./bin/pnpm.mjs" || bin.pnpx !== "./bin/pnpx.mjs") throw new Error("Corepack pnpm bin metadata is invalid.");
  if (metadata.hash !== EXPECTED_PNPM_COREPACK_HASH) throw new Error("Corepack pnpm package hash did not match the reviewed integrity.");
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${command} timed out.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", rejectOnce);
    child.on("exit", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
      } else if (code === 0) {
        resolveOnce({ stdout, stderr });
      } else {
        rejectOnce(new Error(`${command} failed with exit code ${code}.`));
      }
    });
    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
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

function appendBounded(current, chunk) {
  if (!Buffer.isBuffer(chunk)) throw new Error("Checked pnpm child output chunk is invalid.");
  const next = current + chunk.toString("utf8").replace(/[\p{Cc}\p{Cf}]/gu, "");
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(next.length - MAX_OUTPUT_CHARS);
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
      bytes += next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

function safeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > MAX_OUTPUT_CHARS) {
    return "checked pnpm preparation failed with an internal error.";
  }
  if (/(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(error.message)) {
    return "checked pnpm preparation failed with path-sensitive evidence.";
  }
  return error.message;
}
