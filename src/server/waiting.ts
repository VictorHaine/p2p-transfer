export function waitingReceiverAvailable(expiresAt: number, now: number, readyState: number, openState: number): boolean {
  return Number.isFinite(expiresAt) && Number.isFinite(now) && typeof readyState === "number" && typeof openState === "number" && expiresAt > now && readyState === openState;
}

export function waitingCodeOwnedBy(entry: { receiver: { id: string } } | undefined, peerId: string): boolean {
  if (typeof peerId !== "string") return false;
  const receiver = ownDataValue(entry, "receiver");
  if (!receiver || typeof receiver !== "object") return false;
  return ownDataValue(receiver, "id") === peerId;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
