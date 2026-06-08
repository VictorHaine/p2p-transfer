import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CONNECT_TIMEOUT_MS, MAX_BUFFERED_SIGNAL_MESSAGES, PAIR_TIMEOUT_MS, SIGNALING_CLOSE_GRACE_MS, SIGNALING_MAX_BUFFERED_BYTES, SIGNALING_MAX_PAYLOAD_BYTES } from "../shared/constants.js";
import { isServerMessage, parseJsonTextFrame, serializeMessage, signalingErrorDisplayMessage, type ClientMessage, type ErrorCode, type ServerMessage } from "../shared/messages.js";
import { signalingBackpressureExceeded } from "../shared/signaling-backpressure.js";
import { SignalMessageQueue, type SignalServerMessage } from "../shared/signal-queue.js";
import { normalizeSignalingServerUrl } from "../shared/server-url.js";
import { cloneIceServers } from "../shared/ice.js";
import { safeErrorMessage } from "./exit-codes.js";
import { unrefTimer } from "./timers.js";

const ignoreLateSocketError = () => {};
const WAIT_MESSAGE_TYPES = new Set<ServerMessage["type"]>([
  "registered",
  "peer-joined",
  "pake",
  "confirm",
  "pair-request",
  "pair-accept",
  "pair-reject",
  "signal",
  "peer-left",
  "ice-config",
  "error"
]);
const WAIT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class SignalingError extends Error {
  constructor(
    readonly code: ErrorCode
  ) {
    super(signalingErrorDisplayMessage(code));
    this.name = "SignalingError";
  }
}

export class SignalingWaitTimeoutError extends Error {
  constructor(
    readonly type: ServerMessage["type"]
  ) {
    super(`Timed out waiting for ${type}`);
    this.name = "SignalingWaitTimeoutError";
  }
}

export class SignalingClient extends EventEmitter {
  private ws?: WebSocket;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private readonly url: string;
  private latestIceServers?: RTCIceServer[];
  private readonly earlySignals = new SignalMessageQueue(MAX_BUFFERED_SIGNAL_MESSAGES, SIGNALING_MAX_BUFFERED_BYTES);
  private disposed = false;

  constructor(url: string) {
    super();
    this.url = normalizeSignalingServerUrl(url);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("signaling client is closed"));
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return Promise.reject(new Error("signaling client already has an active socket"));
    }
    return new Promise((resolve, reject) => {
      let ws: WebSocket | undefined;
      let settled = false;
      const timer = setTimeout(() => {
        this.close();
        fail(new Error("Timed out connecting to signaling server."));
      }, CONNECT_TIMEOUT_MS);
      unrefTimer(timer);
      const cleanupConnect = () => {
        clearTimeout(timer);
        ws?.off("open", onOpen);
        ws?.off("error", onError);
        ws?.off("close", onClose);
      };
      const detachFailedConnect = () => {
        cleanupConnect();
        ws?.off("message", onMessage);
        ws?.off("close", onRuntimeClose);
        ws?.off("error", onRuntimeError);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        ws?.on("message", onMessage);
        ws?.on("close", onRuntimeClose);
        ws?.on("error", onRuntimeError);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        detachFailedConnect();
        this.closeSocketAfterFailedConnect(ws);
        reject(error);
      };
      const onOpen = () => succeed();
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error("Signaling socket closed before connection opened."));
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const parsed = parseJsonTextFrame(data, isBinary);
        if (!isServerMessage(parsed)) {
          this.emit("protocol-error", new Error("Malformed signaling server message."));
          this.close();
          return;
        }
        if (parsed.type === "ice-config") this.latestIceServers = cloneIceServers(parsed.iceServers);
        if (parsed.type === "signal" && this.listenerCount("signal") === 0) {
          try {
            this.earlySignals.push(parsed);
          } catch (error) {
            this.emit("protocol-error", error instanceof Error ? error : new Error(safeErrorMessage(error)));
            this.close();
            return;
          }
          this.emit("message", parsed);
          return;
        }
        this.emit("message", parsed);
        this.emit(parsed.type, parsed);
      };
      const onRuntimeClose = () => {
        this.clearCloseTimer();
        this.emit("close");
        this.dispose();
      };
      const onRuntimeError = (error: Error) => this.emit("socket-error", error);
      try {
        ws = new WebSocket(this.url, { headers: { Origin: signalingOriginHeader(this.url) }, maxPayload: SIGNALING_MAX_PAYLOAD_BYTES, perMessageDeflate: false });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(safeErrorMessage(error)));
        return;
      }
      this.ws = ws;
      ws.on("close", () => {
        if (this.ws === ws) this.clearCloseTimer();
      });
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  send(message: ClientMessage): void {
    if (this.disposed) throw new Error("signaling socket is closed");
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("signaling socket is not open");
    if (signalingBackpressureExceeded(this.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
      this.close();
      throw new Error("signaling socket backpressure exceeded");
    }
    this.ws.send(serializeMessage(message));
    if (signalingBackpressureExceeded(this.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
      this.close();
      throw new Error("signaling socket backpressure exceeded");
    }
  }

  close(): void {
    if (this.disposed) return;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) {
      this.dispose();
      return;
    }
    ws.close();
    this.scheduleCloseTermination(ws);
  }

  currentIceServers(): RTCIceServer[] | undefined {
    if (this.disposed) return undefined;
    return this.latestIceServers ? cloneIceServers(this.latestIceServers) : undefined;
  }

  drainSignalMessages(): SignalServerMessage[] {
    if (this.disposed) return [];
    return this.earlySignals.drain();
  }

  isClosed(): boolean {
    return this.disposed || !this.ws || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED;
  }

  private scheduleCloseTermination(ws: WebSocket): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => {
      delete this.closeTimer;
      if (this.ws === ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, SIGNALING_CLOSE_GRACE_MS);
    unrefTimer(this.closeTimer);
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    delete this.closeTimer;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCloseTimer();
    delete this.latestIceServers;
    this.earlySignals.drain();
    this.removeAllListeners();
    this.ws?.removeAllListeners("message");
    this.ws?.removeAllListeners("error");
    this.ws?.removeAllListeners("close");
  }

  private closeSocketAfterFailedConnect(ws: WebSocket | undefined): void {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.dispose();
      return;
    }
    this.armLateSocketErrorSink(ws);
    try {
      ws.close();
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, SIGNALING_CLOSE_GRACE_MS);
      unrefTimer(timer);
    } catch {
      ws.terminate();
    }
    this.dispose();
    this.armLateSocketErrorSink(ws);
  }

  private armLateSocketErrorSink(ws: WebSocket): void {
    if (ws.readyState === WebSocket.CLOSED) return;
    ws.on("error", ignoreLateSocketError);
    ws.once("close", () => {
      ws.off("error", ignoreLateSocketError);
    });
  }
}

function signalingOriginHeader(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
}

export function waitForMessage<T extends ServerMessage["type"]>(
  client: SignalingClient,
  type: T,
  timeoutMs: number,
  sid?: string,
  signal?: AbortSignal
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const waitType = waitMessageType(type);
    const waitTimeoutMs = waitTimeout(timeoutMs);
    const waitSid = waitSessionId(sid);
    const waitSignal = waitAbortSignal(signal);
    if (signalingClientIsClosed(client)) {
      reject(new Error("Signaling socket closed."));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      fail(new SignalingWaitTimeoutError(waitType));
    }, waitTimeoutMs);
    unrefTimer(timer);
    const succeed = (message: Extract<ServerMessage, { type: T }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(message);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (message: unknown) => {
      if (!isServerMessage(message)) return;
      if (waitSid !== undefined && "sid" in message && message.sid !== waitSid) return;
      if (message.type === waitType) {
        succeed(message as Extract<ServerMessage, { type: T }>);
      } else if (message.type === "error") {
        fail(new SignalingError(message.code));
      } else if (message.type === "peer-left" && waitSid !== undefined) {
        fail(new Error("Peer disconnected."));
      }
    };
    const onClose = () => {
      fail(new Error("Signaling socket closed."));
    };
    const onSocketError = (error: Error) => {
      fail(error);
    };
    const onProtocolError = (error: Error) => {
      fail(error);
    };
    const onAbort = () => {
      fail(new Error(`Cancelled waiting for ${waitType}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off("message", onMessage);
      client.off("close", onClose);
      client.off("socket-error", onSocketError);
      client.off("protocol-error", onProtocolError);
      waitSignal?.removeEventListener("abort", onAbort);
    };
    if (waitSignal?.aborted) {
      cleanup();
      reject(new Error(`Cancelled waiting for ${waitType}`));
      return;
    }
    waitSignal?.addEventListener("abort", onAbort, { once: true });
    client.on("message", onMessage);
    client.on("close", onClose);
    client.on("socket-error", onSocketError);
    client.on("protocol-error", onProtocolError);
  });
}

function waitMessageType(type: unknown): ServerMessage["type"] {
  if (typeof type !== "string" || !WAIT_MESSAGE_TYPES.has(type as ServerMessage["type"])) throw new Error("Signaling wait message type is invalid.");
  return type as ServerMessage["type"];
}

function waitTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PAIR_TIMEOUT_MS) {
    throw new Error("Signaling wait timeout is invalid.");
  }
  return timeoutMs;
}

function waitSessionId(sid: unknown): string | undefined {
  if (sid === undefined) return undefined;
  if (typeof sid !== "string" || !WAIT_SESSION_ID.test(sid)) throw new Error("Signaling wait session id is invalid.");
  return sid;
}

function waitAbortSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined) return undefined;
  if (!(signal instanceof AbortSignal)) throw new Error("Signaling wait abort signal is invalid.");
  return signal;
}

function signalingClientIsClosed(client: SignalingClient): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client), "isClosed") ?? Object.getOwnPropertyDescriptor(client, "isClosed");
  if (!descriptor || typeof descriptor.value !== "function") return false;
  return descriptor.value.call(client) === true;
}
