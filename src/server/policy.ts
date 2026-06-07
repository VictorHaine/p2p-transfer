import type { ClientMessage, FileManifest } from "../shared/messages.js";
import { MAX_FILE_BYTES, SIGNALING_MAX_ICE_CANDIDATES_PER_PEER } from "../shared/constants.js";

export type RelayPolicyPeer = {
  id: string;
};

export type RelayPolicySession = {
  sid: string;
  sender: RelayPolicyPeer;
  receiver: RelayPolicyPeer;
  senderPakeSeen: boolean;
  receiverPakeSeen: boolean;
  senderConfirmed: boolean;
  receiverConfirmed: boolean;
  pairRequested: boolean;
  pairDecided: boolean;
  offerSeen: boolean;
  answerSeen: boolean;
  senderCandidateCount: number;
  receiverCandidateCount: number;
};

export type SessionPeerId = "sender" | "receiver";

export function sessionPeerId(session: Pick<RelayPolicySession, "sender" | "receiver">, peer: RelayPolicyPeer): SessionPeerId | null {
  const peerId = peerIdValue(peer);
  if (!peerId) return null;
  const sender = ownDataValue(session, "sender");
  const receiver = ownDataValue(session, "receiver");
  if (peerIdValue(sender) === peerId) return "sender";
  if (peerIdValue(receiver) === peerId) return "receiver";
  return null;
}

export function otherSessionPeerId(peerId: unknown): SessionPeerId {
  if (peerId === "sender") return "receiver";
  if (peerId === "receiver") return "sender";
  throw new Error("Session peer id is invalid.");
}

export function relayAllowedForRole(session: RelayPolicySession, peer: RelayPolicyPeer, message: Extract<ClientMessage, { sid: string }>): boolean {
  const peerId = sessionPeerId(session, peer);
  if (!peerId) return false;
  const isSender = peerId === "sender";
  const type = messageType(message);
  switch (type) {
    case "pair-request":
      return isSender;
    case "pair-accept":
    case "pair-reject":
      return !isSender;
    case "signal":
      if (signalKind(message) === "offer") return isSender;
      if (signalKind(message) === "answer") return !isSender;
      if (signalKind(message) === "candidate") return true;
      return false;
    case "pake":
    case "confirm":
      return true;
    default:
      return false;
  }
}

export function relayAllowedForPhase(session: RelayPolicySession, peer: RelayPolicyPeer, message: Extract<ClientMessage, { sid: string }>): boolean {
  const peerId = sessionPeerId(session, peer);
  if (!peerId) return false;
  const isSender = peerId === "sender";
  const type = messageType(message);
  switch (type) {
    case "pake":
      return !boolFlag(session, "pairRequested") && !boolFlag(session, "pairDecided") && (isSender ? !boolFlag(session, "senderPakeSeen") : !boolFlag(session, "receiverPakeSeen"));
    case "confirm":
      return (
        boolFlag(session, "senderPakeSeen") &&
        boolFlag(session, "receiverPakeSeen") &&
        !boolFlag(session, "pairRequested") &&
        !boolFlag(session, "pairDecided") &&
        (isSender ? !boolFlag(session, "senderConfirmed") : !boolFlag(session, "receiverConfirmed"))
      );
    case "pair-request":
      return boolFlag(session, "senderConfirmed") && boolFlag(session, "receiverConfirmed") && !boolFlag(session, "pairRequested") && !boolFlag(session, "pairDecided");
    case "pair-accept":
    case "pair-reject":
      return boolFlag(session, "pairRequested") && !boolFlag(session, "pairDecided");
    case "signal":
      if (!boolFlag(session, "pairDecided")) return false;
      if (signalKind(message) === "offer") return !boolFlag(session, "offerSeen");
      if (signalKind(message) === "answer") return boolFlag(session, "offerSeen") && !boolFlag(session, "answerSeen");
      if (signalKind(message) === "candidate") return boolFlag(session, "offerSeen") && candidateCountForPeer(session, peerId) < SIGNALING_MAX_ICE_CANDIDATES_PER_PEER;
      return false;
    default:
      return false;
  }
}

export function applyRelayPhase(session: RelayPolicySession, peer: RelayPolicyPeer, message: Extract<ClientMessage, { sid: string }>): void {
  const peerId = sessionPeerId(session, peer);
  if (!peerId) return;
  const isSender = peerId === "sender";
  const type = messageType(message);
  const kind = type === "signal" ? signalKind(message) : undefined;
  if (type === "pake" && isSender) setBooleanFlag(session, "senderPakeSeen");
  if (type === "pake" && !isSender) setBooleanFlag(session, "receiverPakeSeen");
  if (type === "confirm" && isSender) setBooleanFlag(session, "senderConfirmed");
  if (type === "confirm" && !isSender) setBooleanFlag(session, "receiverConfirmed");
  if (type === "pair-request") setBooleanFlag(session, "pairRequested");
  if (type === "pair-accept") setBooleanFlag(session, "pairDecided");
  if (type === "signal" && kind === "offer") setBooleanFlag(session, "offerSeen");
  if (type === "signal" && kind === "answer") setBooleanFlag(session, "answerSeen");
  if (type === "signal" && kind === "candidate" && isSender) setCandidateCount(session, "senderCandidateCount", candidateCountForPeer(session, "sender") + 1);
  if (type === "signal" && kind === "candidate" && !isSender) setCandidateCount(session, "receiverCandidateCount", candidateCountForPeer(session, "receiver") + 1);
}

function candidateCountForPeer(session: RelayPolicySession, peerId: SessionPeerId): number {
  const count = ownDataValue(session, peerId === "sender" ? "senderCandidateCount" : "receiverCandidateCount");
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : SIGNALING_MAX_ICE_CANDIDATES_PER_PEER;
}

export function sessionHasConfirmedPake(session: Pick<RelayPolicySession, "senderConfirmed" | "receiverConfirmed">): boolean {
  return boolFlag(session, "senderConfirmed") && boolFlag(session, "receiverConfirmed");
}

export function sessionBeforePairAcceptance(session: Pick<RelayPolicySession, "pairDecided">): boolean {
  return ownDataValue(session, "pairDecided") === false;
}

export function receiverCanRetryPrePair(session: Pick<RelayPolicySession, "receiver" | "pairDecided">, peer: RelayPolicyPeer): boolean {
  return peerIdValue(ownDataValue(session, "receiver")) === peerIdValue(peer) && sessionBeforePairAcceptance(session);
}

export function senderDisconnectCanRestoreReceiver(session: Pick<RelayPolicySession, "sender" | "pairDecided">, peer: RelayPolicyPeer): boolean {
  return peerIdValue(ownDataValue(session, "sender")) === peerIdValue(peer) && sessionBeforePairAcceptance(session);
}

export function publicPairRequestManifestIsRedacted(manifest: FileManifest): boolean {
  if (!hasOnlyOwnDataKeys(manifest, ["files", "fileCount", "totalBytes"])) return false;
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (
    typeof fileCount !== "number" ||
    !Array.isArray(files) ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 0 ||
    files.length !== fileCount ||
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0
  ) {
    return false;
  }
  let remainingBytes = totalBytes;
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
    const file = descriptor.value;
    if (!hasOnlyOwnDataKeys(file, ["id", "name", "size"])) return false;
    const expectedSize = Math.min(remainingBytes, MAX_FILE_BYTES);
    if (ownDataValue(file, "id") !== index || ownDataValue(file, "name") !== `encrypted-${index}` || ownDataValue(file, "size") !== expectedSize || ownDataValue(file, "mime") !== undefined) return false;
    remainingBytes -= expectedSize;
  }
  return remainingBytes === 0;
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

function messageType(message: unknown): unknown {
  return ownDataValue(message, "type");
}

function signalKind(message: unknown): unknown {
  return ownDataValue(ownDataValue(message, "signal"), "kind");
}

function boolFlag(value: unknown, key: keyof RelayPolicySession): boolean {
  return ownDataValue(value, key) === true;
}

function setBooleanFlag(value: unknown, key: keyof RelayPolicySession): void {
  const descriptor = ownWritableDataDescriptor(value, key);
  if (!descriptor || typeof descriptor.value !== "boolean") return;
  Object.defineProperty(value, key, { ...descriptor, value: true });
}

function setCandidateCount(value: unknown, key: "senderCandidateCount" | "receiverCandidateCount", count: number): void {
  const descriptor = ownWritableDataDescriptor(value, key);
  if (!descriptor || typeof descriptor.value !== "number" || !Number.isSafeInteger(count) || count < 0 || count > SIGNALING_MAX_ICE_CANDIDATES_PER_PEER) return;
  Object.defineProperty(value, key, { ...descriptor, value: count });
}

function peerIdValue(peer: unknown): string | undefined {
  const id = ownDataValue(peer, "id");
  return typeof id === "string" ? id : undefined;
}

function ownWritableDataDescriptor(value: unknown, key: string): PropertyDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && descriptor.writable === true ? descriptor : undefined;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
