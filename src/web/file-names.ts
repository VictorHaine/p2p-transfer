import { safeFileName } from "../shared/limits.js";
import { MAX_OUTPUT_NAME_ATTEMPTS } from "../shared/constants.js";

export const MAX_BROWSER_OUTPUT_NAME_BYTES = 200;
const BROWSER_PART_SUFFIX = ".part";
export const MAX_BROWSER_FINAL_NAME_BYTES = MAX_BROWSER_OUTPUT_NAME_BYTES - utf8ByteLength(BROWSER_PART_SUFFIX);
const MAX_BROWSER_OUTPUT_EXTENSION_BYTES = 32;
const RANDOM_NAME_TOKEN_HEX_CHARS = 32;
const RANDOM_SUFFIX = /^(.*)( \(ff-[a-f0-9]{32}\))(\.[^.]*)?$/;
const OPAQUE_PART_NAME = /^ff-[a-f0-9]{32}\.part$/;

export function randomizedBrowserOutputName(name: string, token = randomNameToken()): string {
  assertBrowserNameInput(name);
  if (typeof token !== "string") throw new Error("Browser output token is invalid.");
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Browser output token is invalid.");
  const sanitized = safeFileName(name, MAX_BROWSER_FINAL_NAME_BYTES);
  const dot = sanitized.lastIndexOf(".");
  const rawBase = dot > 0 ? sanitized.slice(0, dot) : sanitized;
  const rawExt = dot > 0 ? sanitized.slice(dot) : "";
  const suffix = ` (ff-${token})`;
  const ext = trimToUtf8Bytes(rawExt, Math.min(MAX_BROWSER_OUTPUT_EXTENSION_BYTES, Math.max(0, MAX_BROWSER_FINAL_NAME_BYTES - utf8ByteLength(suffix) - 1)));
  const base = trimToUtf8Bytes(rawBase, Math.max(1, MAX_BROWSER_FINAL_NAME_BYTES - utf8ByteLength(suffix) - utf8ByteLength(ext)));
  return `${base}${suffix}${ext}`;
}

export function opaqueBrowserOutputName(token = randomNameToken()): string {
  if (typeof token !== "string") throw new Error("Browser output token is invalid.");
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Browser output token is invalid.");
  return `ff-${token}`;
}

export function browserPartName(finalName: string): string {
  assertBrowserNameInput(finalName);
  if (utf8ByteLength(finalName) > MAX_BROWSER_FINAL_NAME_BYTES) throw new Error("Browser final output name is too long.");
  return `${finalName}${BROWSER_PART_SUFFIX}`;
}

export function opaqueBrowserPartName(token = randomNameToken()): string {
  if (typeof token !== "string") throw new Error("Browser output token is invalid.");
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Browser output token is invalid.");
  return `ff-${token}${BROWSER_PART_SUFFIX}`;
}

export function isOpaqueBrowserPartName(name: string): boolean {
  assertBrowserNameInput(name);
  return OPAQUE_PART_NAME.test(name);
}

export function browserFinalCandidateName(name: string, index: number): string {
  assertBrowserNameInput(name);
  assertCollisionIndex(index);
  if (index === 0) return boundedExistingName(name, MAX_BROWSER_FINAL_NAME_BYTES);
  const collision = ` (${index})`;
  const match = RANDOM_SUFFIX.exec(name);
  if (!match) return boundedCollisionName(name, collision, MAX_BROWSER_FINAL_NAME_BYTES);
  const [, rawBase = "", randomSuffix = "", rawExt = ""] = match;
  const ext = trimToUtf8Bytes(rawExt, Math.min(MAX_BROWSER_OUTPUT_EXTENSION_BYTES, Math.max(0, MAX_BROWSER_FINAL_NAME_BYTES - utf8ByteLength(randomSuffix) - utf8ByteLength(collision) - 1)));
  const base = trimToUtf8Bytes(rawBase, Math.max(1, MAX_BROWSER_FINAL_NAME_BYTES - utf8ByteLength(randomSuffix) - utf8ByteLength(collision) - utf8ByteLength(ext)));
  return `${base}${randomSuffix}${collision}${ext}`;
}

export function browserPartCandidateName(name: string, index: number): string {
  assertBrowserNameInput(name);
  assertCollisionIndex(index);
  if (index === 0) return boundedExistingName(name, MAX_BROWSER_OUTPUT_NAME_BYTES);
  return boundedCollisionName(name, ` (${index})`, MAX_BROWSER_OUTPUT_NAME_BYTES);
}

function assertBrowserNameInput(name: unknown): asserts name is string {
  if (typeof name !== "string") throw new Error("Browser output name is invalid.");
}

function assertCollisionIndex(index: unknown): asserts index is number {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_OUTPUT_NAME_ATTEMPTS) throw new Error("Browser output collision index is invalid.");
}

function randomNameToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_NAME_TOKEN_HEX_CHARS / 2));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  }
  return bytes;
}

function boundedExistingName(name: string, maxBytes: number): string {
  if (utf8ByteLength(name) > maxBytes) throw new Error("Browser output name is too long.");
  return name;
}

function boundedCollisionName(name: string, collision: string, maxBytes: number): string {
  const dot = name.lastIndexOf(".");
  const rawBase = dot > 0 ? name.slice(0, dot) : name;
  const rawExt = dot > 0 ? name.slice(dot) : "";
  const ext = trimToUtf8Bytes(rawExt, Math.min(MAX_BROWSER_OUTPUT_EXTENSION_BYTES, Math.max(0, maxBytes - utf8ByteLength(collision) - 1)));
  const base = trimToUtf8Bytes(rawBase, Math.max(1, maxBytes - utf8ByteLength(collision) - utf8ByteLength(ext)));
  return `${base}${collision}${ext}`;
}
