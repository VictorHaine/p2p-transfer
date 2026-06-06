import { MAX_BUFFERED_SIGNAL_MESSAGES, SIGNALING_MAX_BUFFERED_BYTES } from "./constants.js";
import { isServerMessage, parseJsonMessage, serializeMessage, type ServerMessage } from "./messages.js";

export type SignalServerMessage = Extract<ServerMessage, { type: "signal" }>;

export class SignalMessageQueue {
  private readonly messages: SignalServerMessage[] = [];
  private bufferedBytes = 0;

  private readonly maxMessages: number;
  private readonly maxBytes: number;

  constructor(
    maxMessages: number,
    maxBytes = Number.POSITIVE_INFINITY
  ) {
    this.maxMessages = queueLimitInput(maxMessages, "message", MAX_BUFFERED_SIGNAL_MESSAGES, false);
    this.maxBytes = queueLimitInput(maxBytes, "byte", SIGNALING_MAX_BUFFERED_BYTES, true);
  }

  push(message: SignalServerMessage): void {
    if (this.messages.length >= this.maxMessages) throw new Error("Too many buffered WebRTC signal messages.");
    const { copy, bytes } = copySignalMessage(message);
    const messageBytes = bytes;
    if (this.bufferedBytes + messageBytes > this.maxBytes) throw new Error("Too many buffered WebRTC signal bytes.");
    this.messages.push(copy);
    this.bufferedBytes += messageBytes;
  }

  drain(): SignalServerMessage[] {
    this.bufferedBytes = 0;
    return this.messages.splice(0);
  }
}

const text = new TextEncoder();

function queueLimitInput(value: unknown, label: string, max: number, allowInfinity: boolean): number {
  if (allowInfinity && value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Signal queue ${label} limit is invalid.`);
  return value;
}

function copySignalMessage(message: unknown): { copy: SignalServerMessage; bytes: number } {
  if (!isServerMessage(message) || message.type !== "signal") throw new Error("Buffered WebRTC signal message is invalid.");
  const serialized = serializeMessage(message);
  const parsed = parseJsonMessage(serialized);
  if (!isServerMessage(parsed) || parsed.type !== "signal") throw new Error("Buffered WebRTC signal message is invalid.");
  return { copy: parsed, bytes: text.encode(serialized).byteLength };
}
