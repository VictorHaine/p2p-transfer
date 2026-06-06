import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isLoopbackAuthority, isValidAuthority, isValidHostNameOrIp, isValidOriginHostname } from "../shared/authority.js";
import { DEFAULT_ICE_SERVERS, TURN_REST_SECRET_MIN_BYTES } from "../shared/constants.js";
import { cloneIceServers } from "../shared/ice.js";
import { isIceServers } from "../shared/messages.js";

const MAX_ICE_SERVERS_ENV_BYTES = 128 * 1024;
const MAX_ALLOWED_ORIGINS_ENV_BYTES = 16 * 1024;
const MAX_TURN_URLS_ENV_BYTES = 8 * 1024;
const MAX_TURN_REST_SECRET_BYTES = 4096;
const MAX_WEB_ROOT_ENV_BYTES = 4096;
const MAX_SCALAR_ENV_BYTES = 4096;
const MAX_ORIGIN_HEADER_BYTES = 2048;

export type ServerConfig = {
  port: number;
  host: string;
  iceServers: RTCIceServer[];
  webRoot: string;
  allowedOrigins: string[] | undefined;
  signalingTopology: SignalingTopology | undefined;
  browserAllowAnyWss: boolean;
  browserAllowLoopbackWs: boolean;
  turnRest: TurnRestConfig | undefined;
};

export type SignalingTopology = "single-instance" | "sticky-sessions";

export type TurnRestConfig = {
  urls: string | string[];
  secret: string;
  ttlSeconds: number;
};

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = parseProductionEnv(envValue(env, "NODE_ENV"));
  const iceServers = parseIceServers(envValue(env, "ICE_SERVERS"));
  assertNoProductionStaticTurnCredentials(iceServers, production);
  const host = parseHost(envValue(env, "HOST"));
  const allowedOrigins = parseAllowedOrigins(envValue(env, "ALLOWED_ORIGINS"));
  const signalingTopology = parseSignalingTopology(envValue(env, "SIGNALING_TOPOLOGY"));
  assertNoUnsupportedOriginBypass(env);
  const allowInsecureOrigins = parseBooleanEnv(envValue(env, "ALLOW_INSECURE_ORIGINS"), "ALLOW_INSECURE_ORIGINS");
  assertRequiredOriginPolicy(allowedOrigins, production, host);
  assertRequiredSignalingTopology(signalingTopology, production, host);
  assertProductionSecureOrigins(allowedOrigins, production, allowInsecureOrigins);
  return {
    port: parsePort(envValue(env, "PORT")),
    host,
    iceServers,
    webRoot: parseWebRoot(envValue(env, "WEB_ROOT")),
    allowedOrigins,
    signalingTopology,
    browserAllowAnyWss: parseBooleanEnv(envValue(env, "BROWSER_ALLOW_ANY_WSS"), "BROWSER_ALLOW_ANY_WSS"),
    browserAllowLoopbackWs: parseBrowserLoopbackWs(env, production),
    turnRest: parseTurnRestConfig(env)
  };
}

function assertNoProductionStaticTurnCredentials(iceServers: RTCIceServer[], production: boolean): void {
  if (!production) return;
  if (iceServers.some(hasStaticTurnCredential)) {
    throw new Error("Static TURN credentials in ICE_SERVERS are disabled in production. Use TURN_REST_SECRET and TURN_URLS for ephemeral credentials.");
  }
}

function hasStaticTurnCredential(server: RTCIceServer): boolean {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return urls.some((url) => /^(?:turn|turns):/i.test(url) && (server.username !== undefined || server.credential !== undefined || hasUrlCredentials(url)));
}

function assertRequiredOriginPolicy(allowedOrigins: string[] | undefined, production: boolean, host: string): void {
  if (allowedOrigins) return;
  if (production) throw new Error("ALLOWED_ORIGINS is required in production.");
  if (!isLoopbackBindHost(host)) throw new Error("ALLOWED_ORIGINS is required when HOST is not loopback.");
}

function assertRequiredSignalingTopology(topology: SignalingTopology | undefined, production: boolean, host: string): void {
  if (topology) return;
  if (production || !isLoopbackBindHost(host)) {
    throw new Error("SIGNALING_TOPOLOGY must be single-instance or sticky-sessions for production or non-loopback deployments.");
  }
}

function assertNoUnsupportedOriginBypass(env: NodeJS.ProcessEnv): void {
  const raw = envValue(env, "ALLOW_ANY_ORIGIN");
  if (raw === undefined || raw === "" || raw === "false") return;
  throw new Error("ALLOW_ANY_ORIGIN is not supported. Set an explicit ALLOWED_ORIGINS allowlist.");
}

function assertProductionSecureOrigins(allowedOrigins: string[] | undefined, production: boolean, allowInsecureOrigins: boolean): void {
  if (!production || allowInsecureOrigins) return;
  if (allowedOrigins?.some((origin) => origin.startsWith("http://"))) {
    throw new Error("Production ALLOWED_ORIGINS entries must use https. Set ALLOW_INSECURE_ORIGINS=true only for private deployments.");
  }
}

function parseProductionEnv(raw: unknown): boolean {
  const value = optionalEnvString(raw, "NODE_ENV");
  if (value !== undefined) assertEnvStringByteLength(value, "NODE_ENV", MAX_SCALAR_ENV_BYTES);
  if (value === undefined || value === "") return false;
  if (value !== value.trim()) throw new Error("NODE_ENV must be exactly production, development, test, or unset.");
  if (value === "production") return true;
  if (value === "development" || value === "test") return false;
  throw new Error("NODE_ENV must be exactly production, development, test, or unset.");
}

function parseSignalingTopology(raw: unknown): SignalingTopology | undefined {
  const value = optionalEnvString(raw, "SIGNALING_TOPOLOGY");
  if (value !== undefined) assertEnvStringByteLength(value, "SIGNALING_TOPOLOGY", MAX_SCALAR_ENV_BYTES);
  if (value === undefined || value.trim() === "") return undefined;
  if (value !== value.trim()) throw new Error("SIGNALING_TOPOLOGY must be single-instance or sticky-sessions.");
  if (value === "single-instance" || value === "sticky-sessions") return value;
  throw new Error("SIGNALING_TOPOLOGY must be single-instance or sticky-sessions.");
}

export function iceServersForRequest(config: ServerConfig, now = Date.now()): RTCIceServer[] {
  const iceServers = configIceServers(config);
  const turnRest = configTurnRest(config);
  if (turnRest === undefined) return iceServers;
  const expires = turnCredentialExpiresAt(now, turnRest.ttlSeconds);
  const username = `${expires}:${randomBytes(8).toString("hex")}`;
  const credential = createHmac("sha1", turnRest.secret).update(username).digest("base64");
  return [...iceServers, { urls: turnRest.urls, username, credential }];
}

export function iceServersForUnauthenticatedRequest(config: ServerConfig): RTCIceServer[] {
  const publicServers = publicConfigIceServers(config).flatMap(publicIceServer);
  return publicServers.length > 0 ? publicServers : cloneIceServers(DEFAULT_ICE_SERVERS);
}

function publicIceServer(server: RTCIceServer): RTCIceServer[] {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  const publicUrls = urls.filter(isPublicStunUrl);
  if (publicUrls.length === 0) return [];
  return [{ urls: publicUrls.length === 1 ? publicUrls[0]! : publicUrls }];
}

function configIceServers(config: ServerConfig): RTCIceServer[] {
  if (!isRuntimeConfigObject(config)) throw new Error("Server config is invalid.");
  return cloneIceServers(ownDataValue<readonly RTCIceServer[]>(config, "iceServers", "Server config is invalid."));
}

function publicConfigIceServers(config: ServerConfig): RTCIceServer[] {
  if (!isRuntimeConfigObject(config)) throw new Error("Server config is invalid.");
  const rawServers = ownDataValue<readonly RTCIceServer[]>(config, "iceServers", "Server config is invalid.");
  if (!Array.isArray(rawServers) || rawServers.length > 16) throw new Error("Server config is invalid.");
  const publicServers: RTCIceServer[] = [];
  for (let index = 0; index < rawServers.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawServers, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Server config fields must be data properties.");
    const publicServer = publicIceServerFromRuntimeValue(descriptor.value);
    if (publicServer) publicServers.push(publicServer);
  }
  return publicServers;
}

function publicIceServerFromRuntimeValue(value: unknown): RTCIceServer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rawUrls = ownDataValue<unknown>(value, "urls", "Server config fields must be data properties.");
  const urls = typeof rawUrls === "string" ? [rawUrls] : runtimeStringArray(rawUrls, "Server config fields must be data properties.");
  if (!urls) return undefined;
  const publicUrls = urls.filter(isPublicStunUrl);
  if (publicUrls.length === 0) return undefined;
  return { urls: publicUrls.length === 1 ? publicUrls[0]! : publicUrls };
}

function runtimeStringArray(value: unknown, message: string): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return undefined;
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(message);
    if (typeof descriptor.value !== "string") return undefined;
    out.push(descriptor.value);
  }
  return out;
}

function configTurnRest(config: ServerConfig): TurnRestConfig | undefined {
  if (!isRuntimeConfigObject(config)) throw new Error("Server config is invalid.");
  const turnRest = optionalOwnDataValue<unknown>(config, "turnRest", "Server config fields must be data properties.");
  if (turnRest === undefined) return undefined;
  return cloneTurnRestConfig(turnRest);
}

function cloneTurnRestConfig(value: unknown): TurnRestConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TURN REST config is invalid.");
  const urls = cloneTurnRestUrls(ownDataValue<unknown>(value, "urls", "TURN REST config is invalid."));
  const secret = ownDataValue<unknown>(value, "secret", "TURN REST config is invalid.");
  const ttlSeconds = ownDataValue<unknown>(value, "ttlSeconds", "TURN REST config is invalid.");
  assertRuntimeTurnSecret(secret);
  assertRuntimeTurnTtl(ttlSeconds);
  return { urls, secret, ttlSeconds };
}

function cloneTurnRestUrls(value: unknown): string | string[] {
  if (typeof value === "string") {
    assertRuntimeTurnUrlList([value]);
    return value;
  }
  if (!Array.isArray(value)) throw new Error("TURN REST config is invalid.");
  if (value.length === 0 || value.length > MAX_TURN_URLS) throw new Error("TURN REST config is invalid.");
  const urls: string[] = [];
  for (let index = 0; index < value.length; index += 1) urls.push(ownDataValue<string>(value, String(index), "TURN REST config is invalid."));
  assertRuntimeTurnUrlList(urls);
  return urls;
}

function assertRuntimeTurnUrlList(urls: string[]): void {
  if (urls.length === 0 || urls.length > MAX_TURN_URLS || !urls.every((url) => typeof url === "string" && isTurnUrl(url) && !hasUrlCredentials(url))) {
    throw new Error("TURN REST config is invalid.");
  }
}

function assertRuntimeTurnSecret(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("TURN REST config is invalid.");
  const secretBytes = Buffer.byteLength(value, "utf8");
  if (secretBytes < TURN_REST_SECRET_MIN_BYTES || secretBytes > MAX_TURN_REST_SECRET_BYTES || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error("TURN REST config is invalid.");
  }
}

function assertRuntimeTurnTtl(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 60 || value > 86400) throw new Error("TURN REST config is invalid.");
}

function turnCredentialExpiresAt(now: unknown, ttlSeconds: number): number {
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) throw new Error("TURN credential timestamp is invalid.");
  return Math.floor(now / 1000) + ttlSeconds;
}

function isPublicStunUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_TURN_URL_CHARS || /[\p{Cc}\p{Cf}\s]/u.test(url)) return false;
  const parsed = /^(?:stun|stuns):([^?]+)(?:\?transport=(?:udp|tcp))?$/i.exec(url);
  return Boolean(parsed?.[1] && isValidAuthority(parsed[1]));
}

function isRuntimeConfigObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalOwnDataValue<T>(source: object, key: string, message: string): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error(message);
  return descriptor.value as T;
}

function ownDataValue<T>(source: object, key: string, message: string): T {
  const value = optionalOwnDataValue<T>(source, key, message);
  if (value === undefined) throw new Error(message);
  return value;
}

export function parseIceServers(raw: unknown): RTCIceServer[] {
  const value = optionalEnvString(raw, "ICE_SERVERS");
  if (value === undefined) return cloneIceServers(DEFAULT_ICE_SERVERS);
  assertEnvStringByteLength(value, "ICE_SERVERS", MAX_ICE_SERVERS_ENV_BYTES);
  if (value.trim() === "") return cloneIceServers(DEFAULT_ICE_SERVERS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("ICE_SERVERS must be valid JSON.");
  }
  if (!isIceServers(parsed)) throw new Error("ICE_SERVERS must be an array of STUN/TURN server objects.");
  return cloneIceServers(parsed);
}

function parsePort(raw: unknown): number {
  const value = optionalEnvString(raw, "PORT");
  if (value !== undefined) assertEnvStringByteLength(value, "PORT", MAX_SCALAR_ENV_BYTES);
  if (value === undefined || value.trim() === "") return 8787;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer between 1 and 65535.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  return port;
}

function parseHost(raw: unknown): string {
  const value = optionalEnvString(raw, "HOST");
  if (value !== undefined) assertEnvStringByteLength(value, "HOST", MAX_SCALAR_ENV_BYTES);
  if (value !== undefined && value !== value.trim()) throw new Error("HOST must be a hostname or IP address, not a URL or path.");
  const host = value?.trim();
  if (!host) return "127.0.0.1";
  if (host.length > 253 || /[\u0000-\u001f\u007f\s/\\]/.test(host) || host.includes("://")) {
    throw new Error("HOST must be a hostname or IP address, not a URL or path.");
  }
  if (!isValidHostNameOrIp(host)) throw new Error("HOST must be a hostname or IP address, not a URL or path.");
  return host;
}

function isLoopbackBindHost(host: string): boolean {
  return host === "::1" || isLoopbackAuthority(host);
}

export function parseAllowedOrigins(raw: unknown): string[] | undefined {
  const value = optionalEnvString(raw, "ALLOWED_ORIGINS");
  if (value === undefined) return undefined;
  assertEnvStringByteLength(value, "ALLOWED_ORIGINS", MAX_ALLOWED_ORIGINS_ENV_BYTES);
  const origins = parseAllowedOriginList(value);
  if (origins.length === 0) return undefined;
  return origins.map(parseOrigin);
}

function parseAllowedOriginList(raw: string): string[] {
  if (raw.trim() === "") return [];
  const origins: string[] = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== ",") continue;
    if (origins.length >= 32) throw new Error("ALLOWED_ORIGINS may contain at most 32 origins.");
    const origin = raw.slice(start, index);
    if (origin.length === 0) throw new Error("ALLOWED_ORIGINS entries must not be empty.");
    if (origin !== origin.trim()) throw new Error("ALLOWED_ORIGINS entries must not contain whitespace, separators, control characters, or format characters.");
    origins.push(origin);
    start = index + 1;
  }
  return origins;
}

function parseTurnRestConfig(env: NodeJS.ProcessEnv): TurnRestConfig | undefined {
  const secret = optionalEnvString(envValue(env, "TURN_REST_SECRET"), "TURN_REST_SECRET");
  const rawUrls = optionalEnvString(envValue(env, "TURN_URLS"), "TURN_URLS");
  if (secret !== undefined) assertEnvStringByteLength(secret, "TURN_REST_SECRET", MAX_TURN_REST_SECRET_BYTES);
  if (rawUrls !== undefined) assertEnvStringByteLength(rawUrls, "TURN_URLS", MAX_TURN_URLS_ENV_BYTES);
  const trimmedUrls = rawUrls?.trim();
  if (!secret && !trimmedUrls) return undefined;
  if (!secret || !trimmedUrls) throw new Error("TURN_REST_SECRET and TURN_URLS must be set together.");
  const secretBytes = Buffer.byteLength(secret, "utf8");
  if (secretBytes < TURN_REST_SECRET_MIN_BYTES) {
    throw new Error(`TURN_REST_SECRET must be at least ${TURN_REST_SECRET_MIN_BYTES} bytes.`);
  }
  if (secretBytes > MAX_TURN_REST_SECRET_BYTES) {
    throw new Error(`TURN_REST_SECRET must be at most ${MAX_TURN_REST_SECRET_BYTES} bytes.`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(secret)) throw new Error("TURN_REST_SECRET must not contain control characters or format characters.");
  const urls = parseTurnUrls(trimmedUrls);
  const ttlSeconds = parseTurnTtl(envValue(env, "TURN_TTL_SECONDS"));
  return { urls, secret, ttlSeconds };
}

export function parseTurnUrls(raw: string): string | string[] {
  raw = requiredEnvString(raw, "TURN_URLS");
  assertEnvStringByteLength(raw, "TURN_URLS", MAX_TURN_URLS_ENV_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  const urls = typeof parsed === "string" ? parsed : parseTurnUrlArray(parsed);
  if (urls === null) throw new Error("TURN_URLS must be a TURN URL string or JSON array of TURN URL strings.");
  const list = typeof urls === "string" ? [urls] : urls;
  for (let index = 0; index < list.length; index += 1) {
    const url = list[index]!;
    if (hasUrlCredentials(url)) throw new Error("TURN_URLS must not embed credentials. Use TURN_REST_SECRET for ephemeral TURN credentials.");
    if (!isTurnUrl(url)) throw new Error("TURN_URLS must be a TURN URL string or JSON array of TURN URL strings.");
  }
  return urls;
}

function parseTurnUrlArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURN_URLS) return null;
  const urls: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    urls.push(descriptor.value);
  }
  return urls;
}

const MAX_TURN_URLS = 8;
const MAX_TURN_URL_CHARS = 512;

function isTurnUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_TURN_URL_CHARS || /[\p{Cc}\p{Cf}\s]/u.test(url)) return false;
  const parsed = /^(?:turn|turns):([^?]+)(?:\?transport=(?:udp|tcp))?$/i.exec(url);
  return Boolean(parsed?.[1] && isValidAuthority(parsed[1]));
}

function hasUrlCredentials(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:[^/?#]*@/i.test(url);
}

function parseTurnTtl(raw: unknown): number {
  const value = optionalEnvString(raw, "TURN_TTL_SECONDS");
  if (value !== undefined) assertEnvStringByteLength(value, "TURN_TTL_SECONDS", MAX_SCALAR_ENV_BYTES);
  if (value === undefined || value.trim() === "") return 3600;
  if (!/^\d+$/.test(value)) throw new Error("TURN_TTL_SECONDS must be an integer between 60 and 86400.");
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error("TURN_TTL_SECONDS must be an integer between 60 and 86400.");
  return ttl;
}

function parseBooleanEnv(raw: unknown, name: string): boolean {
  const value = optionalEnvString(raw, name);
  if (value !== undefined) assertEnvStringByteLength(value, name, MAX_SCALAR_ENV_BYTES);
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseWebRoot(raw: unknown): string {
  const value = optionalEnvString(raw, "WEB_ROOT");
  if (value !== undefined) assertEnvStringByteLength(value, "WEB_ROOT", MAX_WEB_ROOT_ENV_BYTES);
  if (value === undefined || value.trim() === "") return defaultWebRoot();
  if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("WEB_ROOT must not contain control characters or format characters.");
  return path.resolve(value);
}

function defaultWebRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist-web");
}

function assertEnvStringByteLength(raw: string, name: string, maxBytes: number): void {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error(`${name} must be at most ${maxBytes} bytes.`);
}

function optionalEnvString(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  return requiredEnvString(raw, name);
}

function requiredEnvString(raw: unknown, name: string): string {
  if (typeof raw !== "string") throw new Error(`${name} must be a string.`);
  return raw;
}

function parseBrowserLoopbackWs(env: NodeJS.ProcessEnv, production: boolean): boolean {
  const raw = optionalEnvString(envValue(env, "BROWSER_ALLOW_LOOPBACK_WS"), "BROWSER_ALLOW_LOOPBACK_WS");
  if (raw !== undefined) assertEnvStringByteLength(raw, "BROWSER_ALLOW_LOOPBACK_WS", MAX_SCALAR_ENV_BYTES);
  if (raw !== undefined && raw.trim() !== "") {
    return parseBooleanEnv(raw, "BROWSER_ALLOW_LOOPBACK_WS");
  }
  return !production;
}

function envValue(env: NodeJS.ProcessEnv, name: string): unknown {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Server environment is invalid.");
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error(`${name} must be a data property.`);
  return descriptor.value;
}

function parseOrigin(origin: string): string {
  if (/[\p{Cc}\p{Cf}\s,]/u.test(origin)) {
    throw new Error("ALLOWED_ORIGINS entries must not contain whitespace, separators, control characters, or format characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("ALLOWED_ORIGINS entries must be exact URL origins.");
  }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("ALLOWED_ORIGINS entries must be exact URL origins.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ALLOWED_ORIGINS entries must use http or https.");
  }
  if (parsed.port === "0") {
    throw new Error("ALLOWED_ORIGINS entries must not use port 0.");
  }
  if (!isValidOriginHostname(parsed.hostname)) {
    throw new Error("ALLOWED_ORIGINS entries must contain valid hostnames or IP addresses.");
  }
  return parsed.origin;
}

export function originAllowed(origin: unknown, allowedOrigins: readonly string[] | undefined): boolean {
  if (origin !== undefined && typeof origin !== "string") return false;
  if (allowedOrigins === undefined) return true;
  if (origin === undefined) return true;
  return allowedOriginContains(allowedOrigins, origin);
}

export function originAllowedForRequest(origin: unknown, allowedOrigins: readonly string[] | undefined, requestAuthority: unknown): boolean {
  if (!originAllowed(origin, allowedOrigins)) return false;
  if (allowedOrigins || origin === undefined) return true;
  return typeof requestAuthority === "string" && isLoopbackAuthority(requestAuthority) && typeof origin === "string" && originUsesLoopbackAuthority(origin);
}

export function corsHeaders(origin: unknown, allowedOrigins: readonly string[] | undefined): Record<string, string> | null {
  if (origin !== undefined && typeof origin !== "string") return null;
  if (allowedOrigins === undefined) return { "access-control-allow-origin": "*" };
  if (origin === undefined) return {};
  if (!allowedOriginContains(allowedOrigins, origin)) return null;
  return {
    "access-control-allow-origin": origin,
    vary: "Origin"
  };
}

function allowedOriginContains(allowedOrigins: readonly string[], origin: string): boolean {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 32) return false;
  for (let index = 0; index < allowedOrigins.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(allowedOrigins, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false;
    if (descriptor.value === origin) return true;
  }
  return false;
}

function originUsesLoopbackAuthority(origin: string): boolean {
  if (origin.length === 0 || origin.length > MAX_ORIGIN_HEADER_BYTES || utf8ByteLengthExceeds(origin, MAX_ORIGIN_HEADER_BYTES) || /[\p{Cc}\p{Cf}\s,]/u.test(origin)) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin && parsed.port !== "0" && isLoopbackAuthority(parsed.host);
  } catch {
    return false;
  }
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
