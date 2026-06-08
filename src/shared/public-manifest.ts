import { MAX_FILE_BYTES, MAX_FILES_PER_SESSION } from "./constants.js";
import type { FileManifest } from "./messages.js";

const FILE_COUNT_BUCKETS = Object.freeze([1, 2, 4, 8, 16, 32, 64, MAX_FILES_PER_SESSION]);
const MAX_PUBLIC_TOTAL_BYTES = MAX_FILE_BYTES * MAX_FILES_PER_SESSION;

export function redactManifestForSignaling(manifest: FileManifest): FileManifest {
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (
    !Array.isArray(files) ||
    typeof fileCount !== "number" ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 1 ||
    fileCount > MAX_FILES_PER_SESSION ||
    files.length !== fileCount ||
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    totalBytes > MAX_PUBLIC_TOTAL_BYTES
  ) {
    throw new Error("Manifest is invalid.");
  }

  let actualTotalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Manifest file entry is invalid.");
    const size = ownDataValue(descriptor.value, "size");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("Manifest file size is invalid.");
    actualTotalBytes += size;
    if (!Number.isSafeInteger(actualTotalBytes)) throw new Error("Manifest total size is invalid.");
  }
  if (actualTotalBytes !== totalBytes) throw new Error("Manifest is invalid.");

  const publicFileCount = publicFileCountBucket(fileCount);
  const publicTotalBytes = publicTotalBytesBucket(totalBytes, publicFileCount);
  return bucketedPublicManifest(publicFileCount, publicTotalBytes);
}

export function publicPairRequestManifestIsRedacted(manifest: FileManifest): boolean {
  if (!hasOnlyOwnDataKeys(manifest, ["files", "fileCount", "totalBytes"])) return false;
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (
    typeof fileCount !== "number" ||
    !Array.isArray(files) ||
    !isPublicFileCountBucket(fileCount) ||
    files.length !== fileCount ||
    typeof totalBytes !== "number" ||
    !isPublicTotalBytesBucket(totalBytes, fileCount)
  ) {
    return false;
  }
  let remainingBytes = totalBytes;
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
    const file = descriptor.value;
    if (!hasOnlyOwnDataKeys(file, ["id", "name", "size"])) return false;
    const expectedSize = Math.min(remainingBytes, MAX_FILE_BYTES);
    if (ownDataValue(file, "id") !== index || ownDataValue(file, "name") !== `encrypted-${index}` || ownDataValue(file, "size") !== expectedSize || ownDataValue(file, "mime") !== undefined) return false;
    remainingBytes -= expectedSize;
  }
  return remainingBytes === 0;
}

function bucketedPublicManifest(fileCount: number, totalBytes: number): FileManifest {
  const files: FileManifest["files"] = [];
  let remainingBytes = totalBytes;
  for (let index = 0; index < fileCount; index += 1) {
    const size = Math.min(remainingBytes, MAX_FILE_BYTES);
    files.push({ id: index, name: `encrypted-${index}`, size });
    remainingBytes -= size;
  }
  return { files, fileCount, totalBytes };
}

function publicFileCountBucket(fileCount: number): number {
  for (const bucket of FILE_COUNT_BUCKETS) {
    if (fileCount <= bucket) return bucket;
  }
  return MAX_FILES_PER_SESSION;
}

function publicTotalBytesBucket(totalBytes: number, fileCountBucket: number): number {
  const maxForBucket = fileCountBucket * MAX_FILE_BYTES;
  if (totalBytes <= 1) return 1;
  let bucket = 1;
  while (bucket < totalBytes && bucket < maxForBucket) bucket *= 2;
  return Math.min(bucket, maxForBucket);
}

function isPublicFileCountBucket(fileCount: number): boolean {
  return Number.isSafeInteger(fileCount) && FILE_COUNT_BUCKETS.includes(fileCount);
}

function isPublicTotalBytesBucket(totalBytes: number, fileCountBucket: number): boolean {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) return false;
  const maxForBucket = fileCountBucket * MAX_FILE_BYTES;
  if (totalBytes > maxForBucket) return false;
  return totalBytes === maxForBucket || Number.isInteger(Math.log2(totalBytes));
}

function hasOnlyOwnDataKeys(value: unknown, expectedKeys: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== expectedKeys.length) return false;
  for (const key of keys) {
    if (!expectedKeys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
