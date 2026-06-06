import path from "node:path";

const MAX_STATIC_URL_PATH_BYTES = 8192;

export function isPathInsideRoot(root: unknown, candidate: unknown): boolean {
  if (typeof root !== "string" || typeof candidate !== "string") return false;
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function staticUrlPathToRelative(urlPath: unknown): string {
  if (typeof urlPath !== "string") throw new Error("invalid static URL path");
  if (urlPath.length === 0 || utf8ByteLengthExceeds(urlPath, MAX_STATIC_URL_PATH_BYTES)) throw new Error("invalid static URL path");
  if (/%2f|%5c/i.test(urlPath)) throw new Error("invalid static URL path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    throw new Error("invalid static URL path");
  }
  if (/[\p{Cc}\p{Cf}\\]/u.test(decoded)) throw new Error("invalid static URL path");
  const normalized = path.posix.normalize(decoded);
  const relative = normalized === "/" ? "index.html" : normalized.replace(/^\/+/, "");
  if (relative === "" || relative.split("/").some((part) => part === "..")) throw new Error("invalid static URL path");
  return relative;
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

export function canServeIndexFallback(relative: unknown): boolean {
  if (typeof relative !== "string") return false;
  if (!isSafeStaticRelativePath(relative)) return false;
  if (relative === "index.html") return true;
  if (relative === "v1" || relative.startsWith("v1/")) return false;
  if (relative.startsWith("assets/")) return false;
  return !path.posix.basename(relative).includes(".");
}

function isSafeStaticRelativePath(relative: string): boolean {
  return (
    relative.length > 0 &&
    !utf8ByteLengthExceeds(relative, MAX_STATIC_URL_PATH_BYTES) &&
    !relative.startsWith("/") &&
    !relative.startsWith("//") &&
    !/[\p{Cc}\p{Cf}\\]/u.test(relative) &&
    !relative.split("/").some((part) => part === "" || part === "..")
  );
}

export function isMissingStaticPathError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return !!descriptor && "value" in descriptor && descriptor.value === code;
}
