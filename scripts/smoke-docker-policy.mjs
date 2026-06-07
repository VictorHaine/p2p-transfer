#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMAGE_TAG = "p2p-transfer:docker-policy";
const IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 600_000;
const PROBE_ATTEMPTS = 10;
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

  run("docker", ["build", "-t", imageTag, "."], "docker image build", BUILD_TIMEOUT_MS);
  expectDockerFailure(
    ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", "SIGNALING_TOPOLOGY=single-instance", imageTag],
    "container without ALLOWED_ORIGINS",
    "ALLOWED_ORIGINS"
  );
  expectDockerFailure(
    ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", `ALLOWED_ORIGINS=${PRODUCTION_ORIGIN}`, imageTag],
    "container without SIGNALING_TOPOLOGY",
    "SIGNALING_TOPOLOGY"
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
      COMMAND_TIMEOUT_MS
    );
    const port = publishedPort(containerName);
    await waitForProbe(`http://127.0.0.1:${port}/healthz`, "200");
    probe(`http://127.0.0.1:${port}/`, "200", { contains: "ff transfer", maxBytes: "1048576" });
    probe(`http://127.0.0.1:${port}/v1/ice`, "403", { origin: BAD_ORIGIN });
  } finally {
    run("docker", ["rm", "-f", containerName], "container cleanup", COMMAND_TIMEOUT_MS, { allowFailure: true });
  }
}

function imageTagFromEnv(value) {
  if (value === undefined || value === "") return DEFAULT_IMAGE_TAG;
  if (typeof value !== "string" || !IMAGE_TAG_RE.test(value)) throw new Error("DOCKER_SMOKE_TAG must be a bounded docker image tag.");
  return value;
}

function assertContainerName(value) {
  if (!CONTAINER_NAME_RE.test(value)) throw new Error("generated docker container name is invalid.");
}

function expectDockerFailure(args, label, requiredEvidence) {
  const result = run("docker", args, label, COMMAND_TIMEOUT_MS, { allowFailure: true });
  if (result.status === 0) throw new Error(`${label} unexpectedly started.`);
  if (!combinedOutput(result).includes(requiredEvidence)) throw new Error(`${label} did not fail with the expected production policy evidence.`);
}

function publishedPort(containerName) {
  const result = run("docker", ["port", containerName, "8787/tcp"], "container port lookup", COMMAND_TIMEOUT_MS);
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
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: verboseEnabled() && !options.allowFailure ? "inherit" : "pipe",
    timeout
  });
  if (result.error && result.error.name === "TimeoutError") throw new Error(`${label} timed out.`);
  if (!options.allowFailure && result.status !== 0) throw new Error(`${label} failed. Set ${VERBOSE_ENV}=1 to print command output.`);
  return result;
}

function verboseEnabled() {
  return process.env[VERBOSE_ENV] === "1";
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
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

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
