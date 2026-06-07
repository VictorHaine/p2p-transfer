import { ENCRYPTED_JSON_MAX_CHARS, MAX_FILE_BYTES, MAX_FILE_NAME_CHARS, MAX_FILES_PER_SESSION, MAX_MIME_CHARS, PROTOCOL_VERSION, SIGNALING_MAX_PAYLOAD_BYTES } from "./constants.js";
import { isValidAuthority } from "./authority.js";
import { isValidRendezvous } from "./wordlist.js";

export type Role = "sender" | "receiver";

export type SignalPayload =
  | { kind: "offer"; sdp: string; auth: string }
  | { kind: "answer"; sdp: string; auth: string }
  | { kind: "candidate"; candidate: RTCIceCandidateInit; auth: string };

export type FileManifestEntry = {
  id?: number;
  name: string;
  size: number;
  mime?: string;
};

export type FileManifest = {
  files: FileManifestEntry[];
  fileCount: number;
  totalBytes: number;
};

export type PairRejectReason = "user_declined";

export type ClientMessage =
  | { type: "register"; role: "receiver"; code: string; protocolVersion: number }
  | { type: "connect"; role: "sender"; code: string; protocolVersion: number }
  | { type: "pake"; sid: string; data: string }
  | { type: "confirm"; sid: string; tag: string }
  | { type: "pair-request"; sid: string; manifest: FileManifest; sealedManifest: string }
  | { type: "pair-accept"; sid: string; auth: string }
  | { type: "pair-reject"; sid: string; auth: string; reason: PairRejectReason }
  | { type: "signal"; sid: string; signal: SignalPayload }
  | { type: "bye"; sid?: string; reason?: string };

export type ServerMessage =
  | { type: "registered"; code: string; expiresInSec: number }
  | { type: "peer-joined"; sid: string }
  | { type: "pake"; sid: string; data: string }
  | { type: "confirm"; sid: string; tag: string }
  | { type: "pair-request"; sid: string; manifest: FileManifest; sealedManifest: string }
  | { type: "pair-accept"; sid: string; auth: string }
  | { type: "pair-reject"; sid: string; auth: string; reason: PairRejectReason }
  | { type: "signal"; sid: string; signal: SignalPayload }
  | { type: "peer-left"; sid: string; reason?: string }
  | { type: "ice-config"; iceServers: RTCIceServer[] }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "code_taken"
  | "code_not_found"
  | "expired"
  | "rate_limited"
  | "bad_protocol"
  | "bad_message"
  | "session_not_found"
  | "peer_unavailable"
  | "transfer_rejected";

const ERROR_CODES: readonly ErrorCode[] = [
  "code_taken",
  "code_not_found",
  "expired",
  "rate_limited",
  "bad_protocol",
  "bad_message",
  "session_not_found",
  "peer_unavailable",
  "transfer_rejected"
];

export function signalingErrorDisplayMessage(code: ErrorCode): string {
  switch (code) {
    case "code_taken":
      return "That receive code is already waiting for a sender.";
    case "code_not_found":
      return "No receiver is waiting for that code.";
    case "expired":
      return "Receive code expired.";
    case "rate_limited":
      return "Too many signaling attempts. Try again shortly.";
    case "bad_protocol":
      return "The signaling protocol is not compatible.";
    case "bad_message":
      return "The signaling server rejected a protocol message.";
    case "session_not_found":
      return "Session is no longer active.";
    case "peer_unavailable":
      return "Peer is no longer connected.";
    case "transfer_rejected":
      return "Transfer rejected.";
  }
}

const MAX_SID_CHARS = 128;
const MAX_PAKE_BYTES = 4096;
const MAX_REASON_CHARS = 1000;
const PAIR_REJECT_REASON: PairRejectReason = "user_declined";
const MAX_SEALED_MANIFEST_CHARS = ENCRYPTED_JSON_MAX_CHARS;
const MAX_SDP_BYTES = 128 * 1024;
const MAX_CANDIDATE_BYTES = 4096;
const MAX_ICE_TOKEN_BYTES = 256;
const MAX_ERROR_MESSAGE_CHARS = 1000;
const MAX_ICE_SERVERS = 16;
const MAX_ICE_URLS_PER_SERVER = 8;
const MAX_ICE_URL_CHARS = 512;
const MAX_ICE_USERNAME_CHARS = 1024;
const MAX_ICE_CREDENTIAL_CHARS = 1024;
const HMAC_SHA256_BYTES = 32;
const MIN_ENCRYPTED_JSON_BASE64_CHARS = 20;
const MAX_SIGNALING_JSON_DEPTH = 32;
const MAX_SIGNALING_JSON_NODES = 10_000;
const text = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

type JsonStringifyContext = {
  seen: WeakSet<object>;
  remainingNodes: number;
  chars: number;
};

export function isProtocolSupported(version: unknown): version is typeof PROTOCOL_VERSION {
  return version === PROTOCOL_VERSION;
}

export function parseJsonMessage(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  if (raw.length > SIGNALING_MAX_PAYLOAD_BYTES) return null;
  if (utf8ByteLength(raw) > SIGNALING_MAX_PAYLOAD_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseJsonTextFrame(data: unknown, isBinary: boolean): unknown {
  if (isBinary) return null;
  if (typeof data === "string") return parseJsonMessage(data);
  if (data instanceof Uint8Array) {
    const byteLength = canonicalBinaryFrameByteLength(data);
    if (byteLength === null || byteLength > SIGNALING_MAX_PAYLOAD_BYTES) return null;
    try {
      return parseJsonMessage(fatalUtf8.decode(data));
    } catch {
      return null;
    }
  }
  return null;
}

function canonicalBinaryFrameByteLength(value: Uint8Array): number | null {
  if (!isCanonicalBinaryPrototype(value) || !TYPED_ARRAY_BYTE_LENGTH_GETTER) return null;
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  return Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : null;
}

function isCanonicalBinaryPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Uint8Array.prototype) return true;
  return typeof Buffer !== "undefined" && prototype === Buffer.prototype;
}

export function parseBrowserJsonMessage(data: unknown): unknown {
  return typeof data === "string" ? parseJsonMessage(data) : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && hasOnlyDataProperties(value);
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isObject(value)) return false;
  const type = ownDataValue(value, "type");
  if (typeof type !== "string") return false;
  switch (type) {
    case "register":
      return hasOnlyKeys(value, ["type", "role", "code", "protocolVersion"]) && ownDataValue(value, "role") === "receiver" && isValidRendezvous(ownDataValue(value, "code")) && isSafeNonNegativeInteger(ownDataValue(value, "protocolVersion"));
    case "connect":
      return hasOnlyKeys(value, ["type", "role", "code", "protocolVersion"]) && ownDataValue(value, "role") === "sender" && isValidRendezvous(ownDataValue(value, "code")) && isSafeNonNegativeInteger(ownDataValue(value, "protocolVersion"));
    case "pake":
      return hasOnlyKeys(value, ["type", "sid", "data"]) && isSessionId(ownDataValue(value, "sid")) && isNonEmptyByteBoundedString(ownDataValue(value, "data"), MAX_PAKE_BYTES);
    case "confirm":
      return hasOnlyKeys(value, ["type", "sid", "tag"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "tag"), HMAC_SHA256_BYTES);
    case "pair-request":
      return hasOnlyKeys(value, ["type", "sid", "manifest", "sealedManifest"]) && isSessionId(ownDataValue(value, "sid")) && isManifest(ownDataValue(value, "manifest")) && isBoundedCanonicalBase64(ownDataValue(value, "sealedManifest"), MIN_ENCRYPTED_JSON_BASE64_CHARS, MAX_SEALED_MANIFEST_CHARS);
    case "pair-accept":
      return hasOnlyKeys(value, ["type", "sid", "auth"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES);
    case "pair-reject":
      return hasOnlyKeys(value, ["type", "sid", "reason", "auth"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES) && isPairRejectReason(ownDataValue(value, "reason"));
    case "signal":
      return hasOnlyKeys(value, ["type", "sid", "signal"]) && isSessionId(ownDataValue(value, "sid")) && isSignalPayload(ownDataValue(value, "signal"));
    case "bye":
      return hasOnlyKeys(value, ["type", "sid", "reason"]) && optionalSessionId(ownDataValue(value, "sid")) && optionalSafeReason(ownDataValue(value, "reason"));
    default:
      return false;
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isObject(value)) return false;
  const type = ownDataValue(value, "type");
  if (typeof type !== "string") return false;
  switch (type) {
    case "registered":
      return hasOnlyKeys(value, ["type", "code", "expiresInSec"]) && isValidRendezvous(ownDataValue(value, "code")) && isSafeNonNegativeInteger(ownDataValue(value, "expiresInSec"));
    case "peer-joined":
      return hasOnlyKeys(value, ["type", "sid"]) && isSessionId(ownDataValue(value, "sid"));
    case "pake":
      return hasOnlyKeys(value, ["type", "sid", "data"]) && isSessionId(ownDataValue(value, "sid")) && isNonEmptyByteBoundedString(ownDataValue(value, "data"), MAX_PAKE_BYTES);
    case "confirm":
      return hasOnlyKeys(value, ["type", "sid", "tag"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "tag"), HMAC_SHA256_BYTES);
    case "pair-request":
      return hasOnlyKeys(value, ["type", "sid", "manifest", "sealedManifest"]) && isSessionId(ownDataValue(value, "sid")) && isManifest(ownDataValue(value, "manifest")) && isBoundedCanonicalBase64(ownDataValue(value, "sealedManifest"), MIN_ENCRYPTED_JSON_BASE64_CHARS, MAX_SEALED_MANIFEST_CHARS);
    case "pair-accept":
      return hasOnlyKeys(value, ["type", "sid", "auth"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES);
    case "pair-reject":
      return hasOnlyKeys(value, ["type", "sid", "reason", "auth"]) && isSessionId(ownDataValue(value, "sid")) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES) && isPairRejectReason(ownDataValue(value, "reason"));
    case "signal":
      return hasOnlyKeys(value, ["type", "sid", "signal"]) && isSessionId(ownDataValue(value, "sid")) && isSignalPayload(ownDataValue(value, "signal"));
    case "peer-left":
      return hasOnlyKeys(value, ["type", "sid", "reason"]) && isSessionId(ownDataValue(value, "sid")) && optionalSafeReason(ownDataValue(value, "reason"));
    case "ice-config":
      return hasOnlyKeys(value, ["type", "iceServers"]) && isIceServers(ownDataValue(value, "iceServers"));
    case "error":
      return hasOnlyKeys(value, ["type", "code", "message"]) && isErrorCode(ownDataValue(value, "code")) && isSafeNonEmptyBoundedString(ownDataValue(value, "message"), MAX_ERROR_MESSAGE_CHARS);
    default:
      return false;
  }
}

export function isIceServers(value: unknown): value is RTCIceServer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ICE_SERVERS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const item = ownArrayDataValue(value, index);
    if (item === undefined || !isIceServer(item)) return false;
  }
  return true;
}

export function isManifest(value: unknown): value is FileManifest {
  if (!isObject(value) || !hasOnlyKeys(value, ["files", "fileCount", "totalBytes"])) return false;
  const files = ownDataValue(value, "files");
  const fileCount = ownDataValue(value, "fileCount");
  const expectedTotalBytes = ownDataValue(value, "totalBytes");
  if (!Array.isArray(files)) return false;
  if (!isSafeNonNegativeInteger(fileCount) || fileCount < 1 || fileCount > MAX_FILES_PER_SESSION || fileCount !== files.length) return false;
  if (!isSafeNonNegativeInteger(expectedTotalBytes)) return false;
  const ids = new Set<number>();
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = ownArrayDataValue(files, index);
    const id = ownDataValue(file, "id");
    const name = ownDataValue(file, "name");
    const size = ownDataValue(file, "size");
    const mime = ownDataValue(file, "mime");
    if (
      file === undefined ||
      !isObject(file) ||
      !hasOnlyKeys(file, ["id", "name", "size", "mime"]) ||
      !isOptionalUint8(id) ||
      !isSafeManifestFileName(name) ||
      !isSafeNonNegativeInteger(size) ||
      size > MAX_FILE_BYTES ||
      (mime !== undefined && !isMimeType(mime))
    ) {
      return false;
    }
    if (id !== undefined) {
      if (typeof id !== "number" || ids.has(id)) return false;
      ids.add(id);
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes)) return false;
  }
  return totalBytes === expectedTotalBytes;
}

function isOptionalUint8(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= 255);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeManifestFileName(value: unknown): value is string {
  return (
    isSafeNonEmptyBoundedString(value, MAX_FILE_NAME_CHARS) &&
    value.trim().length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/.test(value)
  );
}

function isSignalPayload(value: unknown): value is SignalPayload {
  if (!isObject(value)) return false;
  const kind = ownDataValue(value, "kind");
  if (kind === "offer" || kind === "answer") {
    return hasOnlyKeys(value, ["kind", "sdp", "auth"]) && isNonEmptyByteBoundedString(ownDataValue(value, "sdp"), MAX_SDP_BYTES) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES);
  }
  if (kind === "candidate") return hasOnlyKeys(value, ["kind", "candidate", "auth"]) && isIceCandidateInit(ownDataValue(value, "candidate")) && isBase64EncodedBytes(ownDataValue(value, "auth"), HMAC_SHA256_BYTES);
  return false;
}

function isIceCandidateInit(value: unknown): value is RTCIceCandidateInit {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) return false;
  const candidate = ownDataValue(value, "candidate");
  const sdpMid = ownDataValue(value, "sdpMid");
  const sdpMLineIndex = ownDataValue(value, "sdpMLineIndex");
  const usernameFragment = ownDataValue(value, "usernameFragment");
  const hasSdpMid = sdpMid !== null && sdpMid !== undefined;
  const hasSdpMLineIndex = sdpMLineIndex !== null && sdpMLineIndex !== undefined;
  return (
    isSafeNonEmptyByteBoundedString(candidate, MAX_CANDIDATE_BYTES) &&
    (hasSdpMid || hasSdpMLineIndex) &&
    (!hasSdpMid || isSafeTokenString(sdpMid, MAX_ICE_TOKEN_BYTES)) &&
    (sdpMLineIndex === null ||
      sdpMLineIndex === undefined ||
      (typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 65535)) &&
    (usernameFragment === undefined || usernameFragment === null || isSafeTokenString(usernameFragment, MAX_ICE_TOKEN_BYTES))
  );
}

function isIceServer(value: unknown): value is RTCIceServer {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, ["urls", "username", "credential", "credentialType"])) return false;
  const urls = ownDataValue(value, "urls");
  const username = ownDataValue(value, "username");
  const credential = ownDataValue(value, "credential");
  const credentialType = ownDataValue(value, "credentialType");
  const urlList = typeof urls === "string" ? [urls] : Array.isArray(urls) ? ownDataArrayValues(urls) : null;
  const validUrls = Boolean(urlList && urlList.length > 0 && urlList.length <= MAX_ICE_URLS_PER_SERVER && arrayEvery(urlList, isIceUrl));
  const hasTurnUrl = Boolean(urlList && arraySome(urlList, isTurnUrl));
  const hasNoCredential = username === undefined && credential === undefined;
  const hasCompleteCredential = isSafeNonEmptyBoundedString(username, MAX_ICE_USERNAME_CHARS) && isSafeNonEmptyBoundedString(credential, MAX_ICE_CREDENTIAL_CHARS);
  return (
    validUrls &&
    (hasNoCredential || hasCompleteCredential) &&
    (!hasTurnUrl || hasCompleteCredential) &&
    (credentialType === undefined || (credentialType === "password" && hasCompleteCredential))
  );
}

function isIceUrl(url: unknown): url is string {
  if (!isSafeBoundedString(url, MAX_ICE_URL_CHARS)) return false;
  const parsed = /^(?:stun|stuns|turn|turns):([^?]+)(?:\?transport=(?:udp|tcp))?$/i.exec(url);
  return Boolean(parsed?.[1] && isValidAuthority(parsed[1]));
}

function isTurnUrl(url: unknown): url is string {
  return typeof url === "string" && /^(?:turn|turns):/i.test(url);
}

function ownDataArrayValues(value: unknown[]): unknown[] | null {
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = ownArrayDataValue(value, index);
    if (item === undefined) return null;
    out.push(item);
  }
  return out;
}

function ownArrayDataValue(value: unknown[], index: number): unknown | undefined {
  return ownDataValue(value, String(index));
}

function ownDataValue(value: unknown, key: string): unknown | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function optionalSessionId(value: unknown): boolean {
  return value === undefined || isSessionId(value);
}

function optionalSafeReason(value: unknown): boolean {
  return value === undefined || isSafeBoundedString(value, MAX_REASON_CHARS);
}

function isPairRejectReason(value: unknown): value is PairRejectReason {
  return value === PAIR_REJECT_REASON;
}

function arrayEvery<T>(values: T[], predicate: (value: T) => boolean): boolean {
  for (const value of values) {
    if (!predicate(value)) return false;
  }
  return true;
}

function arraySome<T>(values: T[], predicate: (value: T) => boolean): boolean {
  for (const value of values) {
    if (predicate(value)) return true;
  }
  return false;
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isSafeBoundedString(value: unknown, maxChars: number): value is string {
  return isBoundedString(value, maxChars) && !UNSAFE_TEXT_CHARS.test(value);
}

function isSafeNonEmptyBoundedString(value: unknown, maxChars: number): value is string {
  return isSafeBoundedString(value, maxChars) && value.length > 0;
}

function isSafeTokenString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && SAFE_ASCII_TOKEN.test(value);
}

function isByteBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= maxBytes;
}

function isNonEmptyByteBoundedString(value: unknown, maxBytes: number): value is string {
  return isByteBoundedString(value, maxBytes) && value.length > 0;
}

function isSafeByteBoundedString(value: unknown, maxBytes: number): value is string {
  return isByteBoundedString(value, maxBytes) && !UNSAFE_TEXT_CHARS.test(value);
}

function isSafeNonEmptyByteBoundedString(value: unknown, maxBytes: number): value is string {
  return isSafeByteBoundedString(value, maxBytes) && value.length > 0;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SID_CHARS && SESSION_ID_VALUE.test(value);
}

function isMimeType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MIME_CHARS && MIME_TYPE_VALUE.test(value);
}

const UNSAFE_TEXT_CHARS = /[\p{Cc}\p{Cf}]/u;
const SAFE_ASCII_TOKEN = /^[!-~]+$/;
const SESSION_ID_VALUE = /^[A-Za-z0-9_-]+$/;
const MIME_TYPE_VALUE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isBase64EncodedBytes(value: unknown, decodedBytes: number): value is string {
  return typeof value === "string" && value.length % 4 === 0 && CANONICAL_BASE64.test(value) && hasCanonicalBase64Padding(value) && base64DecodedByteLength(value) === decodedBytes;
}

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isBoundedCanonicalBase64(value: unknown, minChars: number, maxChars: number): value is string {
  return typeof value === "string" && value.length >= minChars && value.length <= maxChars && value.length % 4 === 0 && CANONICAL_BASE64.test(value) && hasCanonicalBase64Padding(value);
}

function hasCanonicalBase64Padding(value: string): boolean {
  if (value.endsWith("==")) return (base64Index(value[value.length - 3]!) & 0x0f) === 0;
  if (value.endsWith("=")) return (base64Index(value[value.length - 2]!) & 0x03) === 0;
  return true;
}

function base64Index(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (char === "+") return 62;
  if (char === "/") return 63;
  return -1;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function hasOnlyDataProperties(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value as ErrorCode);
}

export function serializeMessage(message: ClientMessage | ServerMessage): string {
  const serialized = stringifyJsonData(message);
  if (utf8ByteLength(serialized) > SIGNALING_MAX_PAYLOAD_BYTES) throw new Error("Signaling message exceeds maximum frame size.");
  const parsed = parseJsonMessage(serialized);
  if (!isClientMessage(parsed) && !isServerMessage(parsed)) throw new Error("Signaling message is not a valid protocol message.");
  return serialized;
}

function stringifyJsonData(value: unknown): string {
  const serialized = stringifyJsonValue(value, { seen: new WeakSet<object>(), remainingNodes: MAX_SIGNALING_JSON_NODES, chars: 0 }, 0);
  if (serialized === undefined) throw new Error("Signaling message is not JSON serializable.");
  return serialized;
}

function stringifyJsonValue(value: unknown, context: JsonStringifyContext, depth: number): string | undefined {
  if (context.remainingNodes <= 0 || depth > MAX_SIGNALING_JSON_DEPTH) throw new Error("Signaling message exceeds maximum frame size.");
  switch (typeof value) {
    case "string":
      return checkedJsonFragment(JSON.stringify(value), context);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Signaling message is not JSON serializable.");
      return checkedJsonFragment(String(value), context);
    case "boolean":
      return checkedJsonFragment(value ? "true" : "false", context);
    case "object":
      if (value === null) return checkedJsonFragment("null", context);
      return Array.isArray(value) ? stringifyJsonArray(value, context, depth) : stringifyJsonRecord(value, context, depth);
    default:
      return undefined;
  }
}

function stringifyJsonArray(value: unknown[], context: JsonStringifyContext, depth: number): string {
  beginJsonObject(value, context, depth);
  try {
    const out: string[] = [];
    checkedJsonFragment("[", context);
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) checkedJsonFragment(",", context);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new Error("Signaling message is not JSON serializable.");
      out.push(stringifyJsonValue(descriptor.value, context, depth + 1) ?? checkedJsonFragment("null", context));
    }
    checkedJsonFragment("]", context);
    return `[${out.join(",")}]`;
  } finally {
    context.seen.delete(value);
  }
}

function stringifyJsonRecord(value: object, context: JsonStringifyContext, depth: number): string {
  if (!isObject(value)) throw new Error("Signaling message is not JSON serializable.");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Signaling message is not JSON serializable.");
  beginJsonObject(value, context, depth);
  try {
    if (Object.prototype.hasOwnProperty.call(value, "toJSON")) throw new Error("Signaling message is not JSON serializable.");
    const out: string[] = [];
    checkedJsonFragment("{", context);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new Error("Signaling message is not JSON serializable.");
      const serializedValue = stringifyJsonValue(descriptor.value, context, depth + 1);
      if (serializedValue === undefined) continue;
      if (out.length > 0) checkedJsonFragment(",", context);
      checkedJsonFragment(":", context);
      out.push(`${checkedJsonFragment(JSON.stringify(key), context)}:${serializedValue}`);
    }
    checkedJsonFragment("}", context);
    return `{${out.join(",")}}`;
  } finally {
    context.seen.delete(value);
  }
}

function beginJsonObject(value: object, context: JsonStringifyContext, depth: number): void {
  if (context.seen.has(value)) throw new Error("Signaling message is not JSON serializable.");
  if (depth > MAX_SIGNALING_JSON_DEPTH) throw new Error("Signaling message exceeds maximum frame size.");
  context.remainingNodes -= 1;
  if (context.remainingNodes < 0) throw new Error("Signaling message exceeds maximum frame size.");
  context.seen.add(value);
}

function checkedJsonFragment(fragment: string, context: JsonStringifyContext): string {
  context.chars += fragment.length;
  if (context.chars > SIGNALING_MAX_PAYLOAD_BYTES) throw new Error("Signaling message exceeds maximum frame size.");
  return fragment;
}

function utf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
  return text.encode(value).byteLength;
}
