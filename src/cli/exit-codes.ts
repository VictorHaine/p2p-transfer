import { InterruptError } from "./interrupt.js";

const SECURITY_OR_INTEGRITY_FAILURE =
  /Authenticated (?:SDP|WebRTC signal)|decrypt|encrypted payload|hash mismatch|PAKE|wrong code|MITM|integrity|session keys have been wiped|file path changed before verification|partial file changed before publish|manifest does not match/i;

export function classifyExitCode(error: unknown): number {
  const message = safeErrorMessage(error);
  if (/declined|rejected|user_declined/i.test(message)) return 2;
  if (
    /timed out|timeout|WebRTC connection (?:failed|closed|disconnected)|DataChannel .* (?:closing|closed|failed|did not open|backpressure did not drain)|channel (?:closed|errored|failed)|NAT|relay/i.test(message)
  ) {
    return 3;
  }
  if (error instanceof InterruptError || /interrupted/i.test(message)) return 130;
  if (SECURITY_OR_INTEGRITY_FAILURE.test(message)) return 4;
  return 1;
}

export function safeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const message = ownStringDataProperty(error, "message");
  return message && message.length > 0 ? message : "Unexpected error.";
}

function ownStringDataProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  let current: object | null = value;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}
