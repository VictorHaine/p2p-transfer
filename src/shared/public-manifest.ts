import { MAX_FILE_BYTES, MAX_FILES_PER_SESSION } from "./constants.js";
import type { FileManifest } from "./messages.js";

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

  return constantPublicManifest();
}

export function publicPairRequestManifestIsRedacted(manifest: FileManifest): boolean {
  if (!hasOnlyOwnDataKeys(manifest, ["files", "fileCount", "totalBytes"])) return false;
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (
    typeof fileCount !== "number" ||
    !Array.isArray(files) ||
    fileCount !== MAX_FILES_PER_SESSION ||
    files.length !== fileCount ||
    typeof totalBytes !== "number" ||
    totalBytes !== MAX_PUBLIC_TOTAL_BYTES
  ) {
    return false;
  }
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
    const file = descriptor.value;
    if (!hasOnlyOwnDataKeys(file, ["id", "name", "size"])) return false;
    if (ownDataValue(file, "id") !== index || ownDataValue(file, "name") !== `encrypted-${index}` || ownDataValue(file, "size") !== MAX_FILE_BYTES || ownDataValue(file, "mime") !== undefined) return false;
  }
  return true;
}

function constantPublicManifest(): FileManifest {
  const files: FileManifest["files"] = [];
  for (let index = 0; index < MAX_FILES_PER_SESSION; index += 1) {
    files.push({ id: index, name: `encrypted-${index}`, size: MAX_FILE_BYTES });
  }
  return { files, fileCount: MAX_FILES_PER_SESSION, totalBytes: MAX_PUBLIC_TOTAL_BYTES };
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
