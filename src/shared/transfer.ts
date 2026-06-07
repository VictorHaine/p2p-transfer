import { MAX_FILES_PER_SESSION, MAX_MIME_CHARS } from "./constants.js";
import { assertFileWithinLimits, assertTransferManifestWithinLimits } from "./limits.js";
import { isObject } from "./messages.js";
import type { FileManifest } from "./messages.js";

export const MAX_ABORT_REASON_CHARS = 1000;
export const REMOTE_ABORT_MESSAGE = "Peer aborted the transfer.";
const LOCAL_ABORT_MESSAGE = "Transfer aborted.";

export type TransferManifest = {
  t: "manifest";
  files: { id: number; name: string; size: number; mime?: string }[];
  totalBytes: number;
};

export type ControlMessage =
  | TransferManifest
  | { t: "file-begin"; id: number; name: string; size: number }
  | { t: "ready"; id: number; offset?: number; prefixSha256?: string }
  | { t: "restart"; id: number }
  | { t: "file-end"; id: number; sha256: string }
  | { t: "file-ok"; id: number }
  | { t: "all-done" }
  | { t: "all-done-ok" }
  | { t: "abort"; reason: string };

export function assertControlMessage(value: unknown): ControlMessage {
  if (!isObject(value)) throw new Error("Malformed control message");
  const type = ownDataValue(value, "t");
  if (typeof type !== "string") throw new Error("Malformed control message");
  switch (type) {
    case "manifest":
      return assertTransferManifest(value);
    case "file-begin":
      {
        const id = ownDataValue(value, "id");
        const name = ownDataValue(value, "name");
        const size = ownDataValue(value, "size");
        if (!hasOnlyKeys(value, ["t", "id", "name", "size"]) || !isUint8(id) || typeof name !== "string" || !isSafeNonNegativeInteger(size)) {
          throw new Error("Malformed file-begin control message");
        }
        assertFileWithinLimits(name, size);
        return { t: "file-begin", id, name, size };
      }
    case "file-ok":
      {
        const id = ownDataValue(value, "id");
        if (!hasOnlyKeys(value, ["t", "id"]) || !isUint8(id)) throw new Error(`Malformed ${type} control message`);
        return { t: type, id };
      }
    case "ready":
      {
        const id = ownDataValue(value, "id");
        const offset = ownDataValue(value, "offset");
        const prefixSha256 = ownDataValue(value, "prefixSha256");
        if (!hasOnlyKeys(value, ["t", "id", "offset", "prefixSha256"]) || !isUint8(id) || !isOptionalResumeOffset(offset) || !isOptionalSha256(prefixSha256)) {
          throw new Error("Malformed ready control message");
        }
        if (offset === undefined && prefixSha256 !== undefined) throw new Error("Malformed ready control message");
        if (offset !== undefined && offset > 0 && prefixSha256 === undefined) throw new Error("Malformed ready control message");
        return {
          t: "ready",
          id,
          ...(offset === undefined ? {} : { offset }),
          ...(prefixSha256 === undefined ? {} : { prefixSha256 })
        };
      }
    case "restart":
      {
        const id = ownDataValue(value, "id");
        if (!hasOnlyKeys(value, ["t", "id"]) || !isUint8(id)) throw new Error("Malformed restart control message");
        return { t: "restart", id };
      }
    case "file-end":
      {
        const id = ownDataValue(value, "id");
        const sha256 = ownDataValue(value, "sha256");
        if (!hasOnlyKeys(value, ["t", "id", "sha256"]) || !isUint8(id) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
          throw new Error("Malformed file-end control message");
        }
        return { t: "file-end", id, sha256 };
      }
    case "all-done":
      if (!hasOnlyKeys(value, ["t"])) throw new Error("Malformed all-done control message");
      return { t: "all-done" };
    case "all-done-ok":
      if (!hasOnlyKeys(value, ["t"])) throw new Error("Malformed all-done-ok control message");
      return { t: "all-done-ok" };
    case "abort":
      {
        const reason = ownDataValue(value, "reason");
        if (!hasOnlyKeys(value, ["t", "reason"]) || !isSafeReason(reason, MAX_ABORT_REASON_CHARS)) throw new Error("Malformed abort control message");
        return { t: "abort", reason };
      }
    default:
      throw new Error("Unknown control message type");
  }
}

export type SenderControlMessage = Extract<ControlMessage, { t: "ready" | "file-ok" | "all-done-ok" | "abort" }>;

export function assertSenderControlMessage(value: ControlMessage): SenderControlMessage {
  const type = ownDataValue(value, "t");
  if (type === "ready" || type === "file-ok" || type === "all-done-ok" || type === "abort") return value as SenderControlMessage;
  throw new Error(`Unexpected sender control message: ${typeof type === "string" ? type : "unknown"}.`);
}

export function assertTransferManifestMatchesAccepted(accepted: FileManifest, transfer: TransferManifest): void {
  assertTransferManifestWithinLimits(accepted);
  const acceptedFiles = ownDataValue(accepted, "files");
  const acceptedFileCount = ownDataValue(accepted, "fileCount");
  const acceptedTotalBytes = ownDataValue(accepted, "totalBytes");
  const transferFiles = ownDataValue(transfer, "files");
  const transferTotalBytes = ownDataValue(transfer, "totalBytes");
  if (!Array.isArray(acceptedFiles) || !Array.isArray(transferFiles) || !isSafeNonNegativeInteger(acceptedFileCount) || !isSafeNonNegativeInteger(acceptedTotalBytes) || !isSafeNonNegativeInteger(transferTotalBytes)) {
    throw new Error("Transfer manifest does not match the accepted manifest.");
  }
  assertTransferManifestWithinLimits({ fileCount: transferFiles.length, totalBytes: transferTotalBytes, files: transferFiles });
  if (acceptedTotalBytes !== transferTotalBytes || acceptedFileCount !== transferFiles.length) {
    throw new Error("Transfer manifest does not match the accepted manifest.");
  }
  for (let index = 0; index < acceptedFiles.length; index += 1) {
    const acceptedFile = ownDataValue(acceptedFiles, String(index));
    const transferFile = ownDataValue(transferFiles, String(index));
    if (
      !isObject(acceptedFile) ||
      !isObject(transferFile) ||
      ownDataValue(acceptedFile, "id") !== ownDataValue(transferFile, "id") ||
      ownDataValue(acceptedFile, "name") !== ownDataValue(transferFile, "name") ||
      ownDataValue(acceptedFile, "size") !== ownDataValue(transferFile, "size") ||
      (ownDataValue(acceptedFile, "mime") ?? undefined) !== (ownDataValue(transferFile, "mime") ?? undefined)
    ) {
      throw new Error("Transfer manifest does not match the accepted manifest.");
    }
  }
}

export function abortControlMessage(_reason: unknown): Extract<ControlMessage, { t: "abort" }> {
  return { t: "abort", reason: LOCAL_ABORT_MESSAGE };
}

export function remoteAbortError(): Error {
  return new Error(REMOTE_ABORT_MESSAGE);
}

function assertTransferManifest(value: Record<string, unknown>): TransferManifest {
  const filesValue = ownDataValue(value, "files");
  const totalBytes = ownDataValue(value, "totalBytes");
  if (!hasOnlyKeys(value, ["t", "files", "totalBytes"]) || !Array.isArray(filesValue) || !isSafeNonNegativeInteger(totalBytes)) {
    throw new Error("Malformed manifest control message");
  }
  if (filesValue.length < 1 || filesValue.length > MAX_FILES_PER_SESSION) {
    throw new Error(`File count must be between 1 and ${MAX_FILES_PER_SESSION}.`);
  }
  const files: TransferManifest["files"] = [];
  for (let index = 0; index < filesValue.length; index += 1) {
    const file = ownDataValue(filesValue, String(index));
    if (!isObject(file)) throw new Error("Malformed manifest file entry");
    const id = ownDataValue(file, "id");
    const name = ownDataValue(file, "name");
    const size = ownDataValue(file, "size");
    const mime = ownDataValue(file, "mime");
    if (!hasOnlyKeys(file, ["id", "name", "size", "mime"]) || !isUint8(id) || typeof name !== "string" || !isSafeNonNegativeInteger(size)) {
      throw new Error("Malformed manifest file entry");
    }
    if (mime !== undefined && (typeof mime !== "string" || mime.length > MAX_MIME_CHARS)) throw new Error("Malformed manifest MIME type");
    files.push(mime === undefined ? { id, name, size } : { id, name, size, mime });
  }
  assertTransferManifestWithinLimits({ files, fileCount: files.length, totalBytes });
  return { t: "manifest", files, totalBytes };
}

function isUint8(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalResumeOffset(value: unknown): value is number | undefined {
  return value === undefined || isSafeNonNegativeInteger(value);
}

function isOptionalSha256(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function isSafeReason(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars && !UNSAFE_REASON_CHARS.test(value);
}

const UNSAFE_REASON_CHARS = /[\p{Cc}\p{Cf}]/u;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
