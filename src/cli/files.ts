import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { CHUNK_SIZE, MAX_FILE_BYTES, MAX_FILES_PER_SESSION, MAX_OUTPUT_NAME_ATTEMPTS } from "../shared/constants.js";
import { basename } from "../shared/format.js";
import { createSha256, digestHex, type Sha256 } from "../shared/hash.js";
import { assertFileWithinLimits, assertTransferManifestWithinLimits, safeCollisionFileName, safeFileName } from "../shared/limits.js";
import type { FileManifest, FileManifestEntry } from "../shared/messages.js";

const PART_FILE_SUFFIX = ".part";
const PART_FILE_TOKEN_HEX_CHARS = 32;
const RESUME_SECRET_FILE = ".ff-resume-key";
const RESUME_SECRET_BYTES = 32;
const SAFE_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const SAFE_SECRET_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const SAFE_PART_CREATE_FLAGS = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const SAFE_SECRET_CREATE_FLAGS = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const MAX_SEND_PATH_BYTES = 4096;
const MAX_OUTPUT_DIR_BYTES = 4096;
const MAX_CLEANUP_QUARANTINE_ATTEMPTS = 16;
const UNSAFE_SEND_PATH_CHARS = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_OUTPUT_DIR_CHARS = /[\p{Cc}\p{Cf}]/u;

export type SendFile = FileManifestEntry & {
  id: number;
  path: string;
  handle: fs.promises.FileHandle;
  sha256?: string;
  chunkSha256?: string[];
};

export type ReservedOutputFile = {
  finalPath: string;
  partPath: string;
  handle: fs.promises.FileHandle;
  dev: number;
  ino: number;
  dirDev: number;
  dirIno: number;
  resumeBytes?: number;
  resumeHash?: Sha256;
};

type EnsureOutputDirOptions = {
  private?: boolean;
};

type ReserveOutputFileOptions = {
  resume?: boolean;
  size?: number;
  opaqueName?: boolean;
  privateOutputDir?: boolean;
};

type FileSnapshot = {
  dev: number;
  ino: number;
  size: number;
};

type FileIdentity = {
  dev: number;
  ino: number;
};

export async function buildManifest(paths: string[]): Promise<{ files: SendFile[]; manifest: FileManifest }> {
  const inputs = validateSendPathInputs(paths);

  const files: SendFile[] = [];
  let totalBytes = 0;
  try {
    for (const input of inputs) {
      const filePath = path.resolve(input);
      const linkStat = await fs.promises.lstat(filePath);
      if (linkStat.isSymbolicLink()) throw new Error("Selected file is a symbolic link. Refusing to follow links; send the real file path explicitly.");
      if (!linkStat.isFile()) throw new Error("Selected path is not a file. Folders are not supported; archive first.");
      if (linkStat.size > MAX_FILE_BYTES) throw new Error("Selected file exceeds the 1 GiB per-file limit.");
      const handle = await fs.promises.open(filePath, SAFE_READ_FLAGS);
      try {
        const stat = await handle.stat();
        if (stat.size > MAX_FILE_BYTES) {
          throw new Error("Selected file exceeds the 1 GiB per-file limit.");
        }
        if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
          throw new Error("Selected file changed while preparing the transfer.");
        }
        const snapshot = fileSnapshot(stat);
        const name = basename(filePath);
        assertFileWithinLimits(name, snapshot.size);
        const { sha256, chunkSha256 } = await hashFileHandle(handle, snapshot);
        totalBytes += snapshot.size;
        files.push({ id: files.length, name, size: snapshot.size, path: filePath, handle, sha256, chunkSha256 });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
  } catch (error) {
    await closeSendFiles(files);
    throw error;
  }

  const manifest: FileManifest = {
    files: files.map(({ id, name, size, mime }) => (mime === undefined ? { id, name, size } : { id, name, size, mime })),
    fileCount: files.length,
    totalBytes
  };
  assertTransferManifestWithinLimits(manifest);
  return { files, manifest };
}

export function validateSendPathInputs(paths: string[]): string[] {
  if (!Array.isArray(paths)) throw new Error("File list is invalid.");
  if (paths.length === 0) throw new Error("Provide at least one file.");
  if (paths.length > MAX_FILES_PER_SESSION) throw new Error(`Too many files. Limit is ${MAX_FILES_PER_SESSION}.`);

  const inputs: string[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error("File path is invalid.");
    }
    inputs.push(sendPathInput(descriptor.value));
  }
  return inputs;
}

function sendPathInput(input: string): string {
  if (input.trim().length === 0) throw new Error("File path is required.");
  if (utf8ByteLengthExceeds(input, MAX_SEND_PATH_BYTES)) throw new Error("File path is too long.");
  if (UNSAFE_SEND_PATH_CHARS.test(input)) throw new Error("File path must not contain control or format characters.");
  return input;
}

export async function closeSendFiles(files: SendFile[]): Promise<void> {
  if (!Array.isArray(files)) return;
  const closes: Promise<unknown>[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    const close = sendFileCloseOperation(descriptor.value);
    if (close) closes.push(close);
  }
  await Promise.allSettled(closes);
}

function sendFileCloseOperation(file: unknown): Promise<unknown> | undefined {
  if (!file || typeof file !== "object") return undefined;
  const handle = ownDataValue(file, "handle");
  if (!handle || typeof handle !== "object") return undefined;
  const close = ownDataValue(handle, "close");
  if (typeof close !== "function") return undefined;
  return Promise.resolve().then(() => close.call(handle));
}

export async function ensureOutputDir(dir: string, options?: EnsureOutputDirOptions): Promise<string> {
  if (options?.private) assertPrivateOutputDirSupported(process.platform);
  const resolved = path.resolve(outputDirInput(dir));
  await fs.promises.mkdir(resolved, { recursive: true, mode: options?.private ? 0o700 : undefined });
  const stat = await outputDirectoryStat(resolved, options?.private ? { privateOutputDir: true } : undefined);
  if (!stat.isDirectory()) throw new Error("Output path is not a directory.");
  return fs.promises.realpath(resolved);
}

function assertPrivateOutputDirStat(stat: fs.Stats): void {
  if (process.platform === "win32") return;
  assertOwnedByCurrentUser(stat, "Output directory");
  if ((stat.mode & 0o077) !== 0) throw new Error("Output directory is not private.");
}

function outputDirInput(dir: unknown): string {
  if (typeof dir !== "string") throw new Error("Output directory is invalid.");
  if (dir.trim().length === 0) throw new Error("Output directory is required.");
  if (utf8ByteLengthExceeds(dir, MAX_OUTPUT_DIR_BYTES)) throw new Error("Output directory path is too long.");
  if (UNSAFE_OUTPUT_DIR_CHARS.test(dir)) throw new Error("Output directory must not contain control or format characters.");
  return dir;
}

function utf8ByteLengthExceeds(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
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
    if (bytes > maxBytes) return true;
  }
  return false;
}

export async function reserveOutputFile(dir: string, name: string, options?: ReserveOutputFileOptions): Promise<ReservedOutputFile> {
  const outputDir = path.resolve(outputDirInput(dir));
  const outputDirIdentity = await directoryIdentity(outputDir, options);
  const resume = Boolean(options?.resume);
  if (resume) assertCliResumeSupported(process.platform);
  const resumeSize = resume ? resumeFileSize(options?.size) : undefined;
  const safeName = options?.opaqueName ? await opaqueOutputFileName(outputDir, name, resumeSize) : safeFileName(name);
  for (let i = 0; i < MAX_OUTPUT_NAME_ATTEMPTS; i += 1) {
    await assertDirectoryIdentity(outputDir, outputDirIdentity, options);
    const candidateName = safeCollisionFileName(safeName, i);
    const finalPath = path.join(outputDir, candidateName);
    try {
      await fs.promises.lstat(finalPath);
      continue;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    if (resume) {
      if (resumeSize === undefined) throw new Error("Resume file size is invalid.");
      const partPath = path.join(outputDir, await resumablePartFileName(outputDir, candidateName, resumeSize));
      try {
        return await reserveExistingResumablePart(finalPath, partPath, outputDir, outputDirIdentity, resumeSize, options);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      try {
        return await createOutputPart(finalPath, partPath, outputDir, outputDirIdentity, options);
      } catch (error) {
        if (isNodeErrorCode(error, "EEXIST")) continue;
        throw error;
      }
    }
    const partPath = path.join(outputDir, randomPartFileName());
    try {
      return await createOutputPart(finalPath, partPath, outputDir, outputDirIdentity, options);
    } catch (error) {
      if (isNodeErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error(`Could not reserve an output name for ${safeName} after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts.`);
}

function resumeFileSize(size: unknown): number {
  if (!Number.isSafeInteger(size) || typeof size !== "number" || size < 0 || size > MAX_FILE_BYTES) throw new Error("Resume file size is invalid.");
  return size;
}

async function createOutputPart(finalPath: string, partPath: string, outputDir: string, outputDirIdentity: FileIdentity, options?: ReserveOutputFileOptions): Promise<ReservedOutputFile> {
  await assertDirectoryIdentity(outputDir, outputDirIdentity, options);
  const handle = await fs.promises.open(partPath, SAFE_PART_CREATE_FLAGS, 0o600);
  let stat: fs.Stats | undefined;
  try {
    stat = await handle.stat();
    await assertDirectoryIdentity(outputDir, outputDirIdentity, options);
    return { finalPath, partPath, handle, dev: stat.dev, ino: stat.ino, dirDev: outputDirIdentity.dev, dirIno: outputDirIdentity.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    if (stat) await removePathIfIdentity(partPath, stat).catch(() => {});
    throw error;
  }
}

async function reserveExistingResumablePart(finalPath: string, partPath: string, outputDir: string, outputDirIdentity: FileIdentity, expectedSize: number, options?: ReserveOutputFileOptions): Promise<ReservedOutputFile> {
  await assertDirectoryIdentity(outputDir, outputDirIdentity, options);
  const handle = await fs.promises.open(partPath, RESUME_PART_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Resume partial path is not a file.");
    assertSingleLink(stat, "Resume partial");
    assertPrivatePartialStat(stat);
    await assertDirectoryIdentity(outputDir, outputDirIdentity, options);
    let resumeBytes = Math.min(stat.size, expectedSize);
    if (resumeBytes < expectedSize) resumeBytes -= resumeBytes % CHUNK_SIZE;
    if (resumeBytes < 0) resumeBytes = 0;
    if (resumeBytes !== stat.size) await handle.truncate(resumeBytes);
    const resumeHash = await hashOpenFilePrefix(handle, resumeBytes);
    return { finalPath, partPath, handle, dev: stat.dev, ino: stat.ino, dirDev: outputDirIdentity.dev, dirIno: outputDirIdentity.ino, resumeBytes, resumeHash };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export function assertSingleLink(stat: fs.Stats, label: string): void {
  if (stat.nlink !== 1) throw new Error(`${label} has multiple hard links.`);
}

export function assertPrivatePartialStat(stat: fs.Stats): void {
  if (process.platform === "win32") return;
  assertOwnedByCurrentUser(stat, "Resume partial");
  if ((stat.mode & 0o077) !== 0) throw new Error("Resume partial is not private.");
}

export function assertCliResumeSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") throw new Error("CLI resume is disabled on Windows until private ACL checks are implemented.");
}

export function assertPrivateOutputDirSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") throw new Error("Private receive output directories are disabled on Windows until private ACL checks are implemented.");
}

async function directoryIdentity(dir: string, options?: ReserveOutputFileOptions): Promise<FileIdentity> {
  const stat = await outputDirectoryStat(dir, options);
  if (!stat.isDirectory()) throw new Error("Output path is not a directory.");
  return { dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(dir: string, expected: FileIdentity, options?: ReserveOutputFileOptions): Promise<void> {
  const stat = await outputDirectoryStat(dir, options);
  if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("Output directory changed during reservation.");
}

async function removePathIfIdentity(filePath: string, expected: FileIdentity): Promise<void> {
  await quarantineRemovePathIfIdentity(filePath, (stat) => sameFileIdentity(stat, expected));
}

async function quarantineRemovePathIfIdentity(filePath: string, matchesExpected: (stat: fs.Stats) => boolean): Promise<void> {
  for (let attempt = 0; attempt < MAX_CLEANUP_QUARANTINE_ATTEMPTS; attempt += 1) {
    const quarantinePath = cleanupQuarantinePath(filePath);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!matchesExpected(stat)) return;
      await fs.promises.rename(filePath, quarantinePath);
      const quarantined = await fs.promises.lstat(quarantinePath);
      if (!matchesExpected(quarantined)) throw new Error("Cleanup target changed before removal.");
      await fs.promises.rm(quarantinePath, { force: true });
      return;
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return;
      if (isNodeErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error("Could not reserve a cleanup quarantine path.");
}

function cleanupQuarantinePath(filePath: string): string {
  return path.join(path.dirname(filePath), `.ff-delete-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
}

function sameFileIdentity(stat: fs.Stats, expected: FileIdentity): boolean {
  return stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function randomPartFileName(): string {
  return `ff-${randomBytes(PART_FILE_TOKEN_HEX_CHARS / 2).toString("hex")}${PART_FILE_SUFFIX}`;
}

async function opaqueOutputFileName(outputDir: string, name: string, size: number | undefined): Promise<string> {
  safeFileName(name);
  if (size === undefined) return `ff-${randomBytes(PART_FILE_TOKEN_HEX_CHARS / 2).toString("hex")}`;
  const secret = await readOrCreateResumeSecret(outputDir);
  try {
    const digest = createHmac("sha256", secret).update("ff-output-v1\0").update(name).update("\0").update(String(size)).digest("hex").slice(0, PART_FILE_TOKEN_HEX_CHARS);
    return `ff-${digest}`;
  } finally {
    secret.fill(0);
  }
}

async function resumablePartFileName(outputDir: string, finalName: string, size: number): Promise<string> {
  const secret = await readOrCreateResumeSecret(outputDir);
  try {
    const digest = createHmac("sha256", secret).update("ff-resume-v1\0").update(finalName).update("\0").update(String(size)).digest("hex");
    return `ff-resume-${digest}${PART_FILE_SUFFIX}`;
  } finally {
    secret.fill(0);
  }
}

async function readOrCreateResumeSecret(outputDir: string): Promise<Buffer> {
  const secretPath = path.join(outputDir, RESUME_SECRET_FILE);
  try {
    return await readResumeSecret(secretPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  const secret = randomBytes(RESUME_SECRET_BYTES);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(secretPath, SAFE_SECRET_CREATE_FLAGS, 0o600);
    await handle.writeFile(secret);
    assertResumeSecretStat(await handle.stat());
    return Buffer.from(secret);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) return readResumeSecret(secretPath);
    throw error;
  } finally {
    secret.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function readResumeSecret(secretPath: string): Promise<Buffer> {
  const handle = await fs.promises.open(secretPath, SAFE_SECRET_READ_FLAGS);
  try {
    assertResumeSecretStat(await handle.stat());
    const secret = Buffer.alloc(RESUME_SECRET_BYTES);
    const { bytesRead } = await handle.read(secret, 0, secret.byteLength, 0);
    if (bytesRead !== secret.byteLength) throw new Error("Resume secret is invalid.");
    return secret;
  } catch (error) {
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

function assertResumeSecretStat(stat: fs.Stats): void {
  if (!stat.isFile() || stat.size !== RESUME_SECRET_BYTES) throw new Error("Resume secret is invalid.");
  assertSingleLink(stat, "Resume secret");
  if (process.platform !== "win32") {
    assertOwnedByCurrentUser(stat, "Resume secret");
    if ((stat.mode & 0o077) !== 0) throw new Error("Resume secret is not private.");
  }
}

async function outputDirectoryStat(dir: string, options?: ReserveOutputFileOptions): Promise<fs.Stats> {
  if (options?.privateOutputDir) assertPrivateOutputDirSupported(process.platform);
  if (options?.privateOutputDir) {
    const linkStat = await fs.promises.lstat(dir);
    if (linkStat.isSymbolicLink()) throw new Error("Output directory must not be a symbolic link in private mode.");
  }
  const stat = await fs.promises.stat(dir);
  if (options?.privateOutputDir) {
    assertPrivateOutputDirStat(stat);
    await assertPrivateOutputParent(dir);
  }
  return stat;
}

async function assertPrivateOutputParent(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const parent = path.dirname(dir);
  if (parent === dir) return;
  const stat = await fs.promises.stat(parent);
  if (!stat.isDirectory()) throw new Error("Output directory parent is invalid.");
  const groupOrOtherWritable = (stat.mode & 0o022) !== 0;
  const sticky = (stat.mode & 0o1000) !== 0;
  if (groupOrOtherWritable && !sticky) throw new Error("Output directory parent is not private.");
  if (sticky) assertOwnedByCurrentUserOrRoot(stat, "Output directory parent");
  else assertOwnedByCurrentUser(stat, "Output directory parent");
}

function assertOwnedByCurrentUser(stat: fs.Stats, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (uid !== 0 && stat.uid !== uid) throw new Error(`${label} is not owned by the current user.`);
}

function assertOwnedByCurrentUserOrRoot(stat: fs.Stats, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (uid !== 0 && stat.uid !== uid && stat.uid !== 0) throw new Error(`${label} is not owned by a trusted user.`);
}

export function isMissingPathError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return !!descriptor && "value" in descriptor && descriptor.value === code;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function hashFileHandle(handle: fs.promises.FileHandle, expected: FileSnapshot): Promise<{ sha256: string; chunkSha256: string[] }> {
  const hash = createSha256();
  const chunkSha256: string[] = [];
  let bytesRead = 0;
  for await (const chunk of handle.createReadStream({ start: 0, highWaterMark: CHUNK_SIZE, autoClose: false })) {
    const payload = fileStreamChunkBytes(chunk);
    const chunkHash = createSha256();
    try {
      if (bytesRead + payload.byteLength > expected.size) throw new Error("Selected file changed while preparing the transfer.");
      hash.update(payload);
      chunkHash.update(payload);
      chunkSha256.push(digestHex(chunkHash));
      bytesRead += payload.byteLength;
    } finally {
      payload.fill(0);
    }
  }
  if (bytesRead !== expected.size) throw new Error("Selected file changed while preparing the transfer.");
  const afterHashStat = await handle.stat();
  if (!sameFileSnapshot(afterHashStat, expected)) throw new Error("Selected file changed while preparing the transfer.");
  return { sha256: digestHex(hash), chunkSha256 };
}

const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get;
const RESUME_PART_FLAGS = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function fileStreamChunkBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer && Object.getPrototypeOf(data) === ArrayBuffer.prototype) return new Uint8Array(data);
  if (data instanceof Uint8Array && isCanonicalFileStreamBytes(data)) return data;
  throw new Error("Unsupported file stream chunk type");
}

function isCanonicalFileStreamBytes(data: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return false;
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(data);
  return Number.isSafeInteger(byteLength) && byteLength >= 0;
}

function fileSnapshot(stat: fs.Stats): FileSnapshot {
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameFileSnapshot(stat: fs.Stats, expected: FileSnapshot): boolean {
  return stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size;
}

async function hashOpenFilePrefix(handle: fs.promises.FileHandle, bytes: number): Promise<Sha256> {
  const hash = createSha256();
  if (bytes === 0) return hash;
  let bytesRead = 0;
  for await (const chunk of handle.createReadStream({ start: 0, end: bytes - 1, autoClose: false })) {
    const payload = fileStreamChunkBytes(chunk);
    try {
      if (bytesRead + payload.byteLength > bytes) throw new Error("Resume partial size changed while hashing.");
      hash.update(payload);
      bytesRead += payload.byteLength;
    } finally {
      payload.fill(0);
    }
  }
  if (bytesRead !== bytes) throw new Error("Resume partial size changed while hashing.");
  return hash;
}
