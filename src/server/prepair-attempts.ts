import { RECEIVER_MAX_PREPAIR_ATTEMPTS } from "../shared/constants.js";

export function initialPrePairAttempts(): number {
  return RECEIVER_MAX_PREPAIR_ATTEMPTS;
}

export function consumePrePairAttempt(remaining: number): number {
  if (!isValidRemainingPrePairAttempts(remaining)) {
    throw new Error("No pre-pair attempts remain.");
  }
  return remaining - 1;
}

export function canRestorePrePairCode(remaining: number): boolean {
  return isValidRemainingPrePairAttempts(remaining);
}

function isValidRemainingPrePairAttempts(remaining: unknown): remaining is number {
  return typeof remaining === "number" && Number.isSafeInteger(remaining) && remaining > 0 && remaining <= RECEIVER_MAX_PREPAIR_ATTEMPTS;
}
