import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CHUNK_SIZE, MAX_FILE_BYTES, MAX_FILES_PER_SESSION, MAX_OUTPUT_NAME_ATTEMPTS } from "../shared/constants.js";
import { basename } from "../shared/format.js";
import { createSha256, digestHex, type Sha256 } from "../shared/hash.js";
import { SAFE_FILE_NAME_BYTES, assertFileWithinLimits, assertTransferManifestWithinLimits, safeCollisionFileName, safeFileName } from "../shared/limits.js";
import type { FileManifest, FileManifestEntry } from "../shared/messages.js";

const PART_FILE_SUFFIX = ".part";
const PART_FILE_TOKEN_HEX_CHARS = 32;
const PART_FILE_RANDOM_SUFFIX_BYTES = ".ff-".length + PART_FILE_TOKEN_HEX_CHARS + PART_FILE_SUFFIX.length;
const SAFE_PART_BASE_NAME_BYTES = SAFE_FILE_NAME_BYTES - PART_FILE_RANDOM_SUFFIX_BYTES;
const SAFE_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const MAX_SEND_PATH_BYTES = 4096;
const MAX_OUTPUT_DIR_BYTES = 4096;
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
  resumeBytes?: number;
  resumeHash?: Sha256;
};

type FileSnapshot = {
  dev: number;
  ino: number;
  size: number;
};

export async function buildManifest(paths: string[]): Promise<{ files: SendFile[]; manifest: FileManifest }> {
  const inputs = sendPathInputs(paths);

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

function sendPathInputs(paths: string[]): string[] {
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

export async function ensureOutputDir(dir: string): Promise<string> {
  const resolved = path.resolve(outputDirInput(dir));
  await fs.promises.mkdir(resolved, { recursive: true });
  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Output path is not a directory.");
  return fs.promises.realpath(resolved);
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

export async function reserveOutputFile(dir: string, name: string, options?: { resume?: boolean; size?: number }): Promise<ReservedOutputFile> {
  const outputDir = path.resolve(outputDirInput(dir));
  const safeName = safeFileName(name);
  for (let i = 0; i < MAX_OUTPUT_NAME_ATTEMPTS; i += 1) {
    const candidateName = safeCollisionFileName(safeName, i);
    const finalPath = path.join(outputDir, candidateName);
    try {
      await fs.promises.lstat(finalPath);
      continue;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    if (options?.resume) {
      if (!Number.isSafeInteger(options.size) || typeof options.size !== "number" || options.size < 0 || options.size > MAX_FILE_BYTES) throw new Error("Resume file size is invalid.");
      const partPath = path.join(outputDir, resumablePartFileName(candidateName));
      try {
        return await reserveExistingResumablePart(finalPath, partPath, options.size);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      try {
        return await createOutputPart(finalPath, partPath);
      } catch (error) {
        if (isNodeErrorCode(error, "EEXIST")) continue;
        throw error;
      }
    }
    const partPath = path.join(outputDir, randomPartFileName(candidateName));
    try {
      return await createOutputPart(finalPath, partPath);
    } catch (error) {
      if (isNodeErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error(`Could not reserve an output name for ${safeName} after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts.`);
}

async function createOutputPart(finalPath: string, partPath: string): Promise<ReservedOutputFile> {
  const handle = await fs.promises.open(partPath, "wx", 0o600);
  const stat = await handle.stat();
  return { finalPath, partPath, handle, dev: stat.dev, ino: stat.ino };
}

async function reserveExistingResumablePart(finalPath: string, partPath: string, expectedSize: number): Promise<ReservedOutputFile> {
  const handle = await fs.promises.open(partPath, RESUME_PART_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Resume partial path is not a file.");
    let resumeBytes = Math.min(stat.size, expectedSize);
    if (resumeBytes < expectedSize) resumeBytes -= resumeBytes % CHUNK_SIZE;
    if (resumeBytes < 0) resumeBytes = 0;
    if (resumeBytes !== stat.size) await handle.truncate(resumeBytes);
    const resumeHash = await hashOpenFilePrefix(handle, resumeBytes);
    return { finalPath, partPath, handle, dev: stat.dev, ino: stat.ino, resumeBytes, resumeHash };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function randomPartFileName(finalName: string): string {
  const partBase = safeFileName(finalName, SAFE_PART_BASE_NAME_BYTES);
  return `${partBase}.ff-${randomBytes(PART_FILE_TOKEN_HEX_CHARS / 2).toString("hex")}${PART_FILE_SUFFIX}`;
}

function resumablePartFileName(finalName: string): string {
  const partBase = safeFileName(finalName, SAFE_PART_BASE_NAME_BYTES);
  return `${partBase}.ff-resume${PART_FILE_SUFFIX}`;
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
