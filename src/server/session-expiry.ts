import { PAIR_TIMEOUT_MS, PAKE_TIMEOUT_MS } from "../shared/constants.js";
import type { ClientMessage } from "../shared/messages.js";

export function initialSessionExpiresAt(now: number): number {
  assertFiniteTime(now);
  return now + PAKE_TIMEOUT_MS;
}

export function nextSessionExpiresAt(current: number, now: number, message: Extract<ClientMessage, { sid: string }>): number {
  assertFiniteTime(current);
  assertFiniteTime(now);
  const type = ownDataValue(message, "type");
  if (type === "pair-request") return now + PAIR_TIMEOUT_MS;
  return type === "pair-accept" ? now + PAIR_TIMEOUT_MS : current;
}

export function remainingExpirySeconds(expiresAt: number, now: number): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

function assertFiniteTime(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Session expiry time is invalid.");
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
