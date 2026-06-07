import type { SignalPayload } from "./messages.js";

export class WebRtcSignalReplayGuard {
  private readonly answerOffers: boolean;
  private seenOffer = false;
  private seenAnswer = false;
  private readonly seenCandidates = new Set<string>();

  constructor(answerOffers: boolean) {
    if (typeof answerOffers !== "boolean") throw new Error("WebRTC signal replay policy is invalid.");
    this.answerOffers = answerOffers;
  }

  accept(signal: SignalPayload): void {
    if (!signal || typeof signal !== "object") throw new Error("WebRTC signal replay payload is invalid.");
    const kind = ownDataValue(signal, "kind");
    if (kind === "offer") {
      if (!this.answerOffers) throw new Error("Unexpected WebRTC offer signal.");
      if (this.seenOffer) throw new Error("Duplicate WebRTC offer signal.");
      this.seenOffer = true;
      return;
    }
    if (kind === "answer") {
      if (this.answerOffers) throw new Error("Unexpected WebRTC answer signal.");
      if (this.seenAnswer) throw new Error("Duplicate WebRTC answer signal.");
      this.seenAnswer = true;
      return;
    }
    if (kind !== "candidate") throw new Error("WebRTC signal replay payload is invalid.");
    const key = candidateReplayKey(signal);
    if (this.seenCandidates.has(key)) throw new Error("Duplicate WebRTC ICE candidate signal.");
    this.seenCandidates.add(key);
  }
}

function candidateReplayKey(signal: SignalPayload): string {
  const source = ownDataValue(signal, "candidate");
  if (!source || typeof source !== "object") throw new Error("WebRTC signal replay payload is invalid.");
  const candidate = ownDataValue(source, "candidate");
  const sdpMid = ownDataValue(source, "sdpMid");
  const sdpMLineIndex = ownDataValue(source, "sdpMLineIndex");
  const usernameFragment = ownDataValue(source, "usernameFragment");
  if (typeof candidate !== "string") throw new Error("WebRTC signal replay payload is invalid.");
  if (sdpMid !== undefined && sdpMid !== null && typeof sdpMid !== "string") throw new Error("WebRTC signal replay payload is invalid.");
  if (sdpMLineIndex !== undefined && sdpMLineIndex !== null && typeof sdpMLineIndex !== "number") throw new Error("WebRTC signal replay payload is invalid.");
  if (usernameFragment !== undefined && typeof usernameFragment !== "string") throw new Error("WebRTC signal replay payload is invalid.");
  return JSON.stringify({ candidate, sdpMid: sdpMid ?? null, sdpMLineIndex: sdpMLineIndex ?? null, usernameFragment: usernameFragment ?? "" });
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
  return descriptor.value;
}
