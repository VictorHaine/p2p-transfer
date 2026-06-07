#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedChildEnv } from "./smoke-packed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM_REGISTRY = "https://registry.npmjs.org";
const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
const EXPECTED_REPOSITORY_URL = "git+https://github.com/VictorHaine/p2p-transfer.git";
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_NPM_RESPONSE_BYTES = 1024 * 1024;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_CHILD_OUTPUT_CHARS = 200_000;
const NPM_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_KILL_GRACE_MS = 5_000;
const STATIC_NPM_TOKEN_ENV = ["NODE_AUTH_TOKEN", "NPM_TOKEN"];
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("npm bootstrap failed:");
    console.error(`- ${bootstrapErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = options.apply ? consumeEnvString("NPM_BOOTSTRAP_TOKEN") : undefined;
  if (options.apply) rejectAmbientNpmPublishEnv();

  const workspace = await readWorkspacePackage();
  if (workspace.version === BOOTSTRAP_VERSION) throw new Error("workspace package version must not be the bootstrap version.");
  if (await npmPackageExists(workspace.name)) throw new Error("npm package already exists; do not run bootstrap.");

  if (!options.apply) {
    console.log(JSON.stringify({ package: workspace.name, version: BOOTSTRAP_VERSION, apply: false, ok: true }, null, 2));
    return;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "ff-npm-bootstrap-"));
  try {
    const packageDir = path.join(tmp, "package");
    const homeDir = path.join(tmp, "home");
    await mkdir(packageDir);
    const childEnv = await privateChildEnv(homeDir, token);
    await writeBootstrapPackage(packageDir, workspace);
    await run(
      pnpm,
      ["--config.ignore-scripts=true", "publish", "--access", "public", "--no-git-checks", "--registry", NPM_REGISTRY],
      { cwd: packageDir, env: childEnv, timeoutMs: CHILD_TIMEOUT_MS, label: "npm bootstrap publish" }
    );
    console.log(JSON.stringify({ package: workspace.name, version: BOOTSTRAP_VERSION, apply: true, ok: true }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readWorkspacePackage() {
  const text = await readText(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata");
  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch {
    throw new Error("package metadata is not valid JSON.");
  }
  const name = packageJson?.name;
  const version = packageJson?.version;
  const repositoryUrl = packageJson?.repository?.url;
  if (typeof name !== "string" || !PACKAGE_NAME_RE.test(name)) throw new Error("package name must be an exact npm package name.");
  if (typeof version !== "string" || !SEMVER_RE.test(version)) throw new Error("package version must be an exact semver release.");
  if (repositoryUrl !== EXPECTED_REPOSITORY_URL) throw new Error("package repository URL must match the GitHub repository before bootstrap.");
  return { name, version };
}

async function writeBootstrapPackage(packageDir, workspace) {
  const body = {
    name: workspace.name,
    version: BOOTSTRAP_VERSION,
    private: false,
    description: "Bootstrap placeholder for trusted publishing setup. Do not install this version.",
    license: "MIT",
    repository: {
      type: "git",
      url: EXPECTED_REPOSITORY_URL
    },
    publishConfig: {
      access: "public"
    },
    files: ["README.md", "LICENSE"]
  };
  await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(
    path.join(packageDir, "README.md"),
    `# ${workspace.name} bootstrap\n\nThis temporary package version only reserves the npm package for GitHub trusted publishing. Install a real release instead.\n`,
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(path.join(packageDir, "LICENSE"), "MIT\n", { flag: "wx", mode: 0o600 });
}

async function privateChildEnv(homeDir, token) {
  const env = isolatedChildEnv(homeDir);
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.PNPM_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.COREPACK_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.LOCALAPPDATA, { recursive: true, mode: 0o700 });
  await mkdir(env.APPDATA, { recursive: true, mode: 0o700 });
  await writeFile(env.NPM_CONFIG_USERCONFIG, `//registry.npmjs.org/:_authToken=${token}\n`, { flag: "wx", mode: 0o600 });
  return env;
}

async function npmPackageExists(name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPM_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error("npm registry request timed out.");
    throw new Error("npm registry request failed.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("npm registry returned an unexpected status.");
  await boundedResponseText(response);
  return true;
}

async function readText(file, maxBytes, label) {
  const info = await lstat(file).catch(() => {
    throw new Error(`${label} could not be read.`);
  });
  if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${label} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new Error(`${label} could not be opened.`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} is not a regular file.`);
    if (opened.size < 1 || opened.size > maxBytes) throw new Error(`${label} size is outside the allowed range.`);
    if (!sameFile(info, opened)) throw new Error(`${label} changed before verification.`);
    return await readHandleText(handle, opened.size, label);
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

async function boundedResponseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("npm registry response body was invalid.");
      total += value.byteLength;
      if (total > MAX_NPM_RESPONSE_BYTES) throw new Error("npm registry response exceeded the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Keep the original npm registry failure; lock release is best-effort cleanup.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("npm registry response was not valid UTF-8.");
  }
}

function parseArgs(args) {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  if (args.length === 1 && args[0] === "--dry-run") return { apply: false };
  throw new Error("Usage: node scripts/bootstrap-npm-package.mjs [--dry-run|--apply]");
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
      timeoutError = new Error(`${options.label} timed out.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
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
      else rejectOnce(new Error(`${options.label} failed with ${childExitStatus(code, signal)}.`));
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

function appendBoundedOutput(current, chunk) {
  if (!Buffer.isBuffer(chunk)) throw new Error("npm bootstrap child output chunk was invalid.");
  const next = current + new TextDecoder("utf-8", { fatal: false }).decode(chunk).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : ""));
  if (next.length <= MAX_CHILD_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CHILD_OUTPUT_CHARS);
}

function childExitStatus(code, signal) {
  if (typeof code === "number") return `exit code ${code}`;
  if (typeof signal === "string" && /^[A-Z0-9]+$/.test(signal)) return `signal ${signal}`;
  return "unknown status";
}

function envString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === "") return undefined;
  if (typeof descriptor.value !== "string" || /[\p{Cc}\p{Cf}]/u.test(descriptor.value) || utf8ByteLengthExceeds(descriptor.value, MAX_ENV_VALUE_BYTES)) {
    throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function consumeEnvString(name) {
  const value = envString(name);
  delete process.env[name];
  if (!value) throw new Error(`Set ${name} to a one-time npm automation token before --apply.`);
  return value;
}

function rejectAmbientNpmPublishEnv() {
  for (const name of Object.keys(process.env)) {
    if (!isForbiddenNpmPublishEnvName(name)) continue;
    if (envString(name)) throw new Error(`Remove ${name} before bootstrap publishing; use only NPM_BOOTSTRAP_TOKEN and the checked npm registry.`);
  }
}

function isForbiddenNpmPublishEnvName(name) {
  if (STATIC_NPM_TOKEN_ENV.includes(name)) return true;
  const lower = name.toLowerCase();
  if (!lower.startsWith("npm_config_")) return false;
  const option = lower.slice("npm_config_".length).replaceAll("-", "_");
  return option === "registry" || option === "userconfig" || option.includes("auth") || option.includes("token") || option.includes("password") || option.includes("certfile") || option.includes("keyfile");
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function bootstrapErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "npm bootstrap failed with an internal error.";
  }
  return error.message;
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
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
