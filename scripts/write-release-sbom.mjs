#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeChildEnv } from "./smoke-packed.mjs";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_SBOM_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 1024;
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_KILL_GRACE_MS = 5_000;
const SBOM_NAME = "SBOM.cdx.json";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function releaseSbomErrorMessage(error) {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.length <= MAX_ERROR_MESSAGE_CHARS &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message) &&
    !containsAbsolutePathText(error.message)
  ) {
    return error.message;
  }
  return "release SBOM generation failed.";
}

function noFollowReadFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function noFollowCreateFlags() {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
}

function assertNoArgs(args) {
  if (args.length !== 0) {
    throw new Error("Unsupported release SBOM arguments.");
  }
}

function assertEntrypoint() {
  if (!isMain()) {
    throw new Error("Release SBOM script must be executed directly.");
  }
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

async function readBoundedRegularFile(filePath, maxBytes, description) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error(`${description} could not be read.`);
  }
  if (!info.isFile()) {
    throw new Error(`${description} must be a regular file.`);
  }
  if (info.size < 1 || info.size > maxBytes) {
    throw new Error(`${description} exceeds the byte limit.`);
  }

  let handle;
  try {
    handle = await open(filePath, noFollowReadFlags());
  } catch {
    throw new Error(`${description} could not be opened.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${description} must be a regular file.`);
    }
    if (stat.size < 1 || stat.size > maxBytes) {
      throw new Error(`${description} exceeds the byte limit.`);
    }
    if (!sameFile(info, stat)) {
      throw new Error(`${description} changed before verification.`);
    }
    const bytes = await readVerifiedHandleBytes(handle, stat.size, description);
    const opened = await handle.stat();
    if (opened.size !== stat.size || !sameFile(stat, opened)) {
      throw new Error(`${description} changed while being read.`);
    }
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
  if (offset !== size) {
    throw new Error(`${description} changed while being read.`);
  }
  return buffer;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifiedArtifactDir() {
  const artifactDir = path.join(projectRoot, "release-artifacts");
  let info;
  try {
    info = await lstat(artifactDir);
  } catch {
    throw new Error("release artifact directory could not be read.");
  }
  if (!info.isDirectory()) {
    throw new Error("release artifact directory must be a real directory.");
  }
  const realProjectRoot = await realpathStrict(projectRoot, "project root");
  const realArtifactDir = await realpathStrict(artifactDir, "release artifact directory");
  if (!isPathInside(realProjectRoot, realArtifactDir)) {
    throw new Error("release artifact directory must stay inside the project root.");
  }
  return realArtifactDir;
}

async function writeNewArtifactFile(artifactDir, name, body, description) {
  const filePath = path.join(artifactDir, name);
  const bodyBytes = Buffer.from(body, "utf8");
  const handle = await open(filePath, noFollowCreateFlags(), 0o644).catch(() => {
    throw new Error(`${description} could not be created.`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 0) throw new Error(`${description} output is invalid.`);
    const info = await lstat(filePath).catch(() => {
      throw new Error(`${description} output could not be verified.`);
    });
    if (!sameFileIdentity(info, stat)) throw new Error(`${description} output changed before writing.`);
    const realProjectRoot = await realpathStrict(projectRoot, "project root");
    const realFilePath = await realpathStrict(filePath, description);
    if (!isPathInside(realProjectRoot, realFilePath)) throw new Error(`${description} output must stay inside the project root.`);
    await writeAll(handle, bodyBytes, description);
    const afterWrite = await handle.stat();
    if (!sameFileIdentity(stat, afterWrite) || afterWrite.size !== bodyBytes.byteLength) {
      throw new Error(`${description} output changed while writing.`);
    }
  } finally {
    bodyBytes.fill(0);
    await handle.close();
  }
}

async function realpathStrict(targetPath, description) {
  try {
    return await realpath(targetPath);
  } catch {
    throw new Error(`${description} could not be verified.`);
  }
}

async function writeAll(handle, body, description) {
  let offset = 0;
  while (offset < body.byteLength) {
    const { bytesWritten } = await handle.write(body, offset, body.byteLength - offset, offset);
    if (bytesWritten === 0) throw new Error(`${description} output write made no progress.`);
    offset += bytesWritten;
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
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

function expectedTarballNameFor(packageJson) {
  const { name, version } = packageJson;
  if (typeof name !== "string" || !isSupportedPackageName(name)) {
    throw new Error("package name must be an exact npm package name.");
  }
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error("package version must be an exact semver release.");
  }
  return `${packedPackageName(name)}-${version}.tgz`;
}

function isSupportedPackageName(name) {
  return /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/.test(name) && name.length <= 214;
}

function packedPackageName(name) {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

function packagePurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, localName] = name.slice(1).split("/");
    return `pkg:npm/%40${scope}/${localName}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

function packageGroup(name) {
  if (!name.startsWith("@")) return undefined;
  return `@${name.slice(1).split("/")[0]}`;
}

function packageLocalName(name) {
  return name.startsWith("@") ? name.slice(1).split("/")[1] : name;
}

async function assertOnlyPackedTarball(artifactDir, expectedTarballName) {
  const entries = await readdir(artifactDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== expectedTarballName) {
    throw new Error("release artifact directory must contain exactly the expected tarball before SBOM generation.");
  }
  const tarball = path.join(artifactDir, expectedTarballName);
  const info = await lstat(tarball);
  if (!info.isFile()) throw new Error("release tarball must be a regular file.");
  if (info.size < 1 || info.size > MAX_TARBALL_BYTES) throw new Error("release tarball exceeds the byte limit.");
}

async function generateSbom() {
  const output = await runPnpmSbom();
  const text = decodeUtf8(output, "release SBOM");
  const document = parseJson(text, "release SBOM");
  if (!isPlainRecord(document)) throw new Error("release SBOM must be a plain JSON object.");
  return `${JSON.stringify(document, null, 2)}\n`;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function validateSbomText(text, packageJson) {
  if (Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > MAX_SBOM_BYTES) {
    throw new Error("release SBOM exceeds the byte limit.");
  }
  const document = parseJson(text, "release SBOM");
  assertValidCycloneDxSbom(document, packageJson);
}

function assertValidCycloneDxSbom(document, packageJson) {
  if (!isPlainRecord(document)) throw new Error("release SBOM must be a plain JSON object.");
  if (ownValue(document, "bomFormat") !== "CycloneDX") throw new Error("release SBOM must be CycloneDX.");
  if (ownValue(document, "specVersion") !== "1.7") throw new Error("release SBOM must use CycloneDX 1.7.");
  const metadata = requiredPlainRecord(document, "metadata", "release SBOM");
  const component = requiredPlainRecord(metadata, "component", "release SBOM metadata");
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  if (ownValue(component, "type") !== "application") throw new Error("release SBOM component type is invalid.");
  if (ownValue(component, "name") !== packageLocalName(packageName)) throw new Error("release SBOM component name does not match the package.");
  if (ownValue(component, "version") !== packageVersion) throw new Error("release SBOM component version does not match the package.");
  const purl = packagePurl(packageName, packageVersion);
  if (ownValue(component, "purl") !== purl || ownValue(component, "bom-ref") !== purl) {
    throw new Error("release SBOM component purl does not match the package.");
  }
  const expectedGroup = packageGroup(packageName);
  const group = optionalOwnValue(component, "group");
  if (expectedGroup === undefined ? group !== undefined : group !== expectedGroup) {
    throw new Error("release SBOM component group does not match the package.");
  }
  const components = ownValue(document, "components");
  if (!Array.isArray(components) || components.length < 1 || components.length > 4096) {
    throw new Error("release SBOM components are outside the allowed range.");
  }
}

function requiredPlainRecord(record, key, label) {
  const value = ownValue(record, key);
  if (!isPlainRecord(value)) throw new Error(`${label} ${key} must be a plain JSON object.`);
  return value;
}

function optionalOwnValue(record, key) {
  if (!isPlainRecord(record)) throw new Error("release SBOM metadata must be a plain JSON object.");
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("release SBOM metadata fields must be data properties.");
  return descriptor.value;
}

function ownValue(record, key) {
  const value = optionalOwnValue(record, key);
  if (value === undefined) throw new Error("release SBOM metadata is incomplete.");
  return value;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function runPnpmSbom() {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, ["sbom", "--sbom-format", "cyclonedx", "--prod", "--sbom-type", "application"], {
      cwd: projectRoot,
      env: safeChildEnv(),
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    let total = 0;
    let settled = false;
    let killTimer;
    let timeoutError;
    let outputError;
    const timer = setTimeout(() => {
      timeoutError = new Error("release SBOM generation timed out.");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
    }, CHILD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (outputError) return;
      total += chunk.byteLength;
      if (total > MAX_SBOM_BYTES) {
        outputError = new Error("release SBOM exceeds the byte limit.");
        child.kill("SIGTERM");
        killTimer = killTimer ?? setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
        return;
      }
      chunks.push(chunk);
    });
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
      if (code !== 0) {
        rejectOnce(new Error(`release SBOM generation failed with ${childExitStatus(code, signal)}.`));
        return;
      }
      resolveOnce(Buffer.concat(chunks, total));
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

function childExitStatus(code, signal) {
  if (typeof code === "number") return `exit status ${code}`;
  if (typeof signal === "string" && /^[A-Z0-9]+$/u.test(signal)) return `signal ${signal}`;
  return "unknown child status";
}

async function writeReleaseSbom() {
  assertNoArgs(process.argv.slice(2));
  assertEntrypoint();

  const packageJson = parsePackageMetadata(
    await readBoundedRegularFile(path.join(projectRoot, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"),
  );
  const expectedTarballName = expectedTarballNameFor(packageJson);
  const artifactDir = await verifiedArtifactDir();
  await assertOnlyPackedTarball(artifactDir, expectedTarballName);
  const sbomText = await generateSbom();
  validateSbomText(sbomText, packageJson);
  await writeNewArtifactFile(artifactDir, SBOM_NAME, sbomText, "release SBOM");
}

if (isMain()) {
  writeReleaseSbom().catch((error) => {
    console.error("Release SBOM generation failed:");
    console.error(releaseSbomErrorMessage(error));
    process.exitCode = 1;
  });
}
