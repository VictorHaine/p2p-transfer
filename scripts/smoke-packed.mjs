#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { realpathSync } from "node:fs";
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_CONFORMANCE_JSON_BYTES = 128 * 1024;
const MAX_CHILD_OUTPUT_CHARS = 200_000;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const MAX_CHILD_STDIN_BYTES = 8_192;
const MAX_HEALTH_RESPONSE_BYTES = 8_192;
const MAX_WEB_RESPONSE_BYTES = 1_048_576;
const MAX_FETCH_RESPONSE_MS = 10_000;
const CHILD_KILL_GRACE_MS = 5_000;
const MAX_PACKED_SMOKE_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_PACKED_SMOKE_TARBALL_PATH_BYTES = 4_096;
const TARBALL_COPY_CHUNK_BYTES = 64 * 1024;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const logTextDecoder = new TextDecoder("utf-8", { fatal: false });

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Packed smoke failed:");
    console.error(`- ${packedSmokeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const packageJson = parseJsonEvidence(await readText(path.join(root, "package.json"), MAX_PROJECT_PACKAGE_JSON_BYTES), "package.json");
  const packageName = requiredPackageName(packageJson.name);
  const packageVersion = requiredPackageVersion(packageJson.version);
  const expectedTarballName = expectedPackedTarballName(packageName, packageVersion);
  const packageManager = requiredPackageManager(packageJson.packageManager);
  const protocolVersion = requiredProtocolVersion(parseJsonEvidence(await readText(path.join(root, "conformance", "protocol-v5.json"), MAX_CONFORMANCE_JSON_BYTES), "conformance/protocol-v5.json").protocolVersion);
  const providedTarball = optionalProvidedTarball();
  const keepTemp = optionalEnvString("KEEP_PACKED_SMOKE_TMP") === "true";
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-packed-smoke-"));
  const packDir = path.join(tmp, "pack");
  const consumerDir = path.join(tmp, "consumer");
  const privateHome = path.join(tmp, "home");
  const childEnv = isolatedChildEnv(privateHome);

  try {
    await mkdir(packDir);
    await mkdir(consumerDir);
    await mkdir(privateHome, { mode: 0o700 });
    await mkdir(childEnv.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
    await mkdir(childEnv.PNPM_HOME, { recursive: true, mode: 0o700 });
    await mkdir(childEnv.COREPACK_HOME, { recursive: true, mode: 0o700 });
    await mkdir(childEnv.LOCALAPPDATA, { recursive: true, mode: 0o700 });
    await mkdir(childEnv.APPDATA, { recursive: true, mode: 0o700 });
    const tarball = providedTarball ?? (await packCurrentProject(packDir, childEnv, expectedTarballName));
    const installTarball = await stageVerifiedTarball(tarball, packDir);

    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ private: true, type: "module", packageManager }, null, 2)
    );
    await writeFile(
      path.join(consumerDir, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - .",
        "strictDepBuilds: true",
        "onlyBuiltDependencies:",
        "  - '@roamhq/wrtc'",
        "  - esbuild",
        ""
      ].join("\n")
    );

    await run(pnpm, ["add", installTarball], { cwd: consumerDir, timeoutMs: 180_000, env: childEnv });
    const version = await run(pnpm, ["exec", "ff", "--version"], { cwd: consumerDir, timeoutMs: 30_000, env: childEnv });
    const expectedVersion = `${packageVersion} protocol ${protocolVersion}`;
    if (version.stdout.trimEnd() !== expectedVersion || version.stderr.length > 0) {
      throw new Error(`Packed ff --version did not report exactly "${expectedVersion}": ${version.stdout}${version.stderr}`);
    }

    const port = await reserveLoopbackPort();
    const server = spawn(pnpm, ["exec", "ff-server"], {
      cwd: consumerDir,
      env: {
        ...childEnv,
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        SIGNALING_TOPOLOGY: "single-instance",
        ALLOW_INSECURE_ORIGINS: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitForOutput(server, /listening/, 20_000);
      const { response, text } = await fetchBoundedResponseText(`http://127.0.0.1:${port}/healthz`, MAX_HEALTH_RESPONSE_BYTES);
      if (!response.ok) throw new Error(`Packed ff-server health check failed with HTTP ${response.status}.`);
      const body = parseJsonEvidence(text, "packed ff-server health response");
      if (!isPlainRecord(body) || ownDataValue(body, "ok") !== true) throw new Error("Packed ff-server health body is invalid.");
      const { response: web, text: html } = await fetchBoundedResponseText(`http://127.0.0.1:${port}/`, MAX_WEB_RESPONSE_BYTES);
      if (!web.ok) throw new Error(`Packed ff-server web UI check failed with HTTP ${web.status}.`);
      if (!html.includes("ff transfer")) throw new Error("Packed ff-server did not serve the bundled web UI.");
      await smokeInstalledTransfer(consumerDir, childEnv, port, tmp);
    } finally {
      server.kill("SIGTERM");
      await waitForExit(server, 5_000).catch(() => server.kill("SIGKILL"));
    }
  } finally {
    if (!keepTemp) await rm(tmp, { recursive: true, force: true });
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

function packedSmokeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > MAX_CHILD_OUTPUT_CHARS || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "Packed smoke failed with an internal error.";
  }
  if (containsPathLikeText(error.message)) {
    return "Packed smoke failed with path-sensitive evidence.";
  }
  return error.message;
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

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? safeChildEnv(), stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const commandLabel = renderCommandForLog(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${commandLabel} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    if (options.stdin !== undefined) {
      try {
        child.stdin.end(checkedChildStdin(options.stdin));
      } catch (error) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        rejectOnce(error, true);
      }
    }
    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("exit", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      if (code === 0) resolveOnce({ stdout, stderr });
      else rejectOnce(new Error(`${commandLabel} failed with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function rejectOnce(error, keepKillTimer = false) {
      if (settled) return;
      settled = true;
      cleanup(keepKillTimer);
      reject(error);
    }
    function cleanup(keepKillTimer = false) {
      clearTimeout(timer);
      if (!keepKillTimer && killTimer) clearTimeout(killTimer);
    }
  });
}

async function smokeInstalledTransfer(consumerDir, childEnv, port, tmp) {
  const source = path.join(tmp, "transfer-source.txt");
  const out = path.join(tmp, "received");
  const expected = Buffer.from("packed installed cli transfer\n", "utf8");
  await mkdir(out);
  await writeFile(source, expected);
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345678-apple-anchor";
  const receiver = spawn(pnpm, ["exec", "ff", "--server", serverUrl, "--json", "--local-private-mode", "recv", "--code-stdin", "--yes", "--out-env", "FF_RECEIVE_OUT"], {
    cwd: consumerDir,
    env: { ...childEnv, FF_RECEIVE_OUT: out },
    stdio: ["pipe", "pipe", "pipe"]
  });
  receiver.stdin.end(checkedChildStdin(`${code}\n`));
  const receiverOutput = captureChildOutput(receiver);
  try {
    await waitForOutput(receiver, /"registered"/, 30_000);
    const sender = await run(pnpm, ["exec", "ff", "--server", serverUrl, "--json", "--local-private-mode", "send", "--code-stdin", "--files-stdin"], {
      cwd: consumerDir,
      timeoutMs: 90_000,
      env: childEnv,
      stdin: `${code}\n${source}\n`
    });
    const receiverResult = await waitForExitWithOutput(receiver, 90_000, receiverOutput);
    if (sender.stderr.length > 0 || !sender.stdout.includes('"sent"')) throw new Error("Packed installed ff send did not complete a transfer.");
    if (receiverResult.code !== 0 || receiverResult.stderr.length > 0 || !receiverResult.stdout.includes('"received"')) throw new Error("Packed installed ff recv did not complete a transfer.");
    const receivedNames = await readdir(out);
    if (receivedNames.length !== 1 || !/^ff-[a-f0-9]{32}$/.test(receivedNames[0])) throw new Error("Packed installed ff recv did not use an opaque output name.");
    const actual = await readFile(path.join(out, receivedNames[0]));
    if (!Buffer.from(actual).equals(expected)) throw new Error("Packed installed CLI transfer changed file bytes.");
  } finally {
    if (receiver.exitCode === null) {
      receiver.kill("SIGTERM");
      await waitForExit(receiver, 5_000).catch(() => receiver.kill("SIGKILL"));
    }
  }
}

export function checkedChildStdin(value) {
  if (typeof value !== "string" || value.length < 1 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) || utf8ByteLengthExceeds(value, MAX_CHILD_STDIN_BYTES)) {
    throw new Error(`Packed smoke child stdin must be a non-empty control-free value under ${MAX_CHILD_STDIN_BYTES} UTF-8 bytes.`);
  }
  return value;
}

export function safeChildEnv() {
  const allowed = [
    ["PATH", true],
    ["HOME", false],
    ["USERPROFILE", false],
    ["TMPDIR", false],
    ["TMP", false],
    ["TEMP", false],
    ["SystemRoot", false],
    ["SYSTEMROOT", false],
    ["COMSPEC", false],
    ["PATHEXT", false],
    ["PNPM_HOME", false],
    ["COREPACK_HOME", false],
    ["LOCALAPPDATA", false],
    ["APPDATA", false]
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
  return env;
}

export function optionalEnvString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === "") return undefined;
  if (!isSafeChildEnvValue(descriptor.value)) {
    throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

export function isolatedChildEnv(privateHome) {
  if (typeof privateHome !== "string" || privateHome.length < 1 || hasUnsafePathText(privateHome) || utf8ByteLengthExceeds(privateHome, MAX_PACKED_SMOKE_TARBALL_PATH_BYTES)) {
    throw new Error(`Packed smoke private home must be a non-empty control-free path under ${MAX_PACKED_SMOKE_TARBALL_PATH_BYTES} UTF-8 bytes.`);
  }
  const home = path.resolve(privateHome);
  const env = safeChildEnv();
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    PNPM_HOME: path.join(home, "pnpm-home"),
    COREPACK_HOME: path.join(home, "corepack-home"),
    LOCALAPPDATA: path.join(home, "local-app-data"),
    APPDATA: path.join(home, "app-data")
  };
}

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function utf8ByteLengthExceeds(value, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid packed smoke byte limit.");
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

function requiredPackageManager(value) {
  if (typeof value !== "string" || !/^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]+$/.test(value)) {
    throw new Error("package.json packageManager must be an exact hash-pinned pnpm version.");
  }
  return value;
}

function requiredPackageName(value) {
  if (typeof value !== "string" || !/^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/.test(value) || value.length > 214) {
    throw new Error("package.json name must be an exact npm package name.");
  }
  return value;
}

function requiredPackageVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("package.json version must be an exact semver release.");
  }
  return value;
}

export function expectedPackedTarballName(packageName, packageVersion) {
  const name = requiredPackageName(packageName);
  const version = requiredPackageVersion(packageVersion);
  return `${name.startsWith("@") ? name.slice(1).replace("/", "-") : name}-${version}.tgz`;
}

function requiredProtocolVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) {
    throw new Error("conformance protocolVersion must be a small positive integer.");
  }
  return value;
}

export function parseJsonEvidence(text, label) {
  if (typeof text !== "string" || typeof label !== "string" || !/^[A-Za-z0-9 ._/-]{1,80}$/.test(label)) {
    throw new Error("Packed smoke JSON evidence is invalid.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function ownDataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
  return descriptor.value;
}

export function appendBoundedOutput(current, chunk) {
  if (typeof current !== "string") throw new Error("Packed smoke captured output buffer is invalid.");
  const next = current + sanitizeChildOutputChunk(chunk);
  if (next.length <= MAX_CHILD_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CHILD_OUTPUT_CHARS);
}

export function renderCommandForLog(command, args) {
  return commandParts(command, args).map(sanitizeLogText).join(" ");
}

function sanitizeChildOutputChunk(chunk) {
  if (!Buffer.isBuffer(chunk)) throw new Error("Packed smoke child output chunk is invalid.");
  return sanitizeLogText(logTextDecoder.decode(chunk));
}

function commandParts(command, args) {
  if (typeof command !== "string" || !Array.isArray(args)) throw new Error("Packed smoke command label is invalid.");
  const out = [command];
  for (let index = 0; index < args.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(args, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") {
      throw new Error("Packed smoke command label is invalid.");
    }
    out.push(descriptor.value);
  }
  return out;
}

function sanitizeLogText(value) {
  return redactPathLikeText(value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : "")));
}

function redactPathLikeText(value) {
  return value.replace(/(^|[\s("'=])(?:\/[^\s"'()]+|[A-Za-z]:[\\/][^\s"'()]+)/g, "$1[path]");
}

async function packCurrentProject(destination, env, expectedTarballName) {
  await run(pnpm, ["--config.ignore-scripts=true", "pack", "--pack-destination", destination], { cwd: root, timeoutMs: 120_000, env });
  const entries = await readdir(destination, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== expectedTarballName) {
    throw new Error("Packed smoke pack output must contain exactly the expected tarball.");
  }
  return path.join(destination, expectedTarballName);
}

export function optionalProvidedTarball() {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, "PACKED_SMOKE_TARBALL");
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) return undefined;
  const value = descriptor.value;
  if (typeof value !== "string" || value.length < 1 || hasUnsafePathText(value) || utf8ByteLengthExceeds(value, MAX_PACKED_SMOKE_TARBALL_PATH_BYTES)) {
    throw new Error(`PACKED_SMOKE_TARBALL must be a non-empty control-free path under ${MAX_PACKED_SMOKE_TARBALL_PATH_BYTES} UTF-8 bytes.`);
  }
  const resolved = path.resolve(root, value);
  if (!resolved.endsWith(".tgz")) throw new Error("PACKED_SMOKE_TARBALL must point to a .tgz package.");
  return resolved;
}

export async function stageVerifiedTarball(tarball, destination) {
  if (typeof tarball !== "string") throw new Error("Packed smoke tarball path is invalid.");
  const basename = path.basename(tarball);
  if (!/^[A-Za-z0-9._-]+\.tgz$/.test(basename)) throw new Error("Packed smoke tarball filename is invalid.");
  let info;
  try {
    info = await lstat(tarball);
  } catch {
    throw new Error("Packed smoke tarball could not be opened for verification.");
  }
  if (!info.isFile()) throw new Error("Packed smoke tarball is not a regular file.");
  if (info.size < 1 || info.size > MAX_PACKED_SMOKE_TARBALL_BYTES) throw new Error(`Packed smoke tarball size is outside the allowed range: ${info.size}`);
  let source;
  try {
    source = await open(tarball, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Packed smoke tarball could not be opened for verification.");
  }
  const staged = path.join(destination, `verified-${basename}`);
  let target;
  try {
    const opened = await source.stat();
    if (!opened.isFile()) throw new Error("Packed smoke tarball is not a regular file.");
    if (opened.size < 1 || opened.size > MAX_PACKED_SMOKE_TARBALL_BYTES) throw new Error(`Packed smoke tarball size is outside the allowed range: ${opened.size}`);
    if (!sameFile(info, opened)) throw new Error("Packed smoke tarball changed before verification.");
    target = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await copyVerifiedHandle(source, target, opened.size);
    const copied = await target.stat();
    if (!copied.isFile() || copied.size !== opened.size) throw new Error("Packed smoke tarball changed while being staged.");
    return staged;
  } finally {
    await target?.close();
    await source.close();
  }
}

function hasUnsafePathText(value) {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

async function copyVerifiedHandle(source, target, size) {
  const buffer = Buffer.alloc(TARBALL_COPY_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const { bytesRead } = await source.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    await writeFull(target, buffer.subarray(0, bytesRead), offset);
    offset += bytesRead;
    if (offset > size) throw new Error("Packed smoke tarball read exceeded the verified size.");
  }
  if (offset !== size) throw new Error("Packed smoke tarball changed while being staged.");
  const opened = await source.stat();
  if (opened.size !== size) throw new Error("Packed smoke tarball changed while being staged.");
}

async function writeFull(handle, data, position) {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, position + offset);
    if (bytesWritten === 0) throw new Error("Packed smoke tarball staging write made no progress.");
    offset += bytesWritten;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`Timed out waiting for ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
      if (pattern.test(stdout)) done();
    };
    const onStderr = (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
      if (pattern.test(stderr)) done();
    };
    const onExit = (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      rejectOnce(new Error(`Process exited before ${pattern}: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const done = () => {
      resolveOnce();
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOnce = (error, keepKillTimer = false) => {
      if (settled) return;
      settled = true;
      cleanup(keepKillTimer);
      reject(error);
    };
    const cleanup = (keepKillTimer = false) => {
      clearTimeout(timer);
      if (!keepKillTimer && killTimer) clearTimeout(killTimer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function captureChildOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout = appendBoundedOutput(output.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = appendBoundedOutput(output.stderr, chunk);
  });
  return output;
}

function waitForExitWithOutput(child, timeoutMs, output) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, stdout: output.stdout, stderr: output.stderr });
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error("Timed out waiting for packed transfer command.");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, timeoutMs);
    const onExit = (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      resolveOnce({ code, stdout: output.stdout, stderr: output.stderr });
    };
    const onError = (error) => {
      rejectOnce(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function readBoundedResponseText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid packed smoke response byte limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Packed smoke response body yielded a non-binary chunk.");
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Packed smoke response exceeded the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve the original smoke failure; lock release is best-effort cleanup.
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
    throw new Error("Packed smoke response is not valid UTF-8.");
  }
}

async function fetchBoundedResponseText(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_FETCH_RESPONSE_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await readBoundedResponseText(response, maxBytes);
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Packed smoke HTTP probe timed out after ${MAX_FETCH_RESPONSE_MS}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function containsPathLikeText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    const fail = (error) => {
      probe.close(() => reject(error));
    };
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", fail);
      const address = probe.address();
      if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
        probe.close(() => reject(new Error("Could not reserve a loopback port for packed smoke.")));
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
