import { MAX_OUTPUT_NAME_ATTEMPTS } from "../shared/constants.js";
import { isOpaqueBrowserPartName, MAX_BROWSER_OUTPUT_NAME_BYTES } from "./file-names.js";

const UNSAFE_BROWSER_FILE_NAME_CHARS = /[\p{Cc}\p{Cf}/\\<>:"|?*]/u;
const BROWSER_RESERVATION_TOKEN = /\bff-[a-f0-9]{32}\b/;

export async function availableBrowserName(directory: FileSystemDirectoryHandle, name: string, candidateName: (name: string, index: number) => string): Promise<string> {
  assertBrowserFileName(name);
  assertBrowserCandidateName(candidateName);
  for (let index = 0; index < MAX_OUTPUT_NAME_ATTEMPTS; index += 1) {
    const candidate = candidateName(name, index);
    assertBrowserFileName(candidate);
    if (!(await browserFileExists(directory, candidate))) return candidate;
  }
  throw new Error(`Could not reserve a browser output name after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts.`);
}

export async function createAvailableBrowserFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  candidateName: (name: string, index: number) => string
): Promise<{ name: string; handle: FileSystemFileHandle }> {
  assertBrowserFileName(name);
  assertBrowserReservationToken(name);
  assertBrowserCandidateName(candidateName);
  for (let index = 0; index < MAX_OUTPUT_NAME_ATTEMPTS; index += 1) {
    const candidate = candidateName(name, index);
    assertBrowserFileName(candidate);
    assertBrowserReservationToken(candidate);
    if (await browserFileExists(directory, candidate)) continue;
    const handle = await directory.getFileHandle(candidate, { create: true });
    const file = await handle.getFile();
    if (file.size === 0) return { name: candidate, handle };
  }
  throw new Error(`Could not create a browser output file after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts.`);
}

export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
  return typeof descriptor?.get === "function" && descriptor.get.call(error) === "NotFoundError";
}

export function ignoreNotFoundError(error: unknown): void {
  if (!isNotFoundError(error)) throw error;
}

export function assertBrowserTokenizedFileName(name: string): void {
  assertBrowserFileName(name);
  assertBrowserReservationToken(name);
}

export function assertBrowserOpaquePartFileName(name: string): void {
  assertBrowserTokenizedFileName(name);
  if (!isOpaqueBrowserPartName(name)) throw new Error("Browser resume partial file name must be opaque.");
}

async function browserFileExists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function assertBrowserFileName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.trim().length === 0 ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    /[. ]+$/.test(name) ||
    isWindowsReservedName(name) ||
    utf8ByteLengthExceeds(name, MAX_BROWSER_OUTPUT_NAME_BYTES) ||
    UNSAFE_BROWSER_FILE_NAME_CHARS.test(name)
  ) {
    throw new Error("Browser output file name is invalid.");
  }
}

function assertBrowserCandidateName(candidateName: unknown): asserts candidateName is (name: string, index: number) => string {
  if (typeof candidateName !== "function") throw new Error("Browser output candidate function is invalid.");
}

function assertBrowserReservationToken(name: string): void {
  if (!BROWSER_RESERVATION_TOKEN.test(name)) throw new Error("Browser output file names must include a random reservation token.");
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
