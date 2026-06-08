#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, open, rm } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIsolatedDockerConfig } from "./docker-config.mjs";
import { safeChildEnv } from "./smoke-packed.mjs";
import { assertLiveReleaseRefFromEnv } from "./verify-live-release-ref.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "ghcr.io";
const EXPECTED_GITHUB_REPOSITORY = "VictorHaine/p2p-transfer";
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_GITHUB_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 300_000;
const SMOKE_TIMEOUT_MS = 420_000;
const CHILD_KILL_GRACE_MS = 5_000;

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Docker image publish failed:");
    console.error(`- ${publishErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const mode = dockerPublishMode(process.argv.slice(2));
  const tag = releaseTag(requiredEnvString("GITHUB_REF_NAME"));
  assertReleaseTagRef(tag);
  const repository = githubRepository(requiredEnvString("GITHUB_REPOSITORY"));
  const runId = requiredGitHubActionsContext();
  const revision = requiredCommitSha(requiredEnvString("GITHUB_SHA"));
  const actor = githubActor(requiredEnvString("GITHUB_ACTOR"));
  const token = requiredEnvString("GITHUB_TOKEN", MAX_TOKEN_BYTES);
  const packageJson = await readPackageJson();
  const version = packageVersion(packageJson.version);
  if (tag !== `v${version}`) throw new Error("release tag does not match package version.");

  await assertLiveReleaseRefFromEnv();
  const image = `${REGISTRY}/${repository.toLowerCase()}`;
  const versionRef = `${image}:${tag}`;
  const plainVersionRef = `${image}:${version}`;
  const stagedRef = `${image}:attest-${version}-${runId}`;
  const dockerConfigDir = createIsolatedDockerConfig("p2p-transfer-docker-release-");
  const dockerEnv = { DOCKER_CONFIG: dockerConfigDir };

  try {
    if (mode === "promote") {
      await assertLiveReleaseRefFromEnv();
      const digest = dockerDigest(requiredEnvString("DOCKER_STAGED_DIGEST"));
      await run("docker", ["login", REGISTRY, "-u", actor, "--password-stdin"], "docker registry login", COMMAND_TIMEOUT_MS, {
        env: dockerEnv,
        input: `${token}\n`
      });
      await run("docker", ["pull", `${image}@${digest}`], "docker attested image pull", PUSH_TIMEOUT_MS, { env: dockerEnv });
      await publishDockerReleaseTag({ image, digest, ref: versionRef, label: "docker release image", dockerEnv });
      await publishDockerReleaseTag({ image, digest, ref: plainVersionRef, label: "docker release image alias", dockerEnv });
      await assertAnonymousDockerPull({ ref: versionRef, digest });
      await assertAnonymousDockerPull({ ref: plainVersionRef, digest });
      await writeGithubOutput({ image, digest, tag: versionRef, alias: plainVersionRef });
      console.log(`Promoted ${image}@${digest}`);
      return;
    }

    await run(process.execPath, ["scripts/smoke-docker-policy.mjs"], "release docker policy smoke", SMOKE_TIMEOUT_MS, {
      env: { DOCKER_SMOKE_TAG: stagedRef, DOCKER_SMOKE_VERSION: version, DOCKER_SMOKE_REVISION: revision }
    });
    await assertLiveReleaseRefFromEnv();
    await run("docker", ["login", REGISTRY, "-u", actor, "--password-stdin"], "docker registry login", COMMAND_TIMEOUT_MS, {
      env: dockerEnv,
      input: `${token}\n`
    });
    const pushed = await run("docker", ["push", stagedRef], "docker staged image push", PUSH_TIMEOUT_MS, { env: dockerEnv });
    const digest = pushedDigest(`${pushed.stdout}\n${pushed.stderr}`);
    await writeGithubOutput({ image, digest, stage: stagedRef, tag: versionRef, alias: plainVersionRef });
    console.log(`Staged ${image}@${digest}`);
  } finally {
    await rm(dockerConfigDir, { recursive: true, force: true });
  }
}

function dockerPublishMode(args) {
  if (args.length === 0) return "stage";
  if (args.length === 1 && args[0] === "--promote") return "promote";
  throw new Error("Usage: node scripts/publish-docker-image.mjs [--promote]");
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

async function readPackageJson() {
  const file = path.join(root, "package.json");
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("package metadata must be a regular file.");
  if (info.size < 1 || info.size > MAX_PACKAGE_JSON_BYTES) throw new Error("package metadata is too large.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("package metadata must be a regular file.");
    if (opened.size < 1 || opened.size > MAX_PACKAGE_JSON_BYTES) throw new Error("package metadata is too large.");
    if (!sameFile(info, opened)) throw new Error("package metadata changed before verification.");
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("package metadata changed while being read.");
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead)) throw new Error("package metadata changed while being read.");
  } finally {
    await handle.close();
  }
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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function packageVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)) throw new Error("package version is not an exact release semver.");
  return value;
}

function releaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)) throw new Error("release tag is not an exact release tag.");
  return value;
}

function assertReleaseTagRef(tag) {
  if (requiredEnvString("GITHUB_REF_TYPE") !== "tag" || requiredEnvString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

function githubRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error("GitHub repository is invalid.");
  if (value !== EXPECTED_GITHUB_REPOSITORY) throw new Error("GitHub repository must match the release repository.");
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

function requiredGitHubActionsContext() {
  if (requiredEnvString("GITHUB_ACTIONS") !== "true") throw new Error("GITHUB_ACTIONS must be true for Docker publishing.");
  const runId = requiredEnvString("GITHUB_RUN_ID");
  if (!/^[1-9]\d{0,19}$/u.test(runId)) throw new Error("GITHUB_RUN_ID must be a positive decimal GitHub Actions run id.");
  return runId;
}

function dockerDigest(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("staged Docker digest is invalid.");
  return value;
}

function pushedDigest(output) {
  const matches = [...output.matchAll(/\bdigest:\s+(sha256:[a-f0-9]{64})\b/gu)].map((match) => match[1]);
  if (matches.length !== 1) throw new Error("docker push did not emit exactly one image digest.");
  return matches[0];
}

async function publishDockerReleaseTag({ image, digest, ref, label, dockerEnv }) {
  const existingDigest = await existingDockerTagDigest(ref, dockerEnv);
  if (existingDigest !== undefined) {
    if (existingDigest !== digest) throw new Error(`${label} already points to a different digest.`);
    return;
  }
  await run("docker", ["tag", `${image}@${digest}`, ref], `${label} tag`, COMMAND_TIMEOUT_MS, { env: dockerEnv });
  const pushed = await run("docker", ["push", ref], `${label} push`, PUSH_TIMEOUT_MS, { env: dockerEnv });
  const pushedDigestValue = pushedDigest(`${pushed.stdout}\n${pushed.stderr}`);
  if (pushedDigestValue !== digest) throw new Error(`${label} resolved to a different digest.`);
}

async function assertAnonymousDockerPull({ ref, digest }) {
  const anonymousDockerConfigDir = createIsolatedDockerConfig("p2p-transfer-docker-anonymous-");
  try {
    const pulled = await run("docker", ["pull", ref], "anonymous docker release pull", PUSH_TIMEOUT_MS, {
      env: { DOCKER_CONFIG: anonymousDockerConfigDir }
    });
    if (pulledDigest(`${pulled.stdout}\n${pulled.stderr}`) !== digest) {
      throw new Error("anonymous docker release pull resolved to a different digest.");
    }
  } finally {
    await rm(anonymousDockerConfigDir, { recursive: true, force: true });
  }
}

async function existingDockerTagDigest(ref, dockerEnv) {
  const pulled = await runAllowFailure("docker", ["pull", ref], "docker release tag lookup", PUSH_TIMEOUT_MS, { env: dockerEnv });
  const output = `${pulled.stdout}\n${pulled.stderr}`;
  if (pulled.status === 0) return pulledDigest(output);
  if (dockerTagMissing(output)) return undefined;
  throw new Error("docker release tag lookup failed.");
}

function pulledDigest(output) {
  const matches = [...output.matchAll(/\bDigest:\s+(sha256:[a-f0-9]{64})\b/gu)].map((match) => match[1]);
  if (matches.length !== 1) throw new Error("docker pull did not emit exactly one image digest.");
  return matches[0];
}

function dockerTagMissing(output) {
  return /\bmanifest unknown\b/iu.test(output);
}

async function writeGithubOutput(values) {
  const file = optionalEnvString("GITHUB_OUTPUT");
  if (file === undefined) return;
  if (!path.isAbsolute(file)) throw new Error("GitHub output path is invalid.");
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join("");
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("GitHub output path is invalid.");
  if (info.size > MAX_GITHUB_OUTPUT_BYTES) throw new Error("GitHub output file is too large.");
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(info, opened)) throw new Error("GitHub output path is invalid.");
    if (opened.size > MAX_GITHUB_OUTPUT_BYTES) throw new Error("GitHub output file is too large.");
    await handle.writeFile(lines, "utf8");
  } finally {
    await handle.close();
  }
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
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
      } else if (code === 0) {
        resolveOnce({ stdout, stderr });
      } else {
        rejectOnce(new Error(`${label} failed with ${childExitStatus(code, signal)}.`));
      }
    });
    try {
      endChildStdin(child, options.input ?? "", label, (error) => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        rejectOnce(error, true);
      });
    } catch (error) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
      rejectOnce(error, true);
    }

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

function runAllowFailure(command, args, label, timeoutMs, options = {}) {
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
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
      } else {
        resolveOnce({ status: typeof code === "number" ? code : undefined, signal, stdout, stderr });
      }
    });
    try {
      endChildStdin(child, options.input ?? "", label, (error) => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        rejectOnce(error, true);
      });
    } catch (error) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
      rejectOnce(error, true);
    }

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

function endChildStdin(child, input, label, onFailure) {
  const stdin = checkedChildStdin(input);
  let closed = false;
  const onError = () => {
    if (closed) return;
    closed = true;
    cleanup();
    onFailure(new Error(`${label} stdin pipe failed.`));
  };
  const onFinish = () => {
    if (closed) return;
    closed = true;
    cleanup();
  };
  const cleanup = () => {
    child.stdin.off("error", onError);
    child.stdin.off("finish", onFinish);
  };
  child.stdin.once("error", onError);
  child.stdin.once("finish", onFinish);
  try {
    child.stdin.end(stdin);
  } catch {
    cleanup();
    throw new Error(`${label} stdin pipe failed.`);
  }
}

function checkedChildStdin(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES + 1 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
    throw new Error("docker publish child stdin is invalid.");
  }
  return value;
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
