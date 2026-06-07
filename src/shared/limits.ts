import { MAX_FILE_BYTES, MAX_FILE_NAME_CHARS, MAX_FILES_PER_SESSION, MAX_MIME_CHARS, MAX_OUTPUT_NAME_ATTEMPTS } from "./constants.js";
import type { FileManifest } from "./messages.js";

export const SAFE_FILE_NAME_BYTES = 200;
const SAFE_EXTENSION_BYTES = 32;
const MAX_SAFE_FILE_NAME_INPUT_CHARS = 4096;
const UNSAFE_MANIFEST_FILE_NAME_CHARS = /[\p{Cc}\p{Cf}/\\]/u;
const UNSAFE_PORTABLE_FILE_NAME_CHARS = /[\p{Cc}\p{Cf}<>:"|?*]/gu;
const MIME_TYPE_VALUE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function assertManifestWithinLimits(manifest: FileManifest): void {
  if (!isPlainRecord(manifest)) throw new Error("Manifest is invalid.");
  if (!hasOnlyKeys(manifest, ["files", "fileCount", "totalBytes"])) throw new Error("Manifest is invalid.");
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const expectedTotalBytes = ownDataValue(manifest, "totalBytes");
  if (!Array.isArray(files)) throw new Error("Manifest file list is invalid.");
  if (typeof fileCount !== "number" || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > MAX_FILES_PER_SESSION) {
    throw new Error(`File count must be between 1 and ${MAX_FILES_PER_SESSION}.`);
  }
  if (files.length !== fileCount) throw new Error("Manifest file count does not match file list.");
  if (typeof expectedTotalBytes !== "number" || !Number.isSafeInteger(expectedTotalBytes) || expectedTotalBytes < 0) throw new Error("Manifest total size is invalid.");
  const ids = new Set<number>();
  let total = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = ownArrayDataValue(files, index);
    if (!isPlainRecord(file) || !hasOnlyKeys(file, ["id", "name", "size", "mime"])) throw new Error("Manifest file entry is invalid.");
    const id = ownDataValue(file, "id");
    const name = ownDataValue(file, "name");
    const size = ownDataValue(file, "size");
    const mime = ownDataValue(file, "mime");
    if (id !== undefined) {
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 255) throw new Error("Manifest file id is invalid.");
      if (ids.has(id)) throw new Error(`Duplicate file id ${id} in manifest.`);
      ids.add(id);
    }
    assertFileWithinLimits(name as string, size as number);
    assertMimeWithinLimits(mime as string | undefined);
    const next = total + (size as number);
    if (!Number.isSafeInteger(next)) throw new Error("Manifest total size is invalid.");
    total = next;
  }
  if (total !== expectedTotalBytes) throw new Error("Manifest total size does not match file list.");
}

export function assertTransferManifestWithinLimits(manifest: FileManifest): void {
  assertManifestWithinLimits(manifest);
  const files = ownDataValue(manifest, "files");
  if (!Array.isArray(files)) throw new Error("Manifest file list is invalid.");
  for (let index = 0; index < files.length; index += 1) {
    const file = ownArrayDataValue(files, index);
    const id = ownDataValue(file, "id");
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 255) throw new Error("Transfer manifest file id is required.");
    if (id !== index) throw new Error("Transfer manifest file ids must be canonical and sequential.");
  }
}

export function assertFileWithinLimits(name: string, size: number): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_FILE_NAME_CHARS ||
    name.trim().length === 0 ||
    name === "." ||
    name === ".." ||
    UNSAFE_MANIFEST_FILE_NAME_CHARS.test(name) ||
    safeFileName(name) !== name
  ) {
    throw new Error("File name is invalid.");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
    throw new Error("File exceeds the 1 GiB per-file limit.");
  }
}

export function assertMimeWithinLimits(mime: string | undefined): void {
  if (mime === undefined) return;
  if (typeof mime !== "string" || mime.length === 0 || mime.length > MAX_MIME_CHARS || !MIME_TYPE_VALUE.test(mime)) {
    throw new Error("Manifest MIME type is invalid.");
  }
}

export function safeFileName(name: unknown, maxBytes = SAFE_FILE_NAME_BYTES): string {
  assertSafeFileNameMaxBytes(maxBytes);
  if (typeof name !== "string") throw new Error("File name is invalid.");
  const leaf = leafName(name);
  const cleaned = leaf.replace(UNSAFE_PORTABLE_FILE_NAME_CHARS, "").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  const visible = cleaned.startsWith(".") ? `_${cleaned.slice(1)}` : cleaned;
  const safe = isWindowsReservedName(visible) ? `_${visible}` : visible;
  return utf8ByteLength(safe) > maxBytes ? trimLongFileName(safe, maxBytes) : safe;
}

function leafName(name: string): string {
  let end = name.length;
  while (end > 0 && isPathSeparator(name.charCodeAt(end - 1))) end -= 1;
  if (end === 0) return "file";
  const min = Math.max(0, end - MAX_SAFE_FILE_NAME_INPUT_CHARS);
  let start = min;
  for (let index = end - 1; index >= min; index -= 1) {
    if (isPathSeparator(name.charCodeAt(index))) {
      start = index + 1;
      break;
    }
  }
  return name.slice(start, end);
}

function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92;
}

export function safeCollisionFileName(safeName: unknown, index: number, maxBytes = SAFE_FILE_NAME_BYTES): string {
  assertSafeFileNameMaxBytes(maxBytes);
  if (typeof safeName !== "string") throw new Error("Safe file name is invalid.");
  if (index === 0) {
    if (utf8ByteLength(safeName) > maxBytes) throw new Error("Safe file name exceeds maximum byte length.");
    return safeName;
  }
  if (!Number.isInteger(index) || index < 1 || index >= MAX_OUTPUT_NAME_ATTEMPTS) throw new Error("Collision index is invalid.");
  const suffix = ` (${index})`;
  const dot = safeName.lastIndexOf(".");
  if (dot > 0 && dot < safeName.length - 1) {
    const ext = trimToUtf8Bytes(safeName.slice(dot), Math.min(SAFE_EXTENSION_BYTES, Math.max(0, maxBytes - utf8ByteLength(suffix) - 1)));
    const base = trimToUtf8Bytes(safeName.slice(0, dot), Math.max(1, maxBytes - utf8ByteLength(suffix) - utf8ByteLength(ext)));
    return `${base}${suffix}${ext}`;
  }
  return `${trimToUtf8Bytes(safeName, Math.max(1, maxBytes - utf8ByteLength(suffix)))}${suffix}`;
}

function isWindowsReservedName(name: string): boolean {
  let dot = name.length;
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) === 46) {
      dot = index;
      break;
    }
  }
  let end = dot;
  while (end > 0) {
    const code = name.charCodeAt(end - 1);
    if (code !== 46 && code !== 32) break;
    end -= 1;
  }
  if (end === 0) return false;
  const base = name.slice(0, end).toLowerCase();
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && hasOnlyDataProperties(value);
}

function hasOnlyDataProperties(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function ownArrayDataValue(value: unknown[], index: number): unknown | undefined {
  return ownDataValue(value, String(index));
}

function ownDataValue(value: unknown, key: string): unknown | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function trimLongFileName(name: string, maxBytes: number): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = trimToUtf8Bytes(name.slice(dot), Math.min(SAFE_EXTENSION_BYTES, Math.max(0, maxBytes - 1)));
    return `${trimToUtf8Bytes(name.slice(0, dot), maxBytes - utf8ByteLength(ext))}${ext}`;
  }
  return trimToUtf8Bytes(name, maxBytes);
}

function assertSafeFileNameMaxBytes(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 16 || maxBytes > SAFE_FILE_NAME_BYTES) throw new Error("Safe file name byte limit is invalid.");
}

function trimToUtf8Bytes(value: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const length = utf8ByteLength(char);
    if (bytes + length > maxBytes) break;
    out += char;
    bytes += length;
  }
  return out;
}

function utf8ByteLength(value: string): number {
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
  }
  return bytes;
}
