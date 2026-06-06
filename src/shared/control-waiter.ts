import { TRANSFER_CONTROL_TIMEOUT_MS } from "./constants.js";

type PendingWait = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const CONTROL_ACK_KINDS = new Set(["ready", "file-ok", "all-done-ok"]);

export class ControlAckWaiter {
  private readonly pending = new Map<string, PendingWait>();
  private failed?: Error;

  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = controlTimeoutInput(timeoutMs);
  }

  mark(kind: string, id?: number): boolean {
    const { key } = controlAckInput(kind, id);
    const wait = this.pending.get(key);
    if (!wait) return false;
    clearTimeout(wait.timer);
    this.pending.delete(key);
    wait.resolve();
    return true;
  }

  wait(kind: string, id?: number): Promise<void> {
    const { key, safeKind, safeId } = controlAckInput(kind, id);
    if (this.failed) return Promise.reject(this.failed);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolveWait!: () => void;
    let rejectWait!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(key);
      rejectWait(new Error(safeId === undefined ? `Timed out waiting for ${safeKind}.` : `Timed out waiting for ${safeKind} for file ${safeId}.`));
    }, this.timeoutMs);
    unrefTimer(timer);
    this.pending.set(key, { promise, resolve: resolveWait, reject: rejectWait, timer });
    return promise;
  }

  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error("Control acknowledgement waiter failed.");
    for (const [key, wait] of this.pending) {
      clearTimeout(wait.timer);
      wait.reject(this.failed);
      this.pending.delete(key);
    }
  }
}

function controlTimeoutInput(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TRANSFER_CONTROL_TIMEOUT_MS) {
    throw new Error("Control acknowledgement timeout is invalid.");
  }
  return timeoutMs;
}

function unrefTimer(timer: unknown): void {
  const unref = timerMethod(timer, "unref");
  unref?.call(timer);
}

function timerMethod(timer: unknown, key: string): (() => void) | undefined {
  if (!timer || (typeof timer !== "object" && typeof timer !== "function")) return undefined;
  let current: object | null = timer;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as () => void : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

function controlAckInput(kind: unknown, id: unknown): { key: string; safeKind: string; safeId: number | undefined } {
  if (typeof kind !== "string" || !CONTROL_ACK_KINDS.has(kind)) throw new Error("Control acknowledgement type is invalid.");
  if (kind === "all-done-ok") {
    if (id !== undefined) throw new Error("Control acknowledgement file id is invalid.");
    return { key: kind, safeKind: kind, safeId: undefined };
  }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id > 255) throw new Error("Control acknowledgement file id is invalid.");
  return { key: `${kind}:${id}`, safeKind: kind, safeId: id };
}
