export function canRegisterWaitingCode(waitingCodes: number, maxWaitingCodes: number, replacingOwnCode: boolean): boolean {
  return replacingOwnCode === true || (isSafeNonNegativeInteger(waitingCodes) && isSafeNonNegativeInteger(maxWaitingCodes) && waitingCodes < maxWaitingCodes);
}

export function canCreateSession(activeSessions: number, maxSessions: number): boolean {
  return isSafeNonNegativeInteger(activeSessions) && isSafeNonNegativeInteger(maxSessions) && activeSessions < maxSessions;
}

export function staticFileWithinLimit(size: number, maxBytes: number): boolean {
  return isSafeNonNegativeInteger(size) && isSafeNonNegativeInteger(maxBytes) && size <= maxBytes;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
