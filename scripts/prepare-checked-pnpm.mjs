#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_PNPM_COREPACK_HASH = "sha512.c85357fe17ca12dd23dd7071822666dfd7e3cb76fe214e3370b5ea2fb34f2a231185509b63e717f3cd0acb38dd3f8d82bcd5e8172400ae678b70ea4fbed0896d";
const MAX_OUTPUT_CHARS = 200_000;
const CHILD_KILL_GRACE_MS = 5_000;

try {
  await main();
} catch (error) {
  console.error("Checked pnpm preparation failed:");
  console.error(`- ${safeErrorMessage(error)}`);
  process.exitCode = 1;
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = checkedPnpmVersion(packageJson.packageManager);
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-checked-pnpm-"));
  const archive = path.join(tmp, "corepack-pnpm.tgz");
  try {
    await run("corepack", ["pack", `pnpm@${version}`, "-o", archive], { cwd: root, timeoutMs: 120_000 });
    const metadataText = await run("tar", ["-xOzf", archive, `pnpm/${version}/.corepack`], { cwd: root, timeoutMs: 30_000 });
    assertCorepackMetadata(metadataText.stdout, version);
    await run("corepack", ["enable"], { cwd: root, timeoutMs: 30_000 });
    await run("corepack", ["install", "-g", "--cache-only", archive], { cwd: root, timeoutMs: 60_000 });
    const prepared = await run("corepack", ["pnpm", "--version"], { cwd: root, timeoutMs: 30_000 });
    if (prepared.stdout.trim() !== version) throw new Error("Prepared pnpm version did not match the checked package manager pin.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
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

function safeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > MAX_OUTPUT_CHARS) {
    return "checked pnpm preparation failed with an internal error.";
  }
  if (/(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(error.message)) {
    return "checked pnpm preparation failed with path-sensitive evidence.";
  }
  return error.message;
}
