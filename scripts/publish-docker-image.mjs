#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, readFile, rm } from "node:fs/promises";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeChildEnv } from "./smoke-packed.mjs";
import { assertLiveReleaseRefFromEnv } from "./verify-live-release-ref.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "ghcr.io";
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 300_000;
const SMOKE_TIMEOUT_MS = 420_000;
const CHILD_KILL_GRACE_MS = 5_000;

try {
  await main();
} catch (error) {
  console.error("Docker image publish failed:");
  console.error(`- ${publishErrorMessage(error)}`);
  process.exitCode = 1;
}

async function main() {
  const packageJson = await readPackageJson();
  const version = packageVersion(packageJson.version);
  const tag = releaseTag(requiredEnvString("GITHUB_REF_NAME"));
  if (tag !== `v${version}`) throw new Error("release tag does not match package version.");

  const repository = githubRepository(requiredEnvString("GITHUB_REPOSITORY"));
  requiredCommitSha(requiredEnvString("GITHUB_SHA"));
  await assertLiveReleaseRefFromEnv();
  const actor = githubActor(requiredEnvString("GITHUB_ACTOR"));
  const token = requiredEnvString("GITHUB_TOKEN", MAX_TOKEN_BYTES);
  const image = `${REGISTRY}/${repository.toLowerCase()}`;
  const versionRef = `${image}:${tag}`;
  const plainVersionRef = `${image}:${version}`;
  const dockerConfigDir = createIsolatedDockerConfig();
  const dockerEnv = { DOCKER_CONFIG: dockerConfigDir };

  try {
    await run(process.execPath, ["scripts/smoke-docker-policy.mjs"], "release docker policy smoke", SMOKE_TIMEOUT_MS, {
      env: { DOCKER_SMOKE_TAG: versionRef }
    });
    await run("docker", ["tag", versionRef, plainVersionRef], "docker release tag alias", COMMAND_TIMEOUT_MS, { env: dockerEnv });
    await run("docker", ["login", REGISTRY, "-u", actor, "--password-stdin"], "docker registry login", COMMAND_TIMEOUT_MS, {
      env: dockerEnv,
      input: `${token}\n`
    });
    const pushed = await run("docker", ["push", versionRef], "docker release image push", PUSH_TIMEOUT_MS, { env: dockerEnv });
    const digest = pushedDigest(`${pushed.stdout}\n${pushed.stderr}`);
    const aliasPushed = await run("docker", ["push", plainVersionRef], "docker release image alias push", PUSH_TIMEOUT_MS, { env: dockerEnv });
    const aliasDigest = pushedDigest(`${aliasPushed.stdout}\n${aliasPushed.stderr}`);
    if (aliasDigest !== digest) throw new Error("docker release tag aliases resolved to different digests.");
    await writeGithubOutput({ image, digest, tag: versionRef, alias: plainVersionRef });
    console.log(`Published ${image}@${digest}`);
  } finally {
    await rm(dockerConfigDir, { recursive: true, force: true });
  }
}

async function readPackageJson() {
  const file = path.join(root, "package.json");
  const bytes = await readFile(file);
  if (bytes.length > MAX_PACKAGE_JSON_BYTES) throw new Error("package metadata is too large.");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("package metadata is not valid UTF-8.");
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error("package metadata is not valid JSON.");
  }
}

function packageVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)) throw new Error("package version is not an exact release semver.");
  return value;
}

function releaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)) throw new Error("release tag is not an exact release tag.");
  return value;
}

function githubRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error("GitHub repository is invalid.");
  return value;
}

function requiredCommitSha(value) {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("GitHub commit SHA is invalid.");
  return value;
}

function githubActor(value) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)) throw new Error("GitHub actor is invalid.");
  return value;
}

function pushedDigest(output) {
  const matches = [...output.matchAll(/\bdigest:\s+(sha256:[a-f0-9]{64})\b/gu)].map((match) => match[1]);
  if (matches.length !== 1) throw new Error("docker push did not emit exactly one image digest.");
  return matches[0];
}

function createIsolatedDockerConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "p2p-transfer-docker-release-"));
  chmodSync(dir, 0o700);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ auths: {} }), { mode: 0o600 });
  return dir;
}

async function writeGithubOutput(values) {
  const file = optionalEnvString("GITHUB_OUTPUT");
  if (file === undefined) return;
  if (!path.isAbsolute(file)) throw new Error("GitHub output path is invalid.");
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join("");
  await appendFile(file, lines, { encoding: "utf8" });
}

function requiredEnvString(name, maxBytes = MAX_ENV_VALUE_BYTES) {
  const value = optionalEnvString(name, maxBytes);
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvString(name, maxBytes = MAX_ENV_VALUE_BYTES) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || typeof descriptor.value === "undefined") return undefined;
  if (typeof descriptor.value !== "string") throw new Error(`${name} must be a string.`);
  const value = descriptor.value;
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must be a bounded control-free environment value.`);
  }
  return value;
}

function run(command, args, label, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...safeChildEnv(), ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutError;
    let killTimer;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${label} timed out.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.on("error", rejectOnce);
    child.on("exit", (code, signal) => {
      if (timeoutError) {
        rejectOnce(timeoutError);
      } else if (code === 0) {
        resolveOnce({ stdout, stderr });
      } else {
        rejectOnce(new Error(`${label} failed with ${childExitStatus(code, signal)}.`));
      }
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();

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

function childExitStatus(code, signal) {
  return signal ? `signal ${signal}` : `exit code ${code}`;
}

function appendBoundedOutput(current, chunk) {
  if (!Buffer.isBuffer(chunk)) throw new Error("docker publish output capture failed.");
  const next = current + chunk.toString("utf8").replace(/[\p{Cc}\p{Cf}]/gu, "");
  return next.length <= MAX_OUTPUT_BYTES ? next : next.slice(next.length - MAX_OUTPUT_BYTES);
}

function publishErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > MAX_OUTPUT_BYTES) {
    return "docker image publish failed with an internal error.";
  }
  if (/(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(error.message)) return "docker image publish failed with path-sensitive evidence.";
  return error.message;
}
