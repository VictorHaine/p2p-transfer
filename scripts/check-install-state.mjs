#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (isMain()) {
  try {
    main();
  } catch (error) {
    console.error("Installed dependency tree could not be verified:");
    console.error(`- ${installStateErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function main() {
  const mismatches = installedStateMismatches();
  if (mismatches.length > 0) {
    console.error("Installed dependency tree does not match package.json pins:");
    for (const mismatch of mismatches) console.error(`- ${mismatch}`);
    process.exitCode = 1;
  }
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

function installedStateMismatches() {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(packageJsonPath, MAX_PACKAGE_JSON_BYTES);
  const rootLockfile = path.join(root, "pnpm-lock.yaml");
  const installedLockfile = path.join(root, "node_modules", ".pnpm", "lock.yaml");
  const expected = expectedDependencies(packageJson);
  const mismatches = [];

  for (const [name, version] of Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      mismatches.push(`${name}: expected exact semver package.json pin`);
      continue;
    }
    const installedPath = path.join(root, "node_modules", ...name.split("/"), "package.json");
    let installed;
    try {
      installed = readJson(installedPath, MAX_PACKAGE_JSON_BYTES);
    } catch {
      mismatches.push(`${name}: could not read installed package evidence at ${relativeEvidencePath(installedPath)}`);
      continue;
    }
    const installedName = ownString(installed, "name");
    if (!isCanonicalPackageName(installedName)) {
      mismatches.push(`${name}: installed package identity is invalid`);
      continue;
    }
    if (installedName !== name) {
      mismatches.push(`${name}: installed package identity does not match expected name`);
      continue;
    }
    const installedVersion = ownString(installed, "version");
    if (!/^\d+\.\d+\.\d+$/.test(installedVersion)) {
      mismatches.push(`${name}: installed package version is invalid`);
      continue;
    }
    if (installedVersion !== version) {
      mismatches.push(`${name}: installed package version does not match package.json pin`);
    }
  }

  try {
    const expectedLock = readLockfile(rootLockfile);
    const installedLock = readLockfile(installedLockfile);
    if (installedLock !== expectedLock) {
      mismatches.push("node_modules/.pnpm/lock.yaml does not match pnpm-lock.yaml; run pnpm install --frozen-lockfile");
    }
  } catch (error) {
    mismatches.push(installStateErrorMessage(error));
  }

  return mismatches;
}

function expectedDependencies(packageJson) {
  const dependencies = dependencyRecord(packageJson, "dependencies");
  const devDependencies = dependencyRecord(packageJson, "devDependencies");
  const out = { ...dependencies };
  for (const [name, version] of Object.entries(devDependencies)) {
    if (Object.hasOwn(out, name)) {
      throw new Error(`Dependency ${name} must not be declared in both dependencies and devDependencies`);
    }
    out[name] = version;
  }
  return out;
}

function dependencyRecord(packageJson, key) {
  const value = ownValue(packageJson, key);
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new Error(`${key} must be a plain object in package.json`);

  const out = {};
  for (const name of Object.keys(value)) {
    validatePackageName(name);
    out[name] = ownValue(value, name);
  }
  return out;
}

function validatePackageName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 214) {
    throw new Error("Invalid dependency name in package.json.");
  }
  if (name.includes("\\") || name.includes("\0") || name.includes("..")) {
    throw new Error("Invalid dependency name in package.json.");
  }
  if (!isCanonicalPackageName(name)) {
    throw new Error("Invalid dependency name in package.json.");
  }
}

function isCanonicalPackageName(name) {
  return typeof name === "string" && name.length >= 1 && name.length <= 214 && !name.includes("\\") && !name.includes("\0") && !name.includes("..") && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name);
}

function ownValue(record, key) {
  if (!isPlainRecord(record)) throw new Error("Expected a plain JSON object");
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw new Error(`Expected ${key} to be a data property`);
  return descriptor.value;
}

function ownString(record, key) {
  const value = ownValue(record, key);
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function readJson(file, maxBytes) {
  const text = readText(file, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON evidence at ${relativeEvidencePath(file)}`);
  }
}

function readLockfile(file) {
  try {
    return readText(file, MAX_LOCKFILE_BYTES).replace(/\r\n/g, "\n");
  } catch {
    throw new Error(`could not verify lockfile evidence at ${relativeEvidencePath(file)}`);
  }
}

function readText(file, maxBytes) {
  const label = relativeEvidencePath(file);
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new Error(`${label} could not be read`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${label} is outside the allowed size range`);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} could not be opened`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
    if (opened.size < 1 || opened.size > maxBytes) throw new Error(`${label} is outside the allowed size range`);
    if (!sameFile(info, opened)) throw new Error(`${label} changed before verification`);
    return readHandleText(fd, opened.size, label);
  } catch (error) {
    if (error instanceof Error && typeof error.message === "string" && error.message.startsWith(label)) throw error;
    throw new Error(`${label} could not be read`);
  } finally {
    closeSync(fd);
  }
}

function readHandleText(fd, size, label) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error(`${label} changed while being read`);
  const opened = fstatSync(fd);
  if (opened.size !== size) throw new Error(`${label} changed while being read`);
  try {
    return fatalUtf8.decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function relativeEvidencePath(file) {
  const relative = path.relative(root, file);
  if (relative.length < 1 || relative.startsWith("..") || path.isAbsolute(relative) || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(relative)) {
    throw new Error("invalid install-state evidence path");
  }
  return relative;
}

function installStateErrorMessage(error) {
  if (
    !(error instanceof Error) ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)
  ) {
    return "could not verify install-state evidence";
  }
  if (containsAbsolutePathText(error.message)) {
    return "could not verify install-state evidence";
  }
  return error.message;
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}
