import { cpace } from "@cipherman/pake-js";
import type { webcrypto } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CHUNK_SIZE, ENCRYPTED_JSON_MAX_CHARS } from "./constants.js";
import type { SignalPayload } from "./messages.js";

type CryptoKey = webcrypto.CryptoKey;
type KeyUsage = webcrypto.KeyUsage;

export type PakeRole = "sender" | "receiver";

export type PakeState = {
  role: PakeRole;
  sid: string;
  ephemeralSecret: Uint8Array;
  share: Uint8Array;
};

export type SessionKeys = {
  sid: string;
  role: PakeRole;
  sas: string;
  destroyed: boolean;
  signalAuthKey: Uint8Array;
  manifestKey?: CryptoKey;
  controlSendKey?: CryptoKey;
  controlRecvKey?: CryptoKey;
  bulkSendKey?: CryptoKey;
  bulkRecvKey?: CryptoKey;
};

type ActiveAeadSessionKeys = {
  sid: string;
  manifestKey: CryptoKey;
  controlSendKey: CryptoKey;
  controlRecvKey: CryptoKey;
  bulkSendKey: CryptoKey;
  bulkRecvKey: CryptoKey;
};

type PakeStateParts = {
  role: PakeRole;
  sid: string;
  ephemeralSecret: Uint8Array;
  share: Uint8Array;
};

const text = new TextEncoder();
const jsonText = new TextDecoder("utf-8", { fatal: true });
const CPACE_CONTEXT = text.encode("p2p-transfer cpace v1");
const HKDF_CONTEXT = text.encode("p2p-transfer session keys v1");
const CPACE_SHARE_BYTES = 32;
const CPACE_SHARE_BASE64_CHARS = 44;
const AUTHENTICATION_KEY_BYTES = 32;
const HMAC_SHA256_BASE64_CHARS = 44;
const BASE64_DECODE_MAX_CHARS = ENCRYPTED_JSON_MAX_CHARS;
const MAX_PAKE_MESSAGE_BYTES = 4096;
const MAX_PAKE_CONTEXT_CHARS = 256;
const MAX_AUTH_SDP_BYTES = 128 * 1024;
const MAX_AUTH_CANDIDATE_BYTES = 4096;
const MAX_AUTH_TOKEN_BYTES = 256;
const MAX_PAIR_DECISION_REASON_CHARS = 1000;
const AES_GCM_TAG_BYTES = 16;
const MAX_BULK_SEALED_BYTES = CHUNK_SIZE + AES_GCM_TAG_BYTES;
const MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES = Math.floor(ENCRYPTED_JSON_MAX_CHARS / 4) * 3 - 12 - AES_GCM_TAG_BYTES;
const MAX_ENCRYPTED_JSON_DEPTH = 32;
const MAX_ENCRYPTED_JSON_NODES = 10_000;
const UNSAFE_TEXT_CHARS = /[\p{Cc}\p{Cf}]/u;
const SAFE_ASCII_TOKEN = /^[!-~]+$/;
const SESSION_ID_VALUE = /^[A-Za-z0-9_-]+$/;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const RuntimeCryptoKey = (globalThis as typeof globalThis & { CryptoKey?: { new (...args: never[]): webcrypto.CryptoKey } }).CryptoKey;

export function startPake(role: PakeRole, code: string, sid: string): PakeState {
  assertPakeRole(role);
  assertPakeCode(code);
  assertPakeSid(sid);
  const password = passwordBytes(code);
  try {
    const started = cpace.ristretto255.init({
      PRS: password,
      sid: text.encode(sid),
      CI: CPACE_CONTEXT
    });
    return { role, sid, ephemeralSecret: started.ephemeralSecret, share: started.share };
  } finally {
    password.fill(0);
  }
}

export async function finishPake(state: PakeState, peerShareB64: string): Promise<SessionKeys> {
  let peerShare: Uint8Array | undefined;
  let isk: Uint8Array | undefined;
  let raw: ReturnType<typeof deriveRawKeys> | undefined;
  try {
    const stateParts = readPakeState(state);
    if (typeof peerShareB64 !== "string" || peerShareB64.length !== CPACE_SHARE_BASE64_CHARS) throw new Error("Peer sent an invalid PAKE share.");
    peerShare = base64ToBytes(peerShareB64);
    if (peerShare.byteLength !== CPACE_SHARE_BYTES) throw new Error("Peer sent an invalid PAKE share.");
    isk = cpace.ristretto255.deriveIskInitiatorResponder({
      ephemeralSecret: stateParts.ephemeralSecret,
      ownShare: stateParts.share,
      peerShare,
      ownAD: text.encode(stateParts.role),
      peerAD: text.encode(stateParts.role === "sender" ? "receiver" : "sender"),
      sid: text.encode(stateParts.sid),
      role: stateParts.role === "sender" ? "initiator" : "responder"
    });
    raw = deriveRawKeys(isk, stateParts.sid);
    const sasHex = bytesToHex(raw.sas).slice(0, 12);
    return {
      sid: stateParts.sid,
      role: stateParts.role,
      sas: sasHex.match(/.{1,4}/g)?.join("-") ?? sasHex,
      destroyed: false,
      signalAuthKey: webBytes(raw.signalAuthKey),
      manifestKey: await importAesKey(raw.manifestKey, stateParts.role === "sender" ? ["encrypt"] : ["decrypt"]),
      controlSendKey: await importAesKey(stateParts.role === "sender" ? raw.controlSenderToReceiver : raw.controlReceiverToSender, ["encrypt"]),
      controlRecvKey: await importAesKey(stateParts.role === "sender" ? raw.controlReceiverToSender : raw.controlSenderToReceiver, ["decrypt"]),
      bulkSendKey: await importAesKey(stateParts.role === "sender" ? raw.bulkSenderToReceiver : raw.bulkReceiverToSender, ["encrypt"]),
      bulkRecvKey: await importAesKey(stateParts.role === "sender" ? raw.bulkReceiverToSender : raw.bulkSenderToReceiver, ["decrypt"])
    };
  } finally {
    wipePakeState(state);
    peerShare?.fill(0);
    isk?.fill(0);
    if (raw) {
      raw.signalAuthKey.fill(0);
      raw.manifestKey.fill(0);
      raw.controlSenderToReceiver.fill(0);
      raw.controlReceiverToSender.fill(0);
      raw.bulkSenderToReceiver.fill(0);
      raw.bulkReceiverToSender.fill(0);
      raw.sas.fill(0);
    }
  }
}

export function ownPakeShareB64(state: PakeState): string {
  const share = ownDataValue(state, "share");
  if (!(share instanceof Uint8Array)) throw new Error("PAKE state is invalid.");
  return bytesToBase64(share);
}

export function wipePakeState(state: PakeState): void {
  fillOwnBytes(state, "ephemeralSecret");
  fillOwnBytes(state, "share");
}

export function wipeSessionKeys(keys: SessionKeys | undefined): void {
  if (!isObjectLike(keys) || ownDataValue(keys, "destroyed") === true) return;
  fillOwnBytes(keys, "signalAuthKey");
  deleteOwnProperty(keys, "manifestKey");
  deleteOwnProperty(keys, "controlSendKey");
  deleteOwnProperty(keys, "controlRecvKey");
  deleteOwnProperty(keys, "bulkSendKey");
  deleteOwnProperty(keys, "bulkRecvKey");
  defineOwnData(keys, "destroyed", true);
}

export function parsePakeShareMessage(data: string): string {
  if (typeof data !== "string" || data.length === 0 || utf8ByteLengthExceeds(data, MAX_PAKE_MESSAGE_BYTES)) {
    throw new Error("Peer sent an invalid PAKE message.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Peer sent an invalid PAKE message.");
  }
  if (!isPlainObject(parsed) || !hasOnlyKeys(parsed, ["t", "share"])) {
    throw new Error("Peer sent an invalid PAKE message.");
  }
  const type = ownDataValue(parsed, "t");
  const shareValue = ownDataValue(parsed, "share");
  if (type !== "cpace-share" || typeof shareValue !== "string") {
    throw new Error("Peer sent an invalid PAKE message.");
  }
  if (shareValue.length !== CPACE_SHARE_BASE64_CHARS) {
    throw new Error("Peer sent an invalid PAKE share.");
  }
  let share: Uint8Array;
  try {
    share = base64ToBytes(shareValue);
  } catch {
    throw new Error("Peer sent an invalid PAKE share.");
  }
  try {
    if (share.byteLength !== CPACE_SHARE_BYTES) {
      throw new Error("Peer sent an invalid PAKE share.");
    }
  } finally {
    share.fill(0);
  }
  return shareValue;
}

export function sdpAuthTag(key: Uint8Array, sid: string, fromRole: PakeRole, kind: "offer" | "answer", sdp: string): string {
  return signalAuthTag(key, sid, fromRole, { kind, sdp });
}

export function verifySdpAuthTag(key: Uint8Array, sid: string, fromRole: PakeRole, kind: "offer" | "answer", sdp: string, tag: string | undefined): boolean {
  return verifySignalAuthTag(key, sid, fromRole, { kind, sdp, auth: tag ?? "" });
}

export function signalAuthTag(key: Uint8Array, sid: string, fromRole: PakeRole, signal: SignalPayloadForAuth): string {
  const authKey = authenticationKeyCopy(key);
  assertPakeSid(sid);
  assertPakeRole(fromRole);
  const tag = hmac(sha256, authKey, text.encode(canonicalSignalForAuth(sid, fromRole, signal)));
  try {
    return bytesToBase64(tag);
  } finally {
    tag.fill(0);
    authKey.fill(0);
  }
}

export function verifySignalAuthTag(key: Uint8Array, sid: string, fromRole: PakeRole, signal: SignalPayload): boolean {
  const tag = ownDataValue(signal, "auth");
  if (typeof tag !== "string" || tag.length !== HMAC_SHA256_BASE64_CHARS) return false;
  let expected: Uint8Array | undefined;
  let actual: Uint8Array | undefined;
  try {
    expected = base64ToBytes(signalAuthTag(key, sid, fromRole, signalPayloadForAuth(signal)));
    actual = base64ToBytes(tag);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  } finally {
    expected?.fill(0);
    actual?.fill(0);
  }
}

function signalPayloadForAuth(signal: SignalPayload): SignalPayloadForAuth {
  assertSignalPayloadForVerify(signal);
  const kind = ownDataValue(signal, "kind");
  if (kind === "offer" || kind === "answer") return { kind, sdp: ownDataValue(signal, "sdp") as string };
  return { kind: "candidate", candidate: ownDataValue(signal, "candidate") as RTCIceCandidateInit };
}

export function sessionConfirmTag(key: Uint8Array, sid: string, fromRole: PakeRole): string {
  const authKey = authenticationKeyCopy(key);
  assertPakeSid(sid);
  assertPakeRole(fromRole);
  const tag = hmac(sha256, authKey, text.encode(JSON.stringify({ v: 1, t: "session-confirm", sid, fromRole })));
  try {
    return bytesToBase64(tag);
  } finally {
    tag.fill(0);
    authKey.fill(0);
  }
}

export function verifySessionConfirmTag(key: Uint8Array, sid: string, fromRole: PakeRole, tag: string): boolean {
  if (typeof tag !== "string" || tag.length !== HMAC_SHA256_BASE64_CHARS) return false;
  let expected: Uint8Array | undefined;
  let actual: Uint8Array | undefined;
  try {
    expected = base64ToBytes(sessionConfirmTag(key, sid, fromRole));
    actual = base64ToBytes(tag);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  } finally {
    expected?.fill(0);
    actual?.fill(0);
  }
}

export function pairDecisionAuthTag(key: Uint8Array, sid: string, fromRole: PakeRole, decision: "accept" | "reject", sealedManifest: string, reason?: string): string {
  const authKey = authenticationKeyCopy(key);
  const tag = hmac(sha256, authKey, text.encode(canonicalPairDecisionForAuth(sid, fromRole, decision, sealedManifest, reason)));
  try {
    return bytesToBase64(tag);
  } finally {
    tag.fill(0);
    authKey.fill(0);
  }
}

export function verifyPairDecisionAuthTag(
  key: Uint8Array,
  sid: string,
  fromRole: PakeRole,
  decision: "accept" | "reject",
  sealedManifest: string,
  reason: string | undefined,
  tag: string | undefined
): boolean {
  if (typeof tag !== "string" || tag.length !== HMAC_SHA256_BASE64_CHARS) return false;
  let expected: Uint8Array | undefined;
  let actual: Uint8Array | undefined;
  try {
    expected = base64ToBytes(pairDecisionAuthTag(key, sid, fromRole, decision, sealedManifest, reason));
    actual = base64ToBytes(tag);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  } finally {
    expected?.fill(0);
    actual?.fill(0);
  }
}

function assertPakeRole(role: unknown): asserts role is PakeRole {
  if (role !== "sender" && role !== "receiver") throw new Error("PAKE role is invalid.");
}

function canonicalPairDecisionForAuth(sid: string, fromRole: PakeRole, decision: "accept" | "reject", sealedManifest: string, reason?: string): string {
  assertPakeSid(sid);
  assertPakeRole(fromRole);
  if (decision !== "accept" && decision !== "reject") throw new Error("Pair decision is invalid.");
  if (!isNonEmptyByteBoundedString(sealedManifest, ENCRYPTED_JSON_MAX_CHARS) || !SAFE_ASCII_TOKEN.test(sealedManifest)) {
    throw new Error("Pair decision manifest is invalid.");
  }
  if (reason !== undefined && (!isSafeByteBoundedString(reason, MAX_PAIR_DECISION_REASON_CHARS) || reason.length === 0)) {
    throw new Error("Pair decision reason is invalid.");
  }
  const sealedManifestSha256 = bytesToHex(sha256(text.encode(sealedManifest)));
  return JSON.stringify({ v: 1, t: "pair-decision", sid, fromRole, decision, sealedManifestSha256, reason: reason ?? null });
}

function assertPakeSid(sid: unknown): asserts sid is string {
  if (typeof sid !== "string" || sid.length === 0 || sid.length > MAX_PAKE_CONTEXT_CHARS || !SESSION_ID_VALUE.test(sid)) {
    throw new Error("PAKE session id is invalid.");
  }
}

function assertPakeCode(code: unknown): asserts code is string {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_PAKE_CONTEXT_CHARS || UNSAFE_TEXT_CHARS.test(code)) {
    throw new Error("PAKE code is invalid.");
  }
}

export async function sealManifest(keys: SessionKeys, manifest: unknown): Promise<string> {
  const activeKeys = activeSessionKeys(keys);
  return sealJson(activeKeys.manifestKey, { t: "pair-manifest", manifest }, text.encode(`manifest:${activeKeys.sid}`));
}

export async function openManifest<T>(keys: SessionKeys, sealed: unknown): Promise<T> {
  const activeKeys = activeSessionKeys(keys);
  const opened = await openJson<unknown>(activeKeys.manifestKey, sealed, text.encode(`manifest:${activeKeys.sid}`));
  const type = ownDataValue(opened, "t");
  const manifest = ownDataValue(opened, "manifest");
  if (!isPlainObject(opened) || !hasOnlyKeys(opened, ["t", "manifest"]) || type !== "pair-manifest" || !hasOwnKey(opened, "manifest")) {
    throw new Error("Encrypted manifest wrapper is invalid.");
  }
  return manifest as T;
}

export async function sealControl(keys: SessionKeys, message: unknown): Promise<string> {
  const activeKeys = activeSessionKeys(keys);
  return sealJson(activeKeys.controlSendKey, message, text.encode(`control:${activeKeys.sid}`));
}

export async function openControl<T>(keys: SessionKeys, sealed: unknown): Promise<T> {
  const activeKeys = activeSessionKeys(keys);
  return openJson<T>(activeKeys.controlRecvKey, sealed, text.encode(`control:${activeKeys.sid}`));
}

export async function sealBulk(keys: SessionKeys, fileId: number, chunkSeq: number, payload: Uint8Array): Promise<Uint8Array> {
  const activeKeys = activeSessionKeys(keys);
  assertChunkAddress(fileId, chunkSeq);
  const payloadByteLength = binaryPayloadByteLength(payload);
  if (payloadByteLength > CHUNK_SIZE) throw new Error("Bulk payload exceeds maximum chunk size.");
  const nonce = chunkNonce(fileId, chunkSeq);
  const aad = chunkAad(fileId, chunkSeq);
  const nonceForWebCrypto = webBytes(nonce);
  const aadForWebCrypto = webBytes(aad);
  const plaintext = webBytes(payload);
  try {
    return new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonceForWebCrypto, additionalData: aadForWebCrypto, tagLength: 128 },
        activeKeys.bulkSendKey,
        plaintext
      )
    );
  } finally {
    nonce.fill(0);
    aad.fill(0);
    nonceForWebCrypto.fill(0);
    aadForWebCrypto.fill(0);
    plaintext.fill(0);
  }
}

export async function openBulk(keys: SessionKeys, fileId: number, chunkSeq: number, sealedPayload: Uint8Array): Promise<Uint8Array> {
  const activeKeys = activeSessionKeys(keys);
  assertChunkAddress(fileId, chunkSeq);
  const sealedByteLength = binaryPayloadByteLength(sealedPayload);
  if (sealedByteLength > MAX_BULK_SEALED_BYTES) throw new Error("Encrypted bulk payload exceeds maximum chunk size.");
  const nonce = chunkNonce(fileId, chunkSeq);
  const aad = chunkAad(fileId, chunkSeq);
  const nonceForWebCrypto = webBytes(nonce);
  const aadForWebCrypto = webBytes(aad);
  const ciphertext = webBytes(sealedPayload);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceForWebCrypto, additionalData: aadForWebCrypto, tagLength: 128 },
        activeKeys.bulkRecvKey,
        ciphertext
      )
    );
  } catch {
    throw new Error("Encrypted bulk chunk decrypt failed.");
  } finally {
    nonce.fill(0);
    aad.fill(0);
    nonceForWebCrypto.fill(0);
    aadForWebCrypto.fill(0);
    ciphertext.fill(0);
  }
}

function activeSessionKeys(keys: SessionKeys): ActiveAeadSessionKeys {
  if (!isObjectLike(keys) || ownDataValue(keys, "destroyed") !== false) {
    throw new Error("Session keys have been wiped.");
  }
  const sid = ownDataValue(keys, "sid");
  const manifestKey = ownDataValue(keys, "manifestKey");
  const controlSendKey = ownDataValue(keys, "controlSendKey");
  const controlRecvKey = ownDataValue(keys, "controlRecvKey");
  const bulkSendKey = ownDataValue(keys, "bulkSendKey");
  const bulkRecvKey = ownDataValue(keys, "bulkRecvKey");
  assertPakeSid(sid);
  assertCryptoKey(manifestKey);
  assertCryptoKey(controlSendKey);
  assertCryptoKey(controlRecvKey);
  assertCryptoKey(bulkSendKey);
  assertCryptoKey(bulkRecvKey);
  return { sid, manifestKey, controlSendKey, controlRecvKey, bulkSendKey, bulkRecvKey };
}

function assertChunkAddress(fileId: number, chunkSeq: number): void {
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 255) throw new Error("fileId must fit in uint8");
  if (!Number.isInteger(chunkSeq) || chunkSeq < 0 || chunkSeq > 0xffffffff) throw new Error("chunkSeq must fit in uint32");
}

function binaryPayloadByteLength(value: unknown): number {
  return canonicalUint8ArrayByteLength(value, "Bulk payload must be binary.");
}

function authenticationKeyCopy(value: unknown): Uint8Array {
  const byteLength = canonicalUint8ArrayByteLength(value, "Authentication key must be 32-byte binary.");
  if (byteLength !== AUTHENTICATION_KEY_BYTES) throw new Error("Authentication key must be 32-byte binary.");
  const out = new Uint8Array(byteLength);
  out.set(value as Uint8Array);
  return out;
}

function assertCryptoKey(value: unknown): asserts value is CryptoKey {
  if (typeof RuntimeCryptoKey !== "function" || !(value instanceof RuntimeCryptoKey)) throw new Error("Session keys have been wiped.");
}

function deriveRawKeys(isk: Uint8Array, sid: string) {
  const salt = concat(HKDF_CONTEXT, text.encode(sid));
  return {
    signalAuthKey: derive(isk, salt, "signal-auth", 32),
    manifestKey: derive(isk, salt, "manifest-aead", 32),
    controlSenderToReceiver: derive(isk, salt, "control-aead sender-to-receiver", 32),
    controlReceiverToSender: derive(isk, salt, "control-aead receiver-to-sender", 32),
    bulkSenderToReceiver: derive(isk, salt, "bulk-aead sender-to-receiver", 32),
    bulkReceiverToSender: derive(isk, salt, "bulk-aead receiver-to-sender", 32),
    sas: derive(isk, salt, "sas", 8)
  };
}

function derive(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha256, ikm, salt, text.encode(info), length);
}

async function sealJson(key: CryptoKey, value: unknown, aad: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const nonceForWebCrypto = webBytes(nonce);
  const aadForWebCrypto = webBytes(aad);
  const serialized = stringifyJsonValue(value);
  const plaintext = text.encode(serialized);
  const plaintextForWebCrypto = webBytes(plaintext);
  let ciphertext: Uint8Array | undefined;
  let sealed: Uint8Array | undefined;
  try {
    const sealedByteLength = nonce.byteLength + plaintext.byteLength + AES_GCM_TAG_BYTES;
    if (base64EncodedLength(sealedByteLength) > ENCRYPTED_JSON_MAX_CHARS) throw new Error("Encrypted payload is too large.");
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceForWebCrypto, additionalData: aadForWebCrypto, tagLength: 128 }, key, plaintextForWebCrypto));
    sealed = concat(nonce, ciphertext);
    const encoded = bytesToBase64(sealed);
    if (encoded.length > ENCRYPTED_JSON_MAX_CHARS) throw new Error("Encrypted payload is too large.");
    return encoded;
  } finally {
    plaintext.fill(0);
    plaintextForWebCrypto.fill(0);
    nonce.fill(0);
    nonceForWebCrypto.fill(0);
    aadForWebCrypto.fill(0);
    ciphertext?.fill(0);
    sealed?.fill(0);
  }
}

function stringifyJsonValue(value: unknown): string {
  assertJsonValueWithinEncryptionBounds(value);
  const serialized = stringifyPreflightedJsonValue(value);
  if (text.encode(serialized).byteLength > MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES) throw new Error("Encrypted payload is too large.");
  return serialized;
}

function assertJsonValueWithinEncryptionBounds(value: unknown): void {
  const budget = { remainingBytes: MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES, remainingNodes: MAX_ENCRYPTED_JSON_NODES };
  visitJsonValue(value, budget, new WeakSet<object>(), 0);
}

function visitJsonValue(value: unknown, budget: { remainingBytes: number; remainingNodes: number }, seen: WeakSet<object>, depth: number): void {
  budget.remainingNodes -= 1;
  if (budget.remainingNodes < 0 || depth > MAX_ENCRYPTED_JSON_DEPTH) throw new Error("Encrypted payload is too large.");
  if (value === null) return accountJsonBytes(budget, 4);
  switch (typeof value) {
    case "string":
      return accountJsonStringBytes(value, budget);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Encrypted payload is not JSON serializable.");
      return accountJsonBytes(budget, String(value).length);
    case "boolean":
      return accountJsonBytes(budget, value ? 4 : 5);
    case "object":
      return visitJsonObject(value, budget, seen, depth);
    default:
      throw new Error("Encrypted payload is not JSON serializable.");
  }
}

function visitJsonObject(value: object, budget: { remainingBytes: number; remainingNodes: number }, seen: WeakSet<object>, depth: number): void {
  if (seen.has(value)) throw new Error("Encrypted payload is not JSON serializable.");
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) throw new Error("Encrypted payload is not JSON serializable.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return visitJsonArray(value, budget, seen, depth);
    if (!isPlainObject(value)) throw new Error("Encrypted payload is not JSON serializable.");
    visitJsonRecord(value as Record<string, unknown>, budget, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function visitJsonArray(value: unknown[], budget: { remainingBytes: number; remainingNodes: number }, seen: WeakSet<object>, depth: number): void {
  if (value.length > MAX_ENCRYPTED_JSON_NODES) throw new Error("Encrypted payload is too large.");
  accountJsonBytes(budget, 2);
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) accountJsonBytes(budget, 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error("Encrypted payload is not JSON serializable.");
    if (!("value" in descriptor)) throw new Error("Encrypted payload is not JSON serializable.");
    if (jsonArrayValueSerializesAsNull(descriptor.value)) {
      accountJsonBytes(budget, 4);
      continue;
    }
    visitJsonValue(descriptor.value, budget, seen, depth + 1);
  }
}

function visitJsonRecord(value: Record<string, unknown>, budget: { remainingBytes: number; remainingNodes: number }, seen: WeakSet<object>, depth: number): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Encrypted payload is not JSON serializable.");
  accountJsonBytes(budget, 2);
  let propertyCount = 0;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new Error("Encrypted payload is not JSON serializable.");
    if (jsonObjectPropertyIsOmitted(descriptor.value)) continue;
    if (propertyCount > 0) accountJsonBytes(budget, 1);
    accountJsonStringBytes(key, budget);
    accountJsonBytes(budget, 1);
    visitJsonValue(descriptor.value, budget, seen, depth + 1);
    propertyCount += 1;
  }
}

function jsonArrayValueSerializesAsNull(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function jsonObjectPropertyIsOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function stringifyPreflightedJsonValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Encrypted payload is not JSON serializable.");
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      if (Array.isArray(value)) return stringifyPreflightedJsonArray(value);
      if (!isPlainObject(value)) throw new Error("Encrypted payload is not JSON serializable.");
      return stringifyPreflightedJsonRecord(value as Record<string, unknown>);
    default:
      throw new Error("Encrypted payload is not JSON serializable.");
  }
}

function stringifyPreflightedJsonArray(value: unknown[]): string {
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Encrypted payload is not JSON serializable.");
    if (jsonArrayValueSerializesAsNull(descriptor.value)) {
      out.push("null");
    } else {
      out.push(stringifyPreflightedJsonValue(descriptor.value));
    }
  }
  return `[${out.join(",")}]`;
}

function stringifyPreflightedJsonRecord(value: Record<string, unknown>): string {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Encrypted payload is not JSON serializable.");
  const out: string[] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor) || jsonObjectPropertyIsOmitted(descriptor.value)) continue;
    out.push(`${JSON.stringify(key)}:${stringifyPreflightedJsonValue(descriptor.value)}`);
  }
  return `{${out.join(",")}}`;
}

function accountJsonStringBytes(value: string, budget: { remainingBytes: number }): void {
  accountJsonBytes(budget, 2);
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (char === '"' || char === "\\" || char === "\b" || char === "\f" || char === "\n" || char === "\r" || char === "\t") {
      accountJsonBytes(budget, 2);
    } else if (codePoint <= 0x1f || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      accountJsonBytes(budget, 6);
    } else if (codePoint <= 0x7f) {
      accountJsonBytes(budget, 1);
    } else if (codePoint <= 0x7ff) {
      accountJsonBytes(budget, 2);
    } else if (codePoint <= 0xffff) {
      accountJsonBytes(budget, 3);
    } else {
      accountJsonBytes(budget, 4);
    }
  }
}

function accountJsonBytes(budget: { remainingBytes: number }, bytes: number): void {
  budget.remainingBytes -= bytes;
  if (budget.remainingBytes < 0) throw new Error("Encrypted payload is too large.");
}

function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

async function openJson<T>(key: CryptoKey, sealed: unknown, aad: Uint8Array): Promise<T> {
  if (typeof sealed !== "string") throw new Error("Encrypted payload must be a text frame.");
  if (sealed.length > ENCRYPTED_JSON_MAX_CHARS) throw new Error("Encrypted payload is too large.");
  const payload = base64ToBytes(sealed);
  let plaintext: Uint8Array | undefined;
  try {
    if (payload.byteLength < 13) throw new Error("Encrypted payload is too small.");
    const nonce = payload.subarray(0, 12);
    const ciphertext = payload.subarray(12);
    const nonceForWebCrypto = webBytes(nonce);
    const aadForWebCrypto = webBytes(aad);
    const ciphertextForWebCrypto = webBytes(ciphertext);
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceForWebCrypto, additionalData: aadForWebCrypto, tagLength: 128 }, key, ciphertextForWebCrypto));
    } catch {
      throw new Error("Encrypted payload decrypt failed.");
    } finally {
      nonceForWebCrypto.fill(0);
      aadForWebCrypto.fill(0);
      ciphertextForWebCrypto.fill(0);
    }
    try {
      return JSON.parse(jsonText.decode(plaintext)) as T;
    } catch {
      throw new Error("Encrypted payload is not valid JSON.");
    }
  } finally {
    plaintext?.fill(0);
    payload.fill(0);
  }
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const rawForWebCrypto = webBytes(raw);
  try {
    return await crypto.subtle.importKey("raw", rawForWebCrypto, "AES-GCM", false, usages);
  } finally {
    rawForWebCrypto.fill(0);
  }
}

function passwordBytes(code: string): Uint8Array {
  return text.encode(`p2p-transfer code v1:${code}`);
}

type SignalPayloadForAuth =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

function canonicalSignalForAuth(sid: string, fromRole: PakeRole, signal: SignalPayloadForAuth): string {
  assertSignalPayloadForAuth(signal);
  const kind = ownDataValue(signal, "kind");
  if (kind === "offer" || kind === "answer") {
    return JSON.stringify({ v: 1, t: "signal-auth", sid, fromRole, kind, sdp: ownDataValue(signal, "sdp") });
  }
  return JSON.stringify({ v: 1, t: "signal-auth", sid, fromRole, kind: "candidate", candidate: canonicalCandidate(ownDataValue(signal, "candidate") as RTCIceCandidateInit) });
}

function assertSignalPayloadForAuth(signal: SignalPayloadForAuth): void {
  if (!isPlainObject(signal)) throw new Error("WebRTC signal auth payload is invalid.");
  const kind = ownDataValue(signal, "kind");
  if (kind === "offer" || kind === "answer") {
    if (!hasOnlyKeys(signal, ["kind", "sdp"]) || !isNonEmptyByteBoundedString(ownDataValue(signal, "sdp"), MAX_AUTH_SDP_BYTES)) {
      throw new Error("WebRTC signal auth payload is invalid.");
    }
    return;
  }
  if (kind === "candidate" && hasOnlyKeys(signal, ["kind", "candidate"]) && isIceCandidateInitForAuth(ownDataValue(signal, "candidate"))) return;
  throw new Error("WebRTC signal auth payload is invalid.");
}

function assertSignalPayloadForVerify(signal: SignalPayload): void {
  if (!isPlainObject(signal)) throw new Error("WebRTC signal auth payload is invalid.");
  const kind = ownDataValue(signal, "kind");
  if (kind === "offer" || kind === "answer") {
    if (!hasOnlyKeys(signal, ["kind", "sdp", "auth"]) || !isNonEmptyByteBoundedString(ownDataValue(signal, "sdp"), MAX_AUTH_SDP_BYTES)) {
      throw new Error("WebRTC signal auth payload is invalid.");
    }
    return;
  }
  if (kind === "candidate" && hasOnlyKeys(signal, ["kind", "candidate", "auth"]) && isIceCandidateInitForAuth(ownDataValue(signal, "candidate"))) return;
  throw new Error("WebRTC signal auth payload is invalid.");
}

function canonicalCandidate(candidate: RTCIceCandidateInit): Record<string, unknown> {
  const candidateText = ownDataValue(candidate, "candidate");
  const sdpMid = ownDataValue(candidate, "sdpMid");
  const sdpMLineIndex = ownDataValue(candidate, "sdpMLineIndex");
  const usernameFragment = ownDataValue(candidate, "usernameFragment");
  const out: Record<string, unknown> = { candidate: candidateText };
  if (sdpMid !== undefined) out.sdpMid = sdpMid;
  if (sdpMLineIndex !== undefined) out.sdpMLineIndex = sdpMLineIndex;
  if (usernameFragment !== undefined) out.usernameFragment = usernameFragment;
  return out;
}

function isIceCandidateInitForAuth(value: unknown): value is RTCIceCandidateInit {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) return false;
  const candidate = ownDataValue(value, "candidate");
  const sdpMid = ownDataValue(value, "sdpMid");
  const sdpMLineIndex = ownDataValue(value, "sdpMLineIndex");
  const usernameFragment = ownDataValue(value, "usernameFragment");
  const hasSdpMid = sdpMid !== null && sdpMid !== undefined;
  const hasSdpMLineIndex = sdpMLineIndex !== null && sdpMLineIndex !== undefined;
  return (
    isSafeNonEmptyByteBoundedString(candidate, MAX_AUTH_CANDIDATE_BYTES) &&
    (hasSdpMid || hasSdpMLineIndex) &&
    (!hasSdpMid || isSafeTokenString(sdpMid, MAX_AUTH_TOKEN_BYTES)) &&
    (sdpMLineIndex === null ||
      sdpMLineIndex === undefined ||
      (typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 65535)) &&
    (usernameFragment === undefined || usernameFragment === null || isSafeTokenString(usernameFragment, MAX_AUTH_TOKEN_BYTES))
  );
}

function isByteBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && !utf8ByteLengthExceeds(value, maxBytes);
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

function isSafeTokenString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && !utf8ByteLengthExceeds(value, maxBytes) && SAFE_ASCII_TOKEN.test(value);
}

function chunkNonce(fileId: number, chunkSeq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint8(0, fileId);
  view.setUint32(8, chunkSeq, false);
  return nonce;
}

function chunkAad(fileId: number, chunkSeq: number): Uint8Array {
  const aad = new Uint8Array(5);
  const view = new DataView(aad.buffer);
  view.setUint8(0, fileId);
  view.setUint32(1, chunkSeq, false);
  return aad;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function webBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out as Uint8Array<ArrayBuffer>;
}

function canonicalUint8ArrayByteLength(value: unknown, message: string): number {
  if (!(value instanceof Uint8Array) || !isCanonicalBinaryPrototype(value) || !TYPED_ARRAY_BYTE_LENGTH_GETTER) {
    throw new Error(message);
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error(message);
  return byteLength;
}

function isCanonicalBinaryPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Uint8Array.prototype) return true;
  return typeof Buffer !== "undefined" && prototype === Buffer.prototype;
}

export function bytesToBase64(bytes: Uint8Array): string {
  canonicalUint8ArrayByteLength(bytes, "Invalid binary payload.");
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > BASE64_DECODE_MAX_CHARS) throw new Error("Invalid base64 payload.");
  if (!isCanonicalBase64(value)) throw new Error("Invalid base64 payload.");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && hasCanonicalBase64Padding(value);
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

function utf8ByteLengthExceeds(value: string, maxBytes: number): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid UTF-8 byte limit.");
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && hasOnlyDataProperties(value);
}

function hasOnlyDataProperties(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function readPakeState(state: unknown): PakeStateParts {
  if (!isObjectLike(state)) throw new Error("PAKE state is invalid.");
  const role = ownDataValue(state, "role");
  const sid = ownDataValue(state, "sid");
  const ephemeralSecret = ownDataValue(state, "ephemeralSecret");
  const share = ownDataValue(state, "share");
  assertPakeRole(role);
  assertPakeSid(sid);
  if (!(ephemeralSecret instanceof Uint8Array) || !(share instanceof Uint8Array)) throw new Error("PAKE state is invalid.");
  if (
    canonicalUint8ArrayByteLength(ephemeralSecret, "PAKE state is invalid.") !== CPACE_SHARE_BYTES ||
    canonicalUint8ArrayByteLength(share, "PAKE state is invalid.") !== CPACE_SHARE_BYTES
  ) {
    throw new Error("PAKE state is invalid.");
  }
  return { role, sid, ephemeralSecret, share };
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function fillOwnBytes(value: unknown, key: string): void {
  const bytes = ownDataValue(value, key);
  if (!(bytes instanceof Uint8Array)) return;
  try {
    bytes.fill(0);
  } catch {
    // Best-effort cleanup must not let malformed caller objects mask an earlier error.
  }
}

function deleteOwnProperty(value: object, key: string): void {
  try {
    delete (value as Record<string, unknown>)[key];
  } catch {
    // Best-effort cleanup.
  }
}

function defineOwnData(value: object, key: string, data: unknown): void {
  try {
    Object.defineProperty(value, key, {
      value: data,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } catch {
    // Best-effort cleanup.
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).every((key) => allowed.includes(key));
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
