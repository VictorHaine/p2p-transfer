#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, "release-artifacts");
const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_PACKED_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const MAX_CHECKSUM_FILE_BYTES = 512;
const MAX_SBOM_BYTES = 1024 * 1024;
const MAX_ARTIFACT_ENTRY_NAME_BYTES = 255;
const MAX_RELEASE_ENV_VALUE_BYTES = 256;
const MAX_GITHUB_OUTPUT_BYTES = 1024 * 1024;
const MAX_TAR_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_EXPECTED_PACKED_FILES = 4096;
const MAX_EXPECTED_PACKED_BYTES = 256 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const SBOM_NAME = "SBOM.cdx.json";

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Release artifact verification failed:");
    console.error(`- ${releaseArtifactErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expected = parseJson(await readText(path.join(root, "package.json"), MAX_PROJECT_PACKAGE_JSON_BYTES), "package.json");
  const expectedName = requiredPackageName(expected.name);
  const expectedVersion = requiredPackageVersion(expected.version);
  const expectedSbom = await expectedProductionSbom(expected, expectedName, expectedVersion);
  const tag = requiredReleaseTag(envString("GITHUB_REF_NAME"), expectedVersion);
  assertReleaseTagRef(tag);
  const releaseArtifactDir = await verifiedArtifactDir();
  const tarball = await singleReleaseTarball(releaseArtifactDir, expectedName, expectedVersion);
  const sbom = await releaseSbomFile(releaseArtifactDir);

  try {
    await verifyChecksumFile(releaseArtifactDir, tarball, sbom);
    await verifySbomFile(sbom, expectedName, expectedVersion, expectedSbom);
    const packed = await verifyPackedFileContents(tarball, expected);
    assertPackedPackageMetadataMatchesWorkspace(expected, packed);
    const packedName = requiredPackageName(packed.name, "package/package.json name");
    const packedVersion = requiredPackageVersion(packed.version, "package/package.json version");
    if (packedName !== expectedName || packedVersion !== expectedVersion || tag !== `v${packedVersion}`) {
      throw new Error("release artifact package metadata does not match the checked workspace metadata.");
    }
    const tarballPath = verifiedTarballPath(tarball);
    if (options.printTarballPath) console.log(tarballPath);
    if (options.githubOutputName) await writeGithubOutput(options.githubOutputName, tarballPath);
  } finally {
    await tarball.handle.close().catch(() => undefined);
    await sbom.handle.close().catch(() => undefined);
  }
}

function parseArgs(args) {
  if (args.length === 0) return { printTarballPath: false };
  if (args.length === 1 && args[0] === "--print-tarball") return { printTarballPath: true };
  if (args.length === 2 && args[0] === "--github-output" && args[1] === "tarball") return { printTarballPath: false, githubOutputName: "tarball" };
  throw new Error("Unsupported release artifact verifier arguments.");
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

function releaseArtifactErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release artifact verification failed with an internal error.";
  }
  if (containsAbsolutePathText(error.message)) {
    return "release artifact verification failed with path-sensitive evidence.";
  }
  return error.message;
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}

function envString(name, maxBytes = MAX_RELEASE_ENV_VALUE_BYTES) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length < 1 || /[\p{Cc}\p{Cf}]/u.test(descriptor.value) || utf8ByteLengthExceeds(descriptor.value, maxBytes)) {
    throw new Error(`${name} must be a non-empty control-free string under ${maxBytes} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function requiredPackageName(value, label = "package.json name") {
  if (typeof value !== "string" || !isSupportedPackageName(value)) {
    throw new Error(`${label} must be an exact npm package name.`);
  }
  return value;
}

function requiredPackageVersion(value, label = "package.json version") {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} must be an exact semver release.`);
  }
  return value;
}

function requiredReleaseTag(value, version) {
  if (value !== `v${version}`) throw new Error(`release tag does not match package version ${version}.`);
  return value;
}

function assertReleaseTagRef(tag) {
  if (envString("GITHUB_REF_TYPE") !== "tag" || envString("GITHUB_REF") !== `refs/tags/${tag}`) {
    throw new Error("release workflow ref must be the matching tag ref.");
  }
}

function assertPackedPackageMetadataMatchesWorkspace(expected, packed) {
  const expectedMetadata = releasePackageMetadata(expected, "package.json", { packageManager: "required" });
  const packedMetadata = releasePackageMetadata(packed, "package/package.json", { packageManager: "forbidden" });
  delete expectedMetadata.packageManager;
  if (JSON.stringify(packedMetadata) !== JSON.stringify(expectedMetadata)) {
    throw new Error("release artifact package metadata does not match the checked workspace metadata.");
  }
}

function releasePackageMetadata(record, label, options) {
  if (!isPlainRecord(record)) throw new Error(`${label} must be a plain JSON object.`);
  const scripts = optionalPlainRecord(record, "scripts", label);
  if (scripts) assertNoInstallLifecycleScripts(scripts, label);
  const packageManager = optionalOwnValue(record, "packageManager");
  if (options.packageManager === "required") {
    exactPackageManager(packageManager, label);
  } else if (packageManager !== undefined) {
    throw new Error("release artifact package metadata does not match the checked workspace metadata.");
  }
  const metadata = {
    name: requiredPackageName(ownValue(record, "name"), `${label} name`),
    version: requiredPackageVersion(ownValue(record, "version"), `${label} version`),
    type: exactStringField(record, "type", label),
    publishConfig: canonicalJsonValue(requiredPlainRecord(record, "publishConfig", label), `${label} publishConfig`),
    engines: canonicalStringRecord(requiredPlainRecord(record, "engines", label), `${label} engines`),
    bin: canonicalStringRecord(requiredPlainRecord(record, "bin", label), `${label} bin`),
    files: canonicalStringArray(requiredArray(record, "files", label), `${label} files`),
    dependencies: canonicalStringRecord(requiredPlainRecord(record, "dependencies", label), `${label} dependencies`),
    installAndImportMetadata: canonicalOptionalJsonFields(record, label, [
      "description",
      "license",
      "author",
      "homepage",
      "bugs",
      "repository",
      "keywords",
      "main",
      "module",
      "exports",
      "browser",
      "types",
      "typings",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "bundleDependencies",
      "bundledDependencies",
      "os",
      "cpu",
      "libc",
      "man",
      "directories",
      "config"
    ])
  };
  if (options.packageManager === "required") metadata.packageManager = packageManager;
  return metadata;
}

function exactPackageManager(value, label) {
  if (typeof value !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} packageManager must be an exact pnpm version pin.`);
  }
}

function assertNoInstallLifecycleScripts(scripts, label) {
  const forbidden = new Set(["preinstall", "install", "postinstall", "prepare"]);
  for (const key of Object.keys(scripts)) {
    if (forbidden.has(key)) throw new Error(`${label} must not contain install lifecycle scripts.`);
  }
}

function exactStringField(record, key, label) {
  const value = ownValue(record, key);
  if (typeof value !== "string" || value.length < 1 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
    throw new Error(`${label} ${key} must be a non-empty safe string.`);
  }
  return value;
}

function requiredPlainRecord(record, key, label) {
  const value = ownValue(record, key);
  if (!isPlainRecord(value)) throw new Error(`${label} ${key} must be a plain JSON object.`);
  return value;
}

function requiredArray(record, key, label) {
  const value = ownValue(record, key);
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new Error(`${label} ${key} must be a non-empty bounded array.`);
  return value;
}

function optionalPlainRecord(record, key, label) {
  const value = optionalOwnValue(record, key);
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error(`${label} ${key} must be a plain JSON object.`);
  return value;
}

function canonicalStringArray(value, label) {
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} entries must be data properties.`);
    out.push(packagePathEntry(descriptor.value, label));
  }
  return out.sort();
}

function canonicalStringRecord(record, label) {
  const out = {};
  for (const key of Object.keys(record).sort()) {
    if (!/^[A-Za-z0-9@._~+:/ \-]+$/.test(key) || key.includes("..")) throw new Error(`${label} contains an invalid key.`);
    const value = ownValue(record, key);
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
      throw new Error(`${label} contains an invalid value.`);
    }
    out[key] = value;
  }
  return out;
}

function canonicalJsonValue(value, label) {
  if (typeof value === "string") {
    if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) throw new Error(`${label} contains an invalid value.`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error(`${label} contains an oversized array.`);
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new Error(`${label} entries must be data properties.`);
      out.push(canonicalJsonValue(descriptor.value, label));
    }
    return out;
  }
  if (isPlainRecord(value)) {
    const out = {};
    const keys = Object.keys(value).sort();
    if (keys.length > 64) throw new Error(`${label} contains too many fields.`);
    for (const key of keys) {
      if (!/^[A-Za-z0-9._~-]{1,80}$/.test(key)) throw new Error(`${label} contains an invalid key.`);
      out[key] = canonicalJsonValue(ownValue(value, key), label);
    }
    return out;
  }
  throw new Error(`${label} contains an invalid value.`);
}

function canonicalOptionalJsonFields(record, label, keys) {
  const out = {};
  for (const key of keys) {
    const value = optionalOwnValue(record, key);
    out[key] = value === undefined ? { present: false } : { present: true, value: canonicalJsonValue(value, `${label} ${key}`) };
  }
  return out;
}

function packagePathEntry(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) ||
    value.includes("\\") ||
    value.includes("..") ||
    value.startsWith("/") ||
    value.startsWith("package/")
  ) {
    throw new Error(`${label} contains an invalid package path.`);
  }
  return value;
}

function optionalOwnValue(record, key) {
  if (!isPlainRecord(record)) throw new Error("release package metadata must be a plain JSON object.");
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("release package metadata fields must be data properties.");
  return descriptor.value;
}

function ownValue(record, key) {
  const value = optionalOwnValue(record, key);
  if (value === undefined) throw new Error("release package metadata is incomplete.");
  return value;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function utf8ByteLengthExceeds(value, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid release verifier byte limit.");
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
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
    if (bytes > limit) return true;
  }
  return false;
}

async function singleReleaseTarball(releaseArtifactDir, name, version) {
  const expectedBasename = `${packedPackageName(name)}-${version}.tgz`;
  const entries = (await readdir(releaseArtifactDir)).map(releaseArtifactEntryName);
  assertExactArtifactEntries(entries, expectedBasename);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one release tarball, got ${tarballs.length}`);
  if (tarballs[0] !== expectedBasename) throw new Error(`unexpected release tarball name: ${tarballs[0]}`);
  const tarball = path.join(releaseArtifactDir, tarballs[0]);
  const info = await lstat(tarball);
  if (!info.isFile()) throw new Error(`release tarball is not a regular file: ${tarballs[0]}`);
  if (info.size < 1 || info.size > MAX_TARBALL_BYTES) throw new Error(`release tarball size is outside the allowed range: ${info.size}`);
  const handle = await open(tarball, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`release tarball is not a regular file: ${tarballs[0]}`);
    if (opened.size < 1 || opened.size > MAX_TARBALL_BYTES) throw new Error(`release tarball size is outside the allowed range: ${opened.size}`);
    if (!sameFile(info, opened)) throw new Error("release tarball changed before verification.");
    return { path: tarball, basename: tarballs[0], handle, size: opened.size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function isSupportedPackageName(name) {
  return /^(?:[a-z0-9][a-z0-9._-]{0,213}|@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213})$/.test(name) && name.length <= 214;
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

function releaseArtifactEntryName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\0") ||
    utf8ByteLengthExceeds(value, MAX_ARTIFACT_ENTRY_NAME_BYTES) ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("release-artifacts contains an invalid artifact entry name.");
  }
  return value;
}

function assertExactArtifactEntries(entries, expectedBasename) {
  const expected = ["SHA256SUMS", SBOM_NAME, expectedBasename].sort();
  const actual = [...entries].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`release-artifacts must contain only ${expected.join(" and ")}.`);
  }
}

async function releaseSbomFile(releaseArtifactDir) {
  const sbom = path.join(releaseArtifactDir, SBOM_NAME);
  const info = await lstat(sbom);
  if (!info.isFile()) throw new Error("release SBOM is not a regular file.");
  if (info.size < 1 || info.size > MAX_SBOM_BYTES) throw new Error("release SBOM size is outside the allowed range.");
  const handle = await open(sbom, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("release SBOM is not a regular file.");
    if (opened.size < 1 || opened.size > MAX_SBOM_BYTES) throw new Error("release SBOM size is outside the allowed range.");
    if (!sameFile(info, opened)) throw new Error("release SBOM changed before verification.");
    return { path: sbom, basename: SBOM_NAME, handle, size: opened.size, label: "release SBOM" };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifiedArtifactDir() {
  let info;
  try {
    info = await lstat(artifactDir);
  } catch {
    throw new Error("release artifact directory could not be read.");
  }
  if (!info.isDirectory()) {
    throw new Error("release artifact directory must be a real directory.");
  }
  const realRoot = await realpathStrict(root, "project root");
  const realArtifactDir = await realpathStrict(artifactDir, "release artifact directory");
  if (!isPathInside(realRoot, realArtifactDir)) {
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

function verifiedTarballPath(tarball) {
  const relative = path.relative(root, tarball.path);
  if (relative !== path.join("release-artifacts", tarball.basename)) {
    throw new Error("verified release tarball path is invalid.");
  }
  return relative.split(path.sep).join("/");
}

async function writeGithubOutput(name, value) {
  if (name !== "tarball" || !/^release-artifacts\/[A-Za-z0-9._-]+\.tgz$/.test(value)) {
    throw new Error("verified release tarball output is invalid.");
  }
  const outputPath = githubOutputPath();
  if (!path.isAbsolute(outputPath)) throw new Error("GITHUB_OUTPUT must be an absolute path.");
  const info = await lstat(outputPath);
  if (!info.isFile()) throw new Error("GITHUB_OUTPUT must be a regular file.");
  if (info.size > MAX_GITHUB_OUTPUT_BYTES) throw new Error("GITHUB_OUTPUT exceeds the byte limit.");
  const handle = await open(outputPath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("GITHUB_OUTPUT must be a regular file.");
    if (!sameFile(info, opened)) throw new Error("GITHUB_OUTPUT changed before verification.");
    await handle.writeFile(`${name}=${value}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function githubOutputPath() {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, "GITHUB_OUTPUT");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length < 1 ||
    /[\p{Cc}\p{Cf}]/u.test(descriptor.value) ||
    utf8ByteLengthExceeds(descriptor.value, MAX_GITHUB_OUTPUT_BYTES)
  ) {
    throw new Error("GITHUB_OUTPUT must be a non-empty control-free path.");
  }
  return descriptor.value;
}

async function verifyChecksumFile(releaseArtifactDir, tarball, sbom) {
  const checksumFile = path.join(releaseArtifactDir, "SHA256SUMS");
  const info = await lstat(checksumFile);
  if (!info.isFile()) throw new Error("SHA256SUMS is not a regular file.");
  if (info.size < 1 || info.size > MAX_CHECKSUM_FILE_BYTES) throw new Error("SHA256SUMS size is outside the allowed range.");
  const handle = await open(checksumFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("SHA256SUMS is not a regular file.");
    if (opened.size < 1 || opened.size > MAX_CHECKSUM_FILE_BYTES) throw new Error("SHA256SUMS size is outside the allowed range.");
    if (!sameFile(info, opened)) throw new Error("SHA256SUMS changed before verification.");
    const checksumText = await readHandleText(handle, opened.size, "SHA256SUMS");
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.tgz)\n([a-f0-9]{64})  (SBOM\.cdx\.json)\n$/.exec(checksumText);
    if (!match || match[2] !== tarball.basename || match[4] !== sbom.basename) throw new Error("SHA256SUMS must contain exactly one checksum for the release tarball and one checksum for the SBOM.");
    const actualTarball = await sha256File(tarball);
    if (actualTarball !== match[1]) throw new Error("release tarball checksum does not match SHA256SUMS.");
    const actualSbom = await sha256File(sbom);
    if (actualSbom !== match[3]) throw new Error("release SBOM checksum does not match SHA256SUMS.");
  } finally {
    await handle.close();
  }
}

async function verifySbomFile(sbom, packageName, packageVersion, expectedSbom) {
  const document = parseJson(await readHandleText(sbom.handle, sbom.size, "release SBOM"), "release SBOM");
  if (!isPlainRecord(document)) throw new Error("release SBOM must be a plain JSON object.");
  if (ownValue(document, "bomFormat") !== "CycloneDX") throw new Error("release SBOM must be CycloneDX.");
  if (ownValue(document, "specVersion") !== "1.7") throw new Error("release SBOM must use CycloneDX 1.7.");
  const metadata = requiredPlainRecord(document, "metadata", "release SBOM");
  const component = requiredPlainRecord(metadata, "component", "release SBOM metadata");
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
  verifySbomProductionInventory(document, expectedSbom);
}

async function expectedProductionSbom(packageJson, packageName, packageVersion) {
  const dependencies = canonicalStringRecord(requiredPlainRecord(packageJson, "dependencies", "package.json"), "package.json dependencies");
  const lockfile = parsePnpmLockfile(await readText(path.join(root, "pnpm-lock.yaml"), MAX_LOCKFILE_BYTES));
  const packages = new Map();
  const graph = new Map();
  const directPackageKeys = [];
  const rootDependsOn = [];

  for (const name of Object.keys(dependencies).sort()) {
    const version = requiredPackageVersion(dependencies[name], "package.json dependencies");
    if (!isSupportedPackageName(name)) throw new Error("package.json dependencies contains an invalid package name.");
    const locked = lockfile.importerDependencies.get(name);
    if (!locked || locked.specifier !== version || normalizeLockVersion(locked.version) !== version) throwSbomInventoryMismatch();
    const key = lockPackageKey(name, version);
    if (!lockfile.packageKeys.has(key) || !lockfile.snapshots.has(key)) throwSbomInventoryMismatch();
    directPackageKeys.push(key);
    rootDependsOn.push(packagePurl(name, version));
  }

  const stack = [...directPackageKeys];
  while (stack.length > 0) {
    const key = stack.pop();
    if (!key) continue;
    const parsed = parseLockPackageKey(key);
    const purl = packagePurl(parsed.name, parsed.version);
    if (packages.has(purl)) continue;
    const snapshot = lockfile.snapshots.get(key);
    if (!snapshot) throwSbomInventoryMismatch();
    const dependsOn = [];
    packages.set(purl, { name: parsed.name, version: parsed.version, dependsOn });

    const snapshotDependencies = [...snapshot.dependencies, ...snapshot.optionalDependencies].sort(([left], [right]) => left.localeCompare(right));
    for (const [dependencyName, rawDependencyVersion] of snapshotDependencies) {
      const dependencyVersion = normalizeLockVersion(rawDependencyVersion);
      const dependencyKey = findLockPackageKey(lockfile, dependencyName, dependencyVersion);
      const dependencyPurl = packagePurl(dependencyName, dependencyVersion);
      dependsOn.push(dependencyPurl);
      stack.push(dependencyKey);
    }
    dependsOn.sort();
  }

  const rootPurl = packagePurl(packageName, packageVersion);
  graph.set(rootPurl, rootDependsOn.sort());
  for (const [packagePurlValue, packageEvidence] of packages) {
    graph.set(packagePurlValue, packageEvidence.dependsOn);
  }
  return { rootPurl, packages, graph };
}

function verifySbomProductionInventory(document, expected) {
  const components = ownValue(document, "components");
  const seenComponents = new Set();
  for (const component of components) {
    if (!isPlainRecord(component)) throwSbomInventoryMismatch();
    if (ownValue(component, "type") !== "library") throwSbomInventoryMismatch();
    const purl = ownValue(component, "purl");
    if (typeof purl !== "string" || ownValue(component, "bom-ref") !== purl || seenComponents.has(purl)) throwSbomInventoryMismatch();
    const expectedComponent = expected.packages.get(purl);
    if (!expectedComponent) throwSbomInventoryMismatch();
    if (ownValue(component, "name") !== packageLocalName(expectedComponent.name) || ownValue(component, "version") !== expectedComponent.version) throwSbomInventoryMismatch();
    const expectedGroup = packageGroup(expectedComponent.name);
    const group = optionalOwnValue(component, "group");
    if (expectedGroup === undefined ? group !== undefined : group !== expectedGroup) throwSbomInventoryMismatch();
    seenComponents.add(purl);
  }
  if (seenComponents.size !== expected.packages.size) throwSbomInventoryMismatch();

  const dependencies = ownValue(document, "dependencies");
  if (!Array.isArray(dependencies) || dependencies.length !== expected.graph.size) throwSbomInventoryMismatch();
  const seenRefs = new Set();
  const allowedRefs = new Set(expected.graph.keys());
  const rootDirectRefs = new Set(expected.graph.get(expected.rootPurl));
  for (const dependency of dependencies) {
    if (!isPlainRecord(dependency)) throwSbomInventoryMismatch();
    const ref = ownValue(dependency, "ref");
    if (typeof ref !== "string" || seenRefs.has(ref) || !expected.graph.has(ref)) throwSbomInventoryMismatch();
    const dependsOn = ownValue(dependency, "dependsOn");
    if (!Array.isArray(dependsOn)) throwSbomInventoryMismatch();
    const actual = canonicalSbomRefArray(dependsOn);
    if (actual.some((value) => !allowedRefs.has(value))) throwSbomInventoryMismatch();
    const expectedDependsOn = expected.graph.get(ref);
    if (!expectedDependsOn) throwSbomInventoryMismatch();
    const comparableActual = ref === expected.rootPurl ? actual : actual.filter((value) => !rootDirectRefs.has(value));
    const comparableExpected = ref === expected.rootPurl ? expectedDependsOn : expectedDependsOn.filter((value) => !rootDirectRefs.has(value));
    if (JSON.stringify(comparableActual) !== JSON.stringify(comparableExpected)) throwSbomInventoryMismatch();
    seenRefs.add(ref);
  }
  if (seenRefs.size !== expected.graph.size || !seenRefs.has(expected.rootPurl)) throwSbomInventoryMismatch();
}

function parsePnpmLockfile(text) {
  const importerDependencies = new Map();
  const packageKeys = new Set();
  const snapshots = new Map();
  let section = "";
  let inRootImporter = false;
  let inRootDependencies = false;
  let currentImporterDependency;
  let currentSnapshotKey;
  let currentSnapshotDependencyKind;

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (indent === 0) {
      if (trimmed === "importers:" || trimmed === "packages:" || trimmed === "snapshots:") section = trimmed.slice(0, -1);
      inRootImporter = false;
      inRootDependencies = false;
      currentImporterDependency = undefined;
      currentSnapshotKey = undefined;
      currentSnapshotDependencyKind = undefined;
      continue;
    }

    if (section === "importers") {
      if (indent === 2) {
        inRootImporter = yamlMappingEntry(trimmed)?.key === ".";
        inRootDependencies = false;
        currentImporterDependency = undefined;
      } else if (inRootImporter && indent === 4) {
        inRootDependencies = trimmed === "dependencies:";
        currentImporterDependency = undefined;
      } else if (inRootImporter && inRootDependencies && indent === 6) {
        const entry = yamlMappingEntry(trimmed);
        currentImporterDependency = entry?.value === "" ? entry.key : undefined;
        if (currentImporterDependency && !isSupportedPackageName(currentImporterDependency)) throwSbomInventoryMismatch();
        if (currentImporterDependency && !importerDependencies.has(currentImporterDependency)) importerDependencies.set(currentImporterDependency, {});
      } else if (inRootImporter && inRootDependencies && currentImporterDependency && indent === 8) {
        const entry = yamlMappingEntry(trimmed);
        if (entry?.key === "specifier" || entry?.key === "version") {
          importerDependencies.get(currentImporterDependency)[entry.key] = entry.value;
        }
      }
      continue;
    }

    if (section === "packages") {
      if (indent === 2) {
        const entry = yamlMappingEntry(trimmed);
        if (entry) packageKeys.add(entry.key);
      }
      continue;
    }

    if (section === "snapshots") {
      if (indent === 2) {
        const entry = yamlMappingEntry(trimmed);
        currentSnapshotKey = entry?.key;
        currentSnapshotDependencyKind = undefined;
        if (currentSnapshotKey && !snapshots.has(currentSnapshotKey)) {
          snapshots.set(currentSnapshotKey, { dependencies: new Map(), optionalDependencies: new Map() });
        }
      } else if (currentSnapshotKey && indent === 4) {
        if (trimmed === "dependencies:" || trimmed === "optionalDependencies:") {
          currentSnapshotDependencyKind = trimmed.slice(0, -1);
        } else {
          currentSnapshotDependencyKind = undefined;
        }
      } else if (currentSnapshotKey && currentSnapshotDependencyKind && indent === 6) {
        const entry = yamlMappingEntry(trimmed);
        if (!entry || !isSupportedPackageName(entry.key)) throwSbomInventoryMismatch();
        snapshots.get(currentSnapshotKey)[currentSnapshotDependencyKind].set(entry.key, entry.value);
      }
    }
  }

  if (importerDependencies.size < 1 || packageKeys.size < 1 || snapshots.size < 1) throwSbomInventoryMismatch();
  return { importerDependencies, packageKeys, snapshots };
}

function yamlMappingEntry(trimmed) {
  const colon = trimmed.indexOf(":");
  if (colon < 0) return undefined;
  return {
    key: yamlScalar(trimmed.slice(0, colon).trim()),
    value: yamlScalar(trimmed.slice(colon + 1).trim())
  };
}

function yamlScalar(value) {
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  return value;
}

function normalizeLockVersion(value) {
  if (typeof value !== "string") throwSbomInventoryMismatch();
  const version = value.split("(")[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throwSbomInventoryMismatch();
  return version;
}

function lockPackageKey(name, version) {
  return `${name}@${version}`;
}

function parseLockPackageKey(key) {
  if (typeof key !== "string") throwSbomInventoryMismatch();
  const separator = key.lastIndexOf("@");
  if (separator <= 0) throwSbomInventoryMismatch();
  const name = key.slice(0, separator);
  const version = normalizeLockVersion(key.slice(separator + 1));
  if (!isSupportedPackageName(name)) throwSbomInventoryMismatch();
  return { name, version };
}

function findLockPackageKey(lockfile, name, version) {
  const exact = lockPackageKey(name, version);
  if (lockfile.snapshots.has(exact)) return exact;
  const matches = [];
  for (const key of lockfile.snapshots.keys()) {
    const parsed = parseLockPackageKey(key);
    if (parsed.name === name && parsed.version === version) matches.push(key);
  }
  if (matches.length !== 1) throwSbomInventoryMismatch();
  return matches[0];
}

function canonicalSbomRefArray(values) {
  const out = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || seen.has(descriptor.value)) throwSbomInventoryMismatch();
    out.push(descriptor.value);
    seen.add(descriptor.value);
  }
  return out.sort();
}

function throwSbomInventoryMismatch() {
  throw new Error("release SBOM production dependency inventory does not match package.json and pnpm-lock.yaml.");
}

async function packedPackageJson(tarball) {
  const text = await extractTarGzTextFile(tarball, "package/package.json", MAX_PACKED_PACKAGE_JSON_BYTES);
  return parseJson(text, "package/package.json");
}

async function verifyPackedFileContents(tarball, expectedPackageJson) {
  const expectedFiles = await expectedPackedFileDigests(expectedPackageJson);
  const seen = new Set();
  let packedPackageText;
  const reader = tarGzReader(tarball);
  try {
    while (true) {
      const header = await reader.readBytes(TAR_BLOCK_BYTES);
      if (header.length === 0) break;
      if (header.length !== TAR_BLOCK_BYTES) throw new Error("release tarball has a truncated tar header.");
      if (isZeroBlock(header)) {
        await validateTarEnd(reader);
        break;
      }
      validateTarHeaderChecksum(header);

      const name = tarHeaderName(header);
      const size = tarHeaderSize(header);
      const type = String.fromCharCode(header[156] ?? 0);
      const paddedSize = paddedTarSize(size);
      if (type === "5" && size === 0) continue;
      if (type !== "\0" && type !== "0") throw new Error("release tarball contains an unsupported tar entry type.");
      if (seen.has(name)) throw new Error("release tarball contains duplicate package file entries.");
      seen.add(name);
      if (!expectedFiles.has(name)) throw new Error("release tarball contains an unexpected package file.");

      const body = await reader.readBytes(size);
      if (body.length !== size) throw new Error("release tarball file is truncated.");
      await reader.skipBytes(paddedSize - size);
      if (name === "package/package.json") {
        if (size < 1 || size > MAX_PACKED_PACKAGE_JSON_BYTES) throw new Error("package/package.json size is outside the allowed range.");
        packedPackageText = decodeUtf8(body, "package/package.json");
        continue;
      }
      const expectedDigest = expectedFiles.get(name);
      if (expectedDigest && sha256Bytes(body) !== expectedDigest) {
        throw new Error("release tarball file contents do not match the checked workspace.");
      }
    }
  } finally {
    await reader.close();
  }

  for (const name of expectedFiles.keys()) {
    if (!seen.has(name)) throw new Error("release tarball is missing expected package files.");
  }
  if (packedPackageText === undefined) throw new Error("release tarball does not contain package/package.json.");
  return parseJson(packedPackageText, "package/package.json");
}

async function expectedPackedFileDigests(packageJson) {
  const files = canonicalStringArray(requiredArray(packageJson, "files", "package.json"), "package.json files");
  const out = new Map([["package/package.json", undefined]]);
  const state = { totalBytes: 0 };
  for (const entry of files) {
    await collectExpectedPackedFiles(entry, out, state);
  }
  return out;
}

async function collectExpectedPackedFiles(relative, out, state) {
  const file = path.join(root, relative);
  const info = await lstat(file);
  if (info.isDirectory()) {
    const entries = await readdir(file, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await collectExpectedPackedFiles(path.posix.join(relative.split(path.sep).join("/"), packagePathEntry(entry.name, "package.json files")), out, state);
    }
    return;
  }
  if (!info.isFile()) throw new Error("package.json files contains a non-regular package file.");
  const packageName = `package/${relative.split(path.sep).join("/")}`;
  if (out.has(packageName)) throw new Error("package.json files contains duplicate package files.");
  if (out.size >= MAX_EXPECTED_PACKED_FILES) throw new Error("package.json files expands to too many package files.");
  if (state.totalBytes + info.size > MAX_EXPECTED_PACKED_BYTES) throw new Error("package.json files expands beyond the package byte limit.");
  state.totalBytes += info.size;
  out.set(packageName, await workspaceFileDigest(file, info));
}

async function workspaceFileDigest(file, info) {
  if (info.size < 1 || info.size > MAX_TARBALL_BYTES) throw new Error("package file size is outside the allowed range.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("package file is not a regular file.");
    if (opened.size < 1 || opened.size > MAX_TARBALL_BYTES) throw new Error("package file size is outside the allowed range.");
    if (!sameFile(info, opened)) throw new Error("package file changed before release verification.");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("package file changed while being read.");
    return sha256Bytes(buffer);
  } finally {
    await handle.close();
  }
}

async function extractTarGzTextFile(tarball, wantedName, maxBytes) {
  const reader = tarGzReader(tarball);
  let foundText;
  try {
    while (true) {
      const header = await reader.readBytes(TAR_BLOCK_BYTES);
      if (header.length === 0) break;
      if (header.length !== TAR_BLOCK_BYTES) throw new Error("release tarball has a truncated tar header.");
      if (isZeroBlock(header)) {
        await validateTarEnd(reader);
        break;
      }
      validateTarHeaderChecksum(header);

      const name = tarHeaderName(header);
      const size = tarHeaderSize(header);
      const type = String.fromCharCode(header[156] ?? 0);
      const paddedSize = paddedTarSize(size);

      if (name === wantedName) {
        if (foundText !== undefined) throw new Error(`release tarball contains duplicate ${wantedName} entries.`);
        if (type !== "\0" && type !== "0") throw new Error(`${wantedName} is not a regular file in the release tarball.`);
        if (size < 1 || size > maxBytes) throw new Error(`${wantedName} size is outside the allowed range.`);
        const body = await reader.readBytes(size);
        if (body.length !== size) throw new Error(`${wantedName} is truncated in the release tarball.`);
        await reader.skipBytes(paddedSize - size);
        foundText = decodeUtf8(body, wantedName);
        continue;
      }

      validateSkippableTarEntry(type, size);
      await reader.skipBytes(paddedSize);
    }
    if (foundText !== undefined) return foundText;
    throw new Error(`release tarball does not contain ${wantedName}.`);
  } finally {
    await reader.close();
  }
}

async function validateTarEnd(reader) {
  const second = await reader.readBytes(TAR_BLOCK_BYTES);
  if (second.length !== TAR_BLOCK_BYTES || !isZeroBlock(second)) {
    throw new Error("release tarball has a malformed tar end-of-archive marker.");
  }

  while (true) {
    const block = await reader.readBytes(TAR_BLOCK_BYTES);
    if (block.length === 0) return;
    if (block.length !== TAR_BLOCK_BYTES) {
      throw new Error("release tarball has truncated trailing tar padding.");
    }
    if (!isZeroBlock(block)) {
      throw new Error("release tarball contains non-zero data after tar end-of-archive.");
    }
  }
}

function tarGzReader(tarball) {
  const source = tarball.handle.createReadStream({ start: 0, end: tarball.size - 1, autoClose: false });
  const gunzip = createGunzip();
  const stream = source.pipe(gunzip);
  const chunks = stream[Symbol.asyncIterator]();
  let buffer = new Uint8Array(0);
  let decompressed = 0;

  return {
    async readBytes(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TAR_SCAN_BYTES) throw new Error("Invalid tar read length.");
      while (buffer.byteLength < length) {
        const next = await nextTarGzChunk(chunks);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new Error("release tarball yielded a non-binary gzip chunk.");
        decompressed += next.value.byteLength;
        if (decompressed > MAX_TAR_SCAN_BYTES) throw new Error("release tarball expanded beyond the scan limit.");
        buffer = concatBytes(buffer, next.value);
      }
      if (length === 0) return new Uint8Array(0);
      const out = buffer.slice(0, length);
      buffer = buffer.slice(length);
      return out;
    },
    async skipBytes(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TAR_SCAN_BYTES) throw new Error("Invalid tar skip length.");
      let remaining = length;
      if (buffer.byteLength >= remaining) {
        buffer = buffer.slice(remaining);
        return;
      }
      remaining -= buffer.byteLength;
      buffer = new Uint8Array(0);
      while (remaining > 0) {
        const next = await nextTarGzChunk(chunks);
        if (next.done) throw new Error("release tarball ended while skipping tar entry data.");
        if (!(next.value instanceof Uint8Array)) throw new Error("release tarball yielded a non-binary gzip chunk.");
        decompressed += next.value.byteLength;
        if (decompressed > MAX_TAR_SCAN_BYTES) throw new Error("release tarball expanded beyond the scan limit.");
        if (next.value.byteLength > remaining) {
          buffer = next.value.slice(remaining);
          return;
        }
        remaining -= next.value.byteLength;
      }
    },
    async close() {
      source.destroy();
      gunzip.destroy();
      await chunks.return?.();
    }
  };
}

async function nextTarGzChunk(chunks) {
  try {
    return await chunks.next();
  } catch {
    throw new Error("release tarball is not a valid gzip archive.");
  }
}

function tarHeaderName(header) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  if (fullName.length < 1 || /[\p{Cc}\p{Cf}]/u.test(fullName) || fullName.includes("\0") || fullName.includes("..") || fullName.includes("\\") || fullName.includes(":") || path.isAbsolute(fullName)) {
    throw new Error("release tarball contains an unsafe tar entry name.");
  }
  return fullName;
}

function validateTarHeaderChecksum(header) {
  const raw = tarString(header, 148, 8).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error("release tarball contains an invalid tar header checksum.");
  const expected = Number.parseInt(raw, 8);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("release tarball contains an invalid tar header checksum.");
}

function validateSkippableTarEntry(type, size) {
  if (type === "\0" || type === "0") return;
  if (type === "5" && size === 0) return;
  throw new Error("release tarball contains an unsupported tar entry type.");
}

function tarHeaderSize(header) {
  const raw = tarString(header, 124, 12).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error("release tarball contains an invalid tar entry size.");
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_SCAN_BYTES) throw new Error("release tarball contains an oversized tar entry.");
  return size;
}

function tarString(header, offset, length) {
  const slice = header.slice(offset, offset + length);
  const nul = slice.indexOf(0);
  const bytes = nul === -1 ? slice : slice.slice(0, nul);
  return decodeUtf8(bytes, "tar header");
}

function paddedTarSize(size) {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function concatBytes(left, right) {
  if (left.byteLength === 0) return right;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(tarball) {
  const hash = createHash("sha256");
  const scratch = Buffer.alloc(64 * 1024);
  let total = 0;
  while (total < tarball.size) {
    const { bytesRead } = await tarball.handle.read(scratch, 0, Math.min(scratch.byteLength, tarball.size - total), total);
    if (bytesRead === 0) break;
    hash.update(scratch.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total !== tarball.size) throw new Error(`${tarball.label ?? "release tarball"} changed while being read.`);
  const opened = await tarball.handle.stat();
  if (opened.size !== tarball.size) throw new Error(`${tarball.label ?? "release tarball"} changed while being read.`);
  return hash.digest("hex");
}

async function readHandleText(handle, size, label) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error(`${label} changed while being read.`);
  const opened = await handle.stat();
  if (opened.size !== size) throw new Error(`${label} changed while being read.`);
  return decodeUtf8(buffer, label);
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function readText(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`${path.relative(root, file)} is not a regular file.`);
  if (info.size < 1 || info.size > maxBytes) throw new Error(`${path.relative(root, file)} size is outside the allowed range.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path.relative(root, file)} is not a regular file.`);
    if (opened.size < 1 || opened.size > maxBytes) throw new Error(`${path.relative(root, file)} size is outside the allowed range.`);
    if (!sameFile(info, opened)) throw new Error(`${path.relative(root, file)} changed before verification.`);
    return await readHandleText(handle, opened.size, path.relative(root, file));
  } finally {
    await handle.close();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
