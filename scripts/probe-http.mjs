#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MAX_RESPONSE_BYTES = 8_192;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_URL_CHARS = 2_048;
const MAX_CONTAINS_CHARS = 1_024;
const MAX_ENV_VALUE_BYTES = 2_048;
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const PROBE_TIMEOUT_MS = 10_000;

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("HTTP probe failed:");
    console.error(`- ${probeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const url = requiredUrl(envString("PROBE_URL", true));
  const expectedStatus = requiredStatus(envString("PROBE_STATUS", true));
  const expectedContains = optionalContains(envString("PROBE_CONTAINS", false));
  const maxBytes = optionalMaxBytes(envString("PROBE_MAX_BYTES", false));
  const origin = optionalOrigin(envString("PROBE_ORIGIN", false));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();

  try {
    const headers = origin ? { Origin: origin } : undefined;
    const response = await fetch(url.href, { headers, redirect: "error", signal: controller.signal });
    const body = await readBoundedResponseText(response, maxBytes);
    if (response.status !== expectedStatus) {
      throw new Error(`expected HTTP ${expectedStatus} from probe target, got ${response.status}`);
    }
    if (expectedContains !== undefined && !body.includes(expectedContains)) {
      throw new Error("response from probe target did not contain the expected marker");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`HTTP probe timed out after ${PROBE_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

export function probeErrorMessage(error) {
  if (
    !(error instanceof Error) ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > MAX_ERROR_MESSAGE_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message) ||
    containsUrlOrPathText(error.message)
  ) {
    return "HTTP probe failed with an internal error.";
  }
  return error.message;
}

function containsUrlOrPathText(value) {
  return /(?:^|[\s("'=])(?:https?:\/\/|\/|[A-Za-z]:[\\/])/.test(value) || /[?&][A-Za-z0-9_.-]+=/.test(value);
}

function envString(name, required) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
    if (required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof descriptor.value !== "string" || /[\p{Cc}\p{Cf}]/u.test(descriptor.value) || utf8ByteLengthExceeds(descriptor.value, MAX_ENV_VALUE_BYTES)) {
    throw new Error(`${name} must be a control-free string under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

export function requiredUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_CHARS || utf8ByteLengthExceeds(value, MAX_URL_CHARS)) {
    throw new Error("PROBE_URL must be a non-empty bounded URL.");
  }
  const parsed = parseUrl(value, "PROBE_URL must be a valid URL.");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PROBE_URL must use http or https.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Plain HTTP probes are restricted to loopback hosts.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("PROBE_URL must not contain credentials.");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("PROBE_URL must not contain a query string or fragment.");
  }
  return parsed;
}

function requiredStatus(value) {
  if (typeof value !== "string" || !/^[1-5][0-9][0-9]$/.test(value)) {
    throw new Error("PROBE_STATUS must be an HTTP status code.");
  }
  return Number(value);
}

function optionalContains(value) {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > MAX_CONTAINS_CHARS || utf8ByteLengthExceeds(value, MAX_CONTAINS_CHARS)) {
    throw new Error("PROBE_CONTAINS must be a non-empty bounded string.");
  }
  return value;
}

function optionalMaxBytes(value) {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new Error("PROBE_MAX_BYTES must be a positive integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RESPONSE_BYTES) {
    throw new Error("PROBE_MAX_BYTES exceeds the probe response limit.");
  }
  return parsed;
}

export function optionalOrigin(value) {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > MAX_URL_CHARS || utf8ByteLengthExceeds(value, MAX_URL_CHARS)) throw new Error("PROBE_ORIGIN must be a bounded origin.");
  const parsed = parseUrl(value, "PROBE_ORIGIN must be a valid origin.");
  if (parsed.origin !== value || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("PROBE_ORIGIN must be an exact http or https origin.");
  }
  return value;
}

function parseUrl(value, message) {
  try {
    return new URL(value);
  } catch {
    throw new Error(message);
  }
}

function utf8ByteLengthExceeds(value, maxBytes) {
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
    if (bytes > maxBytes) return true;
  }
  return false;
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export async function readBoundedResponseText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new Error("Invalid HTTP probe response byte limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("HTTP probe response yielded a non-binary chunk.");
      total += value.byteLength;
      if (total > maxBytes) throw new Error("HTTP probe response exceeded the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Keep the original probe failure; lock release is best-effort cleanup.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("HTTP probe response is not valid UTF-8.");
  }
}
