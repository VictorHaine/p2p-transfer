#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMAGE_TAG = "p2p-transfer:docker-policy";
const IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 600_000;
const PROBE_ATTEMPTS = 10;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const PRODUCTION_ORIGIN = "https://files.example.com";
const BAD_ORIGIN = "https://evil.example";
const VERBOSE_ENV = "DOCKER_SMOKE_VERBOSE";

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Docker policy smoke failed:");
    console.error(`- ${smokeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const imageTag = imageTagFromEnv(process.env.DOCKER_SMOKE_TAG);
  const containerName = `p2p-transfer-policy-${Date.now()}-${process.pid}`;
  const dockerConfigDir = createIsolatedDockerConfig();
  const dockerEnv = { DOCKER_CONFIG: dockerConfigDir };

  try {
    run("docker", ["build", "-t", imageTag, "."], "docker image build", BUILD_TIMEOUT_MS, { env: dockerEnv });
    expectDockerFailure(
      ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", "SIGNALING_TOPOLOGY=single-instance", imageTag],
      "container without ALLOWED_ORIGINS",
      "ALLOWED_ORIGINS",
      dockerEnv
    );
    expectDockerFailure(
      ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", `ALLOWED_ORIGINS=${PRODUCTION_ORIGIN}`, imageTag],
      "container without SIGNALING_TOPOLOGY",
      "SIGNALING_TOPOLOGY",
      dockerEnv
    );

    assertContainerName(containerName);
    try {
      run(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt",
          "no-new-privileges",
          "-p",
          "127.0.0.1::8787",
          "-e",
          `ALLOWED_ORIGINS=${PRODUCTION_ORIGIN}`,
          "-e",
          "SIGNALING_TOPOLOGY=single-instance",
          imageTag
        ],
        "hardened container start",
        COMMAND_TIMEOUT_MS,
        { env: dockerEnv }
      );
      const port = publishedPort(containerName, dockerEnv);
      await waitForProbe(`http://127.0.0.1:${port}/healthz`, "200");
      probe(`http://127.0.0.1:${port}/`, "200", { contains: "ff transfer", maxBytes: "1048576" });
      probe(`http://127.0.0.1:${port}/v1/ice`, "403", { origin: BAD_ORIGIN });
    } finally {
      run("docker", ["rm", "-f", containerName], "container cleanup", COMMAND_TIMEOUT_MS, { allowFailure: true, env: dockerEnv });
    }
  } finally {
    rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

function createIsolatedDockerConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "p2p-transfer-docker-"));
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ auths: {} }), { mode: 0o600 });
  return dir;
}

function imageTagFromEnv(value) {
  if (value === undefined || value === "") return DEFAULT_IMAGE_TAG;
  if (typeof value !== "string" || !IMAGE_TAG_RE.test(value)) throw new Error("DOCKER_SMOKE_TAG must be a bounded docker image tag.");
  return value;
}

function assertContainerName(value) {
  if (!CONTAINER_NAME_RE.test(value)) throw new Error("generated docker container name is invalid.");
}

function expectDockerFailure(args, label, requiredEvidence, env) {
  const result = run("docker", args, label, COMMAND_TIMEOUT_MS, { allowFailure: true, env });
  if (result.status === 0) throw new Error(`${label} unexpectedly started.`);
  if (!combinedOutput(result).includes(requiredEvidence)) throw new Error(`${label} did not fail with the expected production policy evidence.`);
}

function publishedPort(containerName, env) {
  const result = run("docker", ["port", containerName, "8787/tcp"], "container port lookup", COMMAND_TIMEOUT_MS, { env });
  const output = `${result.stdout ?? ""}`.trim();
  const match = /^127\.0\.0\.1:(?<port>[1-9][0-9]{0,4})$/u.exec(output);
  const port = match?.groups?.port ? Number(match.groups.port) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("container did not publish a valid loopback port.");
  return port;
}

async function waitForProbe(url, status) {
  let lastError;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      probe(url, status);
      return;
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("container health probe failed.");
}

function probe(url, status, options = {}) {
  const env = { PROBE_URL: url, PROBE_STATUS: status };
  if (options.contains) env.PROBE_CONTAINS = options.contains;
  if (options.maxBytes) env.PROBE_MAX_BYTES = options.maxBytes;
  if (options.origin) env.PROBE_ORIGIN = options.origin;
  run(process.execPath, ["scripts/probe-http.mjs"], "HTTP probe", COMMAND_TIMEOUT_MS, { env });
}

function run(command, args, label, timeout, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...safeChildEnv(), ...(options.env ?? {}) },
    stdio: verboseEnabled() && !options.allowFailure ? "inherit" : "pipe",
    timeout
  });
  if (result.error && result.error.name === "TimeoutError") throw new Error(`${label} timed out.`);
  if (!options.allowFailure && result.status !== 0) throw new Error(`${label} failed. Set ${VERBOSE_ENV}=1 to print command output.`);
  return result;
}

function verboseEnabled() {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, VERBOSE_ENV);
  return Boolean(descriptor && "value" in descriptor && descriptor.value === "1");
}

export function safeChildEnv() {
  const allowed = [
    ["PATH", true],
    ["TMPDIR", false],
    ["TMP", false],
    ["TEMP", false],
    ["SystemRoot", false],
    ["SYSTEMROOT", false],
    ["COMSPEC", false],
    ["PATHEXT", false],
    ["DOCKER_HOST", false],
    ["DOCKER_CONTEXT", false],
    ["DOCKER_BUILDKIT", false],
    ["BUILDKIT_PROGRESS", false],
    [VERBOSE_ENV, false]
  ];
  const env = {};
  for (const [name, required] of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
    if (descriptor && "value" in descriptor && isSafeChildEnvValue(descriptor.value)) {
      env[name] = descriptor.value;
    } else if (required) {
      throw new Error(`${name} must be a non-empty NUL-free child environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
    }
  }
  return env;
}

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function smokeErrorMessage(error) {
  if (
    !(error instanceof Error) ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 4096 ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)
  ) {
    return "docker policy smoke failed with an internal error.";
  }
  return error.message;
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
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
