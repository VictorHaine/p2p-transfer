#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_CHANGELOG_BYTES = 1024 * 1024;
const MAX_RELEASE_NOTES_BYTES = 128 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 1024;

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function releaseNotesErrorMessage(error) {
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
  return "release notes generation failed.";
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
}

function noFollowReadFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function noFollowCreateFlags() {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
}

function parseArgs(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("Unsupported release notes arguments.");
}

function assertEntrypoint() {
  if (!isMain()) {
    throw new Error("Release notes script must be executed directly.");
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

async function readBoundedRegularText(filePath, maxBytes, description) {
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
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${description} must be valid UTF-8.`);
    }
  } finally {
    await handle.close();
  }
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

function parseReleaseVersion(packageText) {
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    throw new Error("package metadata must be valid JSON.");
  }
  const version = packageJson?.version;
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error("package version must be an exact semver release.");
  }
  return version;
}

function extractReleaseNotes(changelog, version) {
  const headingPattern = /^##\s+(?:\[(?<bracketVersion>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\]|(?<plainVersion>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)))(?:\s+-\s+[^\r\n]+)?\s*$/gm;
  let targetStart = -1;
  let targetEnd = -1;
  let match;

  while ((match = headingPattern.exec(changelog)) !== null) {
    const headingVersion = match.groups?.bracketVersion ?? match.groups?.plainVersion;
    if (targetStart >= 0) {
      targetEnd = match.index;
      break;
    }
    if (headingVersion === version) {
      targetStart = headingPattern.lastIndex;
    }
  }

  if (targetStart < 0) {
    throw new Error("changelog does not contain release notes for the package version.");
  }
  const body = changelog.slice(targetStart, targetEnd >= 0 ? targetEnd : changelog.length).trim();
  if (body.length < 1) {
    throw new Error("release notes section is empty.");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_RELEASE_NOTES_BYTES) {
    throw new Error("release notes section exceeds the byte limit.");
  }
  return `${body}\n`;
}

async function writeReleaseNotes() {
  const options = parseArgs(process.argv.slice(2));
  assertEntrypoint();

  const version = parseReleaseVersion(await readBoundedRegularText(path.join(projectRoot, "package.json"), MAX_PACKAGE_JSON_BYTES, "package metadata"));
  const changelog = await readBoundedRegularText(path.join(projectRoot, "CHANGELOG.md"), MAX_CHANGELOG_BYTES, "changelog");
  const notes = extractReleaseNotes(changelog, version);
  if (options.check) return;
  await writeNewArtifactFile(await verifiedArtifactDir(), "RELEASE_NOTES.md", notes, "release notes");
}

if (isMain()) {
  writeReleaseNotes().catch((error) => {
    console.error("Release notes generation failed:");
    console.error(releaseNotesErrorMessage(error));
    process.exitCode = 1;
  });
}
