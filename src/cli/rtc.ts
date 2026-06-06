import wrtc from "@roamhq/wrtc";
import { CONNECT_TIMEOUT_MS, DATA_CHANNEL_BUFFER_LOW, TRANSFER_CONTROL_TIMEOUT_MS } from "../shared/constants.js";
import { cloneIceServers } from "../shared/ice.js";
import { isServerMessage, type SignalPayload } from "../shared/messages.js";
import { signalAuthTag, type PakeRole } from "../shared/security.js";
import type { SignalingClient } from "./signaling.js";
import { unrefTimer } from "./timers.js";

export type PeerBundle = {
  pc: RTCPeerConnection;
  waitConnected: () => Promise<void>;
  close: () => void;
};

const NATIVE_PEER_CONNECTION = wrtc.RTCPeerConnection as { new (...args: never[]): RTCPeerConnection };
const NATIVE_DATA_CHANNEL = (wrtc as unknown as { RTCDataChannel: { new (...args: never[]): RTCDataChannel } }).RTCDataChannel;
const NATIVE_ICE_CANDIDATE = wrtc.RTCIceCandidate as { new (...args: never[]): RTCIceCandidate };
const RTC_SESSION_ID_VALUE = /^[A-Za-z0-9_-]+$/;
const RTC_MAX_SESSION_ID_CHARS = 256;
const RTC_SIGNAL_AUTH_KEY_BYTES = 32;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

type SignalingSend = SignalingClient["send"];

export function createPeer(
  sid: string,
  iceServers: RTCIceServer[],
  signaling: SignalingClient,
  signalAuthKey: Uint8Array,
  role: PakeRole,
  forceRelay = false
): PeerBundle {
  const safeSid = peerSidInput(sid);
  const safeIceServers = cloneIceServers(iceServers);
  const { target: signalingTarget, send: signalingSend } = signalingClientInput(signaling);
  const safeRole = peerRoleInput(role);
  const safeForceRelay = forceRelayInput(forceRelay);
  let authKey = signalAuthKeyInput(signalAuthKey);
  let closed = false;
  let pc: RTCPeerConnection;
  try {
    pc = new wrtc.RTCPeerConnection({ iceServers: safeIceServers, iceTransportPolicy: safeForceRelay ? "relay" : "all" });
  } catch (error) {
    authKey.fill(0);
    throw error;
  }
  const close = () => {
    if (!closed) {
      closed = true;
      authKey.fill(0);
    }
    pc.close();
  };
  pc.onicecandidate = (event) => {
    if (closed) return;
    const localCandidate = localIceCandidateFromEvent(event);
    if (!localCandidate) return;
    try {
      const candidate = localIceCandidateInit(localCandidate);
      if (!candidate) return;
      signalingSend.call(signalingTarget, {
        type: "signal",
        sid: safeSid,
        signal: { kind: "candidate", candidate, auth: signalAuthTag(authKey, safeSid, safeRole, { kind: "candidate", candidate }) }
      });
    } catch {
      close();
    }
  };

  const connected = new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      pc.onconnectionstatechange = null;
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("WebRTC connection timed out."), CONNECT_TIMEOUT_MS);
    unrefTimer(timer);
    const handleConnectionState = () => {
      if (pc.connectionState === "connected") {
        succeed();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        fail(`WebRTC connection ${pc.connectionState}.`);
      }
    };
    pc.onconnectionstatechange = handleConnectionState;
    handleConnectionState();
  });

  return {
    pc,
    waitConnected: () => connected,
    close
  };
}

export async function handleSignal(pc: RTCPeerConnection, signal: SignalPayload): Promise<"offer" | "answer" | "candidate"> {
  assertNativePeerConnection(pc);
  assertSignalPayload(signal);
  if (signal.kind === "candidate") {
    await pc.addIceCandidate(signal.candidate);
    return "candidate";
  }
  await pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp });
  return signal.kind;
}

export async function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  assertSafeDataChannel(channel);
  if (channel.readyState === "open") return;
  if (channel.readyState === "closing" || channel.readyState === "closed") throw new Error(`DataChannel ${channel.label} is ${channel.readyState}.`);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const failIfTerminal = () => {
      if (channel.readyState === "closing" || channel.readyState === "closed") fail(`DataChannel ${channel.label} is ${channel.readyState}.`);
    };
    const succeedIfOpen = () => {
      if (channel.readyState === "open") succeed();
    };
    const timer = setTimeout(() => fail(`DataChannel ${channel.label} did not open.`), CONNECT_TIMEOUT_MS);
    unrefTimer(timer);
    channel.onopen = succeed;
    channel.onclose = () => fail(`DataChannel ${channel.label} closed before opening.`);
    channel.onerror = () => fail(`DataChannel ${channel.label} failed.`);
    failIfTerminal();
    succeedIfOpen();
  });
}

export async function waitForBackpressure(channel: RTCDataChannel, highWater: number): Promise<void> {
  assertSafeDataChannel(channel);
  if (typeof highWater !== "number" || !Number.isSafeInteger(highWater) || highWater < 0) throw new Error("DataChannel high-water mark is invalid.");
  if (channel.readyState === "closing" || channel.readyState === "closed") throw new Error(`DataChannel ${channel.label} is ${channel.readyState}.`);
  if (channel.bufferedAmount <= highWater) return;
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let interval: ReturnType<typeof setInterval>;
    let timer: ReturnType<typeof setTimeout>;
    const previousLow = channel.onbufferedamountlow;
    const previousClose = channel.onclose;
    const previousError = channel.onerror;
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timer);
      channel.onbufferedamountlow = previousLow;
      channel.onclose = previousClose;
      channel.onerror = previousError;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const failIfTerminal = () => {
      if (channel.readyState === "closing" || channel.readyState === "closed") fail(`DataChannel ${channel.label} is ${channel.readyState}.`);
    };
    interval = setInterval(() => {
      if (channel.bufferedAmount <= DATA_CHANNEL_BUFFER_LOW) {
        finish();
      }
    }, 25);
    timer = setTimeout(() => fail(`DataChannel ${channel.label} backpressure did not drain.`), TRANSFER_CONTROL_TIMEOUT_MS);
    unrefTimer(interval);
    unrefTimer(timer);
    channel.onbufferedamountlow = finish;
    channel.onclose = (event) => {
      previousClose?.call(channel, event);
      fail(`DataChannel ${channel.label} closed while draining.`);
    };
    channel.onerror = (event) => {
      previousError?.call(channel, event);
      fail(`DataChannel ${channel.label} failed while draining.`);
    };
    failIfTerminal();
  });
}

export function isSafeDataChannel(channel: unknown): channel is RTCDataChannel {
  if (channel instanceof NATIVE_DATA_CHANNEL) return true;
  if (typeof channel !== "object" || channel === null) return false;
  for (const key of ["readyState", "bufferedAmount", "bufferedAmountLowThreshold", "onopen", "onclose", "onerror", "onbufferedamountlow"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(channel, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.writable) return false;
  }
  return true;
}

export function isSafeIncomingDataChannel(channel: unknown): channel is RTCDataChannel {
  if (channel instanceof NATIVE_DATA_CHANNEL) return true;
  if (!isSafeDataChannel(channel)) return false;
  for (const key of ["label", "ordered", "maxPacketLifeTime", "maxRetransmits"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(channel, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.writable) return false;
  }
  return true;
}

export function dataChannelLabel(channel: RTCDataChannel): string | undefined {
  if (!isSafeIncomingDataChannel(channel)) return undefined;
  const label = channel.label;
  return typeof label === "string" ? label : undefined;
}

function assertSafeDataChannel(channel: RTCDataChannel): void {
  if (isSafeDataChannel(channel)) return;
  throw new Error("DataChannel is invalid.");
}

export function closeDataChannel(channel: RTCDataChannel): void {
  if (!isSafeIncomingDataChannel(channel)) return;
  channel.close();
}

function assertNativePeerConnection(pc: RTCPeerConnection): void {
  if (!(pc instanceof NATIVE_PEER_CONNECTION)) throw new Error("PeerConnection is invalid.");
}

function assertSignalPayload(signal: SignalPayload): void {
  if (!isServerMessage({ type: "signal", sid: "s", signal })) throw new Error("WebRTC signal is invalid.");
}

function localIceCandidateFromEvent(event: unknown): RTCIceCandidate | undefined {
  const candidate = ownDataValue(event, "candidate");
  return candidate instanceof NATIVE_ICE_CANDIDATE ? candidate : undefined;
}

function localIceCandidateInit(source: RTCIceCandidate): RTCIceCandidateInit | undefined {
  if (!(source instanceof NATIVE_ICE_CANDIDATE)) return undefined;
  const candidateText = ownDataValue(source, "candidate");
  if (typeof candidateText !== "string" || candidateText.length === 0) return undefined;
  const sdpMid = ownDataValue(source, "sdpMid");
  const sdpMLineIndex = ownDataValue(source, "sdpMLineIndex");
  const usernameFragment = ownDataValue(source, "usernameFragment");
  const candidate: RTCIceCandidateInit = { candidate: candidateText };
  if (sdpMid === null || typeof sdpMid === "string") candidate.sdpMid = sdpMid;
  if (sdpMLineIndex === null || (typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 65535)) {
    candidate.sdpMLineIndex = sdpMLineIndex;
  }
  if (typeof usernameFragment === "string") candidate.usernameFragment = usernameFragment;
  if ((candidate.sdpMid === null || candidate.sdpMid === undefined) && (candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined)) return undefined;
  return candidate;
}

function peerSidInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > RTC_MAX_SESSION_ID_CHARS || !RTC_SESSION_ID_VALUE.test(value)) {
    throw new Error("Peer session id is invalid.");
  }
  return value;
}

function peerRoleInput(value: unknown): PakeRole {
  if (value !== "sender" && value !== "receiver") throw new Error("Peer role is invalid.");
  return value;
}

function forceRelayInput(value: unknown): boolean {
  if (value !== true && value !== false) throw new Error("Peer relay option is invalid.");
  return value;
}

function signalAuthKeyInput(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || !isCanonicalBinaryPrototype(value) || !TYPED_ARRAY_BYTE_LENGTH_GETTER) {
    throw new Error("Signal authentication key is invalid.");
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  if (byteLength !== RTC_SIGNAL_AUTH_KEY_BYTES) throw new Error("Signal authentication key is invalid.");
  const copy = new Uint8Array(byteLength);
  copy.set(value);
  return copy;
}

function isCanonicalBinaryPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Uint8Array.prototype) return true;
  return typeof Buffer !== "undefined" && prototype === Buffer.prototype;
}

function signalingClientInput(value: unknown): { target: SignalingClient; send: SignalingSend } {
  if (!value || (typeof value !== "object" && typeof value !== "function")) throw new Error("Signaling client is invalid.");
  const send = dataMethod(value, "send");
  if (typeof send !== "function") throw new Error("Signaling client is invalid.");
  return { target: value as SignalingClient, send: send as SignalingSend };
}

function dataMethod(value: object, key: string): unknown {
  let current: object | null = value;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
