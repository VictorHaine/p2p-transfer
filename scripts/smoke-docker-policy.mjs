#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIsolatedDockerConfig } from "./docker-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMAGE_TAG = "p2p-transfer:docker-policy";
const IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const COMMAND_TIMEOUT_MS = 120_000;
const DOCKER_PREFLIGHT_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 300_000;
const PROBE_ATTEMPTS = 10;
const MAX_CHILD_ENV_VALUE_BYTES = 8_192;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_DOCKER_FAILURE_EVIDENCE_CHARS = 128 * 1024;
const MAX_EXPECTED_EVIDENCE_CHARS = 512;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const WEBSOCKET_PROBE_TIMEOUT_MS = 10_000;
const MAX_WEBSOCKET_HANDSHAKE_BYTES = 8_192;
const CHILD_KILL_GRACE_MS = 5_000;
const PRODUCTION_ORIGIN = "https://files.example.com";
const BAD_ORIGIN = "https://evil.example";
const VERBOSE_ENV = "DOCKER_SMOKE_VERBOSE";
const HARDENED_DOCKER_RUN_FLAGS = ["--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1"];
const CLI_WEBRTC_RUNTIME_PATHS = [
  "node_modules/@roamhq",
  "node_modules/domexception",
  "node_modules/webidl-conversions",
  "node_modules/.pnpm/@roamhq+wrtc@0.10.0",
  "node_modules/.pnpm/@roamhq+wrtc-darwin-arm64@0.10.0",
  "node_modules/.pnpm/@roamhq+wrtc-darwin-x64@0.10.0",
  "node_modules/.pnpm/@roamhq+wrtc-linux-arm64@0.10.0",
  "node_modules/.pnpm/@roamhq+wrtc-linux-x64@0.10.0",
  "node_modules/.pnpm/@roamhq+wrtc-win32-x64@0.10.0",
  "node_modules/.pnpm/domexception@4.0.0",
  "node_modules/.pnpm/webidl-conversions@7.0.0"
];
const SERVER_ONLY_FORBIDDEN_PATHS = ["dist-node/cli", ...CLI_WEBRTC_RUNTIME_PATHS];
const SERVER_DISTRIBUTION_REQUIRED_PATHS = ["LICENSE", "README.md", "SECURITY.md"];
const DOCKER_IMAGE_REVISION_FALLBACK = "0000000000000000000000000000000000000000";

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
  const imageTag = imageTagFromEnv(optionalEnvString("DOCKER_SMOKE_TAG"));
  const imageVersion = dockerImageVersion(optionalEnvString("DOCKER_SMOKE_VERSION"));
  const imageRevision = dockerImageRevision(optionalEnvString("DOCKER_SMOKE_REVISION"));
  const containerName = `p2p-transfer-policy-${Date.now()}-${process.pid}`;
  const dockerConfigDir = createIsolatedDockerConfig();
  const dockerEnv = { DOCKER_CONFIG: dockerConfigDir };

  try {
    await run("docker", ["info", "--format", "{{json .ServerVersion}}"], "docker daemon preflight", DOCKER_PREFLIGHT_TIMEOUT_MS, { env: dockerEnv });
    await run(
      "docker",
      ["build", "--build-arg", `VERSION=${imageVersion}`, "--build-arg", `REVISION=${imageRevision}`, "-t", imageTag, "."],
      "docker image build",
      BUILD_TIMEOUT_MS,
      { env: dockerEnv }
    );
    await assertServerOnlyRuntime(imageTag, dockerEnv);
    await assertImageMetadata(imageTag, dockerEnv, imageVersion, imageRevision);
    await expectDockerFailure(
      ["run", "--rm", ...HARDENED_DOCKER_RUN_FLAGS, "-e", "SIGNALING_TOPOLOGY=single-instance", imageTag],
      "container without ALLOWED_ORIGINS",
      "Error: ALLOWED_ORIGINS is required in production.",
      dockerEnv
    );
    await expectDockerFailure(
      ["run", "--rm", ...HARDENED_DOCKER_RUN_FLAGS, "-e", `ALLOWED_ORIGINS=${PRODUCTION_ORIGIN}`, imageTag],
      "container without SIGNALING_TOPOLOGY",
      "Error: SIGNALING_TOPOLOGY must be single-instance or sticky-sessions for production or non-loopback deployments.",
      dockerEnv
    );

    assertContainerName(containerName);
    try {
      await run(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          ...HARDENED_DOCKER_RUN_FLAGS,
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
      const port = await publishedPort(containerName, dockerEnv);
      await waitForProbe(`http://127.0.0.1:${port}/healthz`, "200");
      await probe(`http://127.0.0.1:${port}/`, "200", { contains: "ff transfer", maxBytes: "1048576" });
      await probe(`http://127.0.0.1:${port}/v1/ice`, "200", { origin: PRODUCTION_ORIGIN, contains: "\"iceServers\"" });
      await probe(`http://127.0.0.1:${port}/v1/ice`, "403", { origin: BAD_ORIGIN });
      await probeWebSocketOrigin(port, PRODUCTION_ORIGIN, true);
      await probeWebSocketOrigin(port, BAD_ORIGIN, false);
    } finally {
      await run("docker", ["rm", "-f", containerName], "container cleanup", COMMAND_TIMEOUT_MS, { allowFailure: true, env: dockerEnv });
    }
  } finally {
    rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

function imageTagFromEnv(value) {
  if (value === undefined || value === "") return DEFAULT_IMAGE_TAG;
  if (typeof value !== "string" || !IMAGE_TAG_RE.test(value)) throw new Error("DOCKER_SMOKE_TAG must be a bounded docker image tag.");
  return value;
}

function dockerImageVersion(value) {
  const version = value ?? packageVersionFromMetadata();
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw new Error("DOCKER_SMOKE_VERSION must be an exact semver.");
  return version;
}

function dockerImageRevision(value) {
  const revision = value ?? DOCKER_IMAGE_REVISION_FALLBACK;
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("DOCKER_SMOKE_REVISION must be a full lowercase git SHA.");
  return revision;
}

function packageVersionFromMetadata() {
  const bytes = readPackageMetadataBytes();
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PACKAGE_JSON_BYTES) {
    throw new Error("package metadata size is invalid for docker image metadata.");
  }
  let encoded;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("package metadata is not valid UTF-8 for docker image metadata.");
  }
  let decoded;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new Error("package metadata is not valid JSON for docker image metadata.");
  }
  if (typeof decoded?.version !== "string") throw new Error("package metadata version is missing for docker image metadata.");
  return decoded.version;
}

function readPackageMetadataBytes() {
  const file = path.join(root, "package.json");
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new Error("package metadata could not be read for docker image metadata.");
  }
  if (!info.isFile() || info.size < 1 || info.size > MAX_PACKAGE_JSON_BYTES) {
    throw new Error("package metadata size is invalid for docker image metadata.");
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_PACKAGE_JSON_BYTES || !sameFile(info, opened)) {
      throw new Error("package metadata changed before docker image metadata verification.");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = readSync(fd, bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("package metadata changed while reading docker image metadata.");
    if (!sameFile(opened, fstatSync(fd))) throw new Error("package metadata changed while reading docker image metadata.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertContainerName(value) {
  if (!CONTAINER_NAME_RE.test(value)) throw new Error("generated docker container name is invalid.");
}

async function expectDockerFailure(args, label, requiredEvidence, env) {
  assertExpectedEvidenceLine(requiredEvidence);
  const result = await run("docker", args, label, COMMAND_TIMEOUT_MS, { allowFailure: true, env });
  if (result.status === 0) throw new Error(`${label} unexpectedly started.`);
  if (!hasExactOutputLine(result, requiredEvidence)) throw new Error(`${label} did not fail with the expected production policy evidence.`);
}

async function assertServerOnlyRuntime(imageTag, env) {
  const script = `const fs = require("node:fs"); const forbidden = ${JSON.stringify(SERVER_ONLY_FORBIDDEN_PATHS)}; const required = ${JSON.stringify(SERVER_DISTRIBUTION_REQUIRED_PATHS)}; for (const path of forbidden) { if (fs.existsSync(path)) { console.error("cli-runtime-present"); process.exit(1); } } for (const path of required) { if (!fs.existsSync(path)) { console.error("distribution-doc-missing"); process.exit(1); } }`;
  await run("docker", ["run", "--rm", ...HARDENED_DOCKER_RUN_FLAGS, "--entrypoint", "node", imageTag, "-e", script], "server-only Docker runtime check", COMMAND_TIMEOUT_MS, { env });
}

async function assertImageMetadata(imageTag, env, version, revision) {
  const result = await run(
    "docker",
    ["image", "inspect", imageTag, "--format", "{{json .Config.Labels}}"],
    "docker image metadata inspect",
    COMMAND_TIMEOUT_MS,
    { env }
  );
  let labels;
  try {
    labels = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("docker image metadata labels are invalid JSON.");
  }
  const expected = {
    "org.opencontainers.image.title": "p2p-transfer",
    "org.opencontainers.image.description": "End-to-end encrypted WebRTC file transfer signaling server",
    "org.opencontainers.image.source": "https://github.com/VictorHaine/p2p-transfer",
    "org.opencontainers.image.url": "https://github.com/VictorHaine/p2p-transfer",
    "org.opencontainers.image.documentation": "https://github.com/VictorHaine/p2p-transfer#readme",
    "org.opencontainers.image.licenses": "MIT",
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision
  };
  for (const [key, value] of Object.entries(expected)) {
    if (labels?.[key] !== value) throw new Error("docker image metadata labels are invalid.");
  }
}

async function publishedPort(containerName, env) {
  const result = await run("docker", ["port", containerName, "8787/tcp"], "container port lookup", COMMAND_TIMEOUT_MS, { env });
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
      await probe(url, status);
      return;
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("container health probe failed.");
}

async function probe(url, status, options = {}) {
  const env = { PROBE_URL: url, PROBE_STATUS: status };
  if (options.contains) env.PROBE_CONTAINS = options.contains;
  if (options.maxBytes) env.PROBE_MAX_BYTES = options.maxBytes;
  if (options.origin) env.PROBE_ORIGIN = options.origin;
  await run(process.execPath, ["scripts/probe-http.mjs"], "HTTP probe", COMMAND_TIMEOUT_MS, { env });
}

function probeWebSocketOrigin(port, origin, expectedAccepted) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const timer = setTimeout(() => {
      fail(new Error("WebSocket origin probe timed out."));
    }, WEBSOCKET_PROBE_TIMEOUT_MS);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    socket.setTimeout(WEBSOCKET_PROBE_TIMEOUT_MS, () => {
      fail(new Error("WebSocket origin probe timed out."));
    });
    socket.on("error", () => {
      fail(new Error("WebSocket origin probe failed."));
    });
    socket.on("connect", () => {
      socket.write(webSocketHandshakeRequest(port, origin));
    });
    socket.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        fail(new Error("WebSocket origin probe returned malformed data."));
        return;
      }
      response += chunk.toString("latin1");
      if (response.length > MAX_WEBSOCKET_HANDSHAKE_BYTES) {
        fail(new Error("WebSocket origin probe exceeded the response limit."));
        return;
      }
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const statusLine = response.slice(0, headerEnd).split("\r\n", 1)[0] ?? "";
      const accepted = /^HTTP\/1\.1 101(?:\s|$)/u.test(statusLine);
      if (accepted !== expectedAccepted) {
        fail(new Error("WebSocket origin probe did not match the expected policy decision."));
        return;
      }
      finish();
    });
  });
}

function webSocketHandshakeRequest(port, origin) {
  return [
    "GET /v1/ws HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    `Origin: ${origin}`,
    "",
    ""
  ].join("\r\n");
}

function run(command, args, label, timeout, options = {}) {
  return new Promise((resolve, reject) => {
    const verbose = verboseEnabled() && !options.allowFailure;
    const child = spawn(command, args, {
      cwd: root,
      env: { ...safeChildEnv(), ...(options.env ?? {}) },
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    let timeoutError;
    let outputError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${label} timed out.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, timeout);

    if (!verbose) {
      child.stdout.on("data", (chunk) => {
        try {
          stdout = appendBoundedOutput(stdout, chunk);
        } catch (error) {
          outputError = error instanceof Error ? error : new Error("docker policy smoke output capture failed.");
          child.kill("SIGTERM");
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = appendBoundedOutput(stderr, chunk);
        } catch (error) {
          outputError = error instanceof Error ? error : new Error("docker policy smoke output capture failed.");
          child.kill("SIGTERM");
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        }
      });
    }

    child.on("error", rejectOnce);
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      if (outputError) {
        rejectOnce(outputError);
        return;
      }
      const status = typeof code === "number" ? code : null;
      const result = { status, signal, stdout, stderr };
      if (!options.allowFailure && status !== 0) {
        rejectOnce(new Error(`${label} failed. Set ${VERBOSE_ENV}=1 to print command output.`));
        return;
      }
      resolveOnce(result);
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

function verboseEnabled() {
  return optionalEnvString(VERBOSE_ENV) === "1";
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
      throw new Error(`${name} must be a non-empty control-free child environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
    }
  }
  return env;
}

function isSafeChildEnvValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value) && !utf8ByteLengthExceeds(value, MAX_CHILD_ENV_VALUE_BYTES);
}

function optionalEnvString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === "") return undefined;
  if (!isSafeChildEnvValue(descriptor.value)) {
    throw new Error(`${name} must be a non-empty control-free environment value under ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function assertExpectedEvidenceLine(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_EXPECTED_EVIDENCE_CHARS ||
    /[\r\n\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)
  ) {
    throw new Error("docker policy smoke expected evidence line is invalid.");
  }
}

function hasExactOutputLine(result, expectedLine) {
  return boundedCombinedOutput(result)
    .split(/\r?\n/u)
    .some((line) => line.trim() === expectedLine);
}

function boundedCombinedOutput(result) {
  return `${boundedOutputText(result.stdout)}\n${boundedOutputText(result.stderr)}`;
}

function boundedOutputText(value) {
  if (typeof value !== "string") return "";
  return value.length > MAX_DOCKER_FAILURE_EVIDENCE_CHARS ? value.slice(-MAX_DOCKER_FAILURE_EVIDENCE_CHARS) : value;
}

function appendBoundedOutput(current, chunk) {
  if (typeof current !== "string" || !Buffer.isBuffer(chunk)) throw new Error("docker policy smoke output capture failed.");
  const next = current + chunk.toString("utf8").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : ""));
  if (Buffer.byteLength(next, "utf8") <= MAX_COMMAND_OUTPUT_BYTES) return next;
  return truncateUtf8Tail(next, MAX_COMMAND_OUTPUT_BYTES);
}

function truncateUtf8Tail(value, maxBytes) {
  let bytes = 0;
  let start = value.length;
  while (start > 0) {
    const code = value.charCodeAt(start - 1);
    let width = 3;
    if (code <= 0x7f) {
      width = 1;
    } else if (code <= 0x7ff) {
      width = 2;
    } else if (code >= 0xdc00 && code <= 0xdfff && start > 1) {
      const previous = value.charCodeAt(start - 2);
      width = previous >= 0xd800 && previous <= 0xdbff ? 4 : 3;
      if (width === 4) start -= 1;
    }
    if (bytes + width > maxBytes) break;
    bytes += width;
    start -= 1;
  }
  return value.slice(start);
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
  if (containsPathLikeText(error.message)) return "docker policy smoke failed with path-sensitive evidence.";
  return error.message;
}

function containsPathLikeText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
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
