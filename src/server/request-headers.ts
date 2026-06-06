import type http from "node:http";
import { isValidAuthority, isValidOriginHostname } from "../shared/authority.js";
import { HTTP_MAX_HEADERS_COUNT } from "../shared/constants.js";

const UNSAFE_HOST_HEADER_CHARS = /[\p{Cc}\p{Cf}\s,\/\\@]/u;
const RAW_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_RAW_HEADER_NAME_CHARS = 64;
const MAX_HOST_HEADER_CHARS = 255;
const MAX_ORIGIN_HEADER_BYTES = 2048;
const MAX_REQUEST_TARGET_BYTES = 8192;

export function requestOriginHeader(req: http.IncomingMessage): string | undefined | null {
  const origin = rawHeaderValue(req, "origin");
  if (origin === null) return null;
  if (origin === undefined) return undefined;
  if (typeof origin !== "string" || !isValidOriginHeader(origin)) return null;
  return origin;
}

export function requestBaseUrl(req: http.IncomingMessage): string | null {
  const host = requestHostAuthority(req);
  return host === null ? null : `http://${host}`;
}

export function requestHostAuthority(req: http.IncomingMessage): string | null {
  const host = rawHeaderValue(req, "host");
  if (typeof host !== "string" || !isValidHostHeader(host)) return null;
  return host;
}

export function requestUrl(req: http.IncomingMessage): URL | null {
  const baseUrl = requestBaseUrl(req);
  const targetValue = optionalOwnDataValue(req, "url");
  if (targetValue === null) return null;
  const target = targetValue ?? "/";
  if (!baseUrl || typeof target !== "string" || !isOriginFormTarget(target)) return null;
  try {
    return new URL(target, baseUrl);
  } catch {
    return null;
  }
}

export function requestMethod(req: http.IncomingMessage): string | null {
  const method = ownDataValue(req, "method");
  return typeof method === "string" ? method : null;
}

export function requestRemoteAddress(req: http.IncomingMessage): string {
  const socket = ownDataValue(req, "socket");
  if (!socket || typeof socket !== "object" || Array.isArray(socket)) return "unknown";
  const remoteAddress = ownDataValue(socket, "remoteAddress");
  return typeof remoteAddress === "string" && remoteAddress.length > 0 ? remoteAddress : "unknown";
}

function isValidHostHeader(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOST_HEADER_CHARS) return false;
  if (host.includes("://") || UNSAFE_HOST_HEADER_CHARS.test(host)) return false;
  return isValidAuthority(host);
}

function isValidOriginHeader(origin: string): boolean {
  if (origin.length === 0 || origin.length > MAX_ORIGIN_HEADER_BYTES || utf8ByteLengthExceeds(origin, MAX_ORIGIN_HEADER_BYTES) || /[\p{Cc}\p{Cf}\s,]/u.test(origin)) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port !== "0" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      isValidOriginHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isOriginFormTarget(target: string): boolean {
  return target.length > 0 && target.length <= MAX_REQUEST_TARGET_BYTES && !utf8ByteLengthExceeds(target, MAX_REQUEST_TARGET_BYTES) && target.startsWith("/") && !target.startsWith("//") && !/[\p{Cc}\p{Cf}\u0020\\]/u.test(target);
}

function utf8ByteLengthExceeds(value: string, maxBytes: number): boolean {
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

function rawHeaderValue(req: http.IncomingMessage, name: string): string | undefined | null {
  const pairs = rawHeaderPairs(req);
  if (pairs === null) return null;
  let value: string | undefined;
  for (const [rawName, rawValue] of pairs) {
    if (rawName.toLowerCase() !== name) continue;
    if (value !== undefined) return null;
    value = rawValue;
  }
  return value;
}

function rawHeaderPairs(req: http.IncomingMessage): [string, string][] | null {
  const rawHeaders = ownDataValue(req, "rawHeaders");
  if (!Array.isArray(rawHeaders)) return null;
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length > HTTP_MAX_HEADERS_COUNT * 2) return null;
  const pairs: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = ownArrayValue(rawHeaders, index);
    const rawValue = ownArrayValue(rawHeaders, index + 1);
    if (typeof rawName !== "string" || typeof rawValue !== "string") return null;
    if (!isRawHeaderName(rawName)) return null;
    pairs.push([rawName, rawValue]);
  }
  return pairs;
}

function isRawHeaderName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RAW_HEADER_NAME_CHARS && RAW_HEADER_NAME.test(value);
}

function ownArrayValue(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function optionalOwnDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  return "value" in descriptor ? descriptor.value : null;
}

function ownDataValue(value: unknown, key: string): unknown {
  const data = optionalOwnDataValue(value, key);
  return data === null ? undefined : data;
}
