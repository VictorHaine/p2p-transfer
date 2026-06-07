#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_SBOM_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 1024;
const SBOM_NAME = "SBOM.cdx.json";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const isDirectEntrypoint = typeof process.argv[1] === "string" && realpathSync(process.argv[1]) === realpathSync(scriptPath);

function releaseChecksumErrorMessage(error) {
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
  return "release checksum generation failed.";
}

function noFollowReadFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function assertNoArgs(args) {
  if (args.length !== 0) {
    throw new Error("Unsupported release checksum arguments.");
  }
}

function assertEntrypoint() {
  if (!isDirectEntrypoint) {
    throw new Error("Release checksum script must be executed directly.");
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
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
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

async function realpathStrict(targetPath, description) {
  try {
    return await realpath(targetPath);
  } catch {
    throw new Error(`${description} could not be verified.`);
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
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

async function writeReleaseChecksum() {
  assertNoArgs(process.argv.slice(2));
  assertEntrypoint();

  const packageJson = parsePackageMetadata(
    await readBoundedRegularFile(path.join(projectRoot, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"),
  );
  const expectedTarballName = expectedTarballNameFor(packageJson);
  const artifactDir = await verifiedArtifactDir();
  const entries = await readdir(artifactDir, { withFileTypes: true });

  if (
    entries.length !== 2 ||
    !entries.every((entry) => entry.isFile()) ||
    !entries.some((entry) => entry.name === expectedTarballName) ||
    !entries.some((entry) => entry.name === SBOM_NAME)
  ) {
    throw new Error("release artifact directory must contain exactly the expected tarball and SBOM.");
  }

  const tarballBytes = await readBoundedRegularFile(
    path.join(artifactDir, expectedTarballName),
    MAX_TARBALL_BYTES,
    "release tarball",
  );
  const sbomBytes = await readBoundedRegularFile(
    path.join(artifactDir, SBOM_NAME),
    MAX_SBOM_BYTES,
    "release SBOM",
  );
  const tarballChecksum = createHash("sha256").update(tarballBytes).digest("hex");
  const sbomChecksum = createHash("sha256").update(sbomBytes).digest("hex");
  await writeFile(path.join(artifactDir, "SHA256SUMS"), `${tarballChecksum}  ${expectedTarballName}\n${sbomChecksum}  ${SBOM_NAME}\n`, { flag: "wx" });
}

if (isDirectEntrypoint) {
  writeReleaseChecksum().catch((error) => {
    console.error("Release checksum generation failed:");
    console.error(releaseChecksumErrorMessage(error));
    process.exitCode = 1;
  });
}
