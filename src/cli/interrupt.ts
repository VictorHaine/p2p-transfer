import { unrefTimer } from "./timers.js";

export class InterruptError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}.`);
    this.name = "InterruptError";
    this.signal = signal;
  }
}

type SignalTarget = Pick<NodeJS.Process, "once" | "off">;
const INTERRUPT_CLEANUP_TIMEOUT_MS = 5_000;

export type InterruptHandle = {
  readonly interrupted: boolean;
  readonly error: InterruptError | undefined;
  promise: Promise<never>;
  dispose(): void;
};

export function onInterrupt(cleanup: () => void, target: SignalTarget = process): InterruptHandle {
  if (typeof cleanup !== "function") throw new Error("Interrupt cleanup is invalid.");
  const once = signalTargetMethod(target, "once");
  const off = signalTargetMethod(target, "off");
  if (!once || !off) throw new Error("Interrupt signal target is invalid.");

  let interrupted = false;
  let interruptError: InterruptError | undefined;
  let rejectInterrupt!: (error: InterruptError) => void;
  const handlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  const promise = new Promise<never>((_, reject) => {
    rejectInterrupt = reject;
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (interrupted) return;
      interrupted = true;
      interruptError = new InterruptError(signal);
      try {
        cleanup();
      } catch {
        // Best-effort shutdown; the socket may already be closed.
      }
      rejectInterrupt(interruptError);
    };
    handlers.push({ signal, handler });
    try {
      once.call(target, signal, handler);
    } catch {
      for (const registered of handlers.slice(0, -1)) {
        try {
          off.call(target, registered.signal, registered.handler);
        } catch {
          // Best-effort rollback; the caller never received a disposable handle.
        }
      }
      throw new Error("Interrupt signal target is invalid.");
    }
  }

  return {
    get interrupted() {
      return interrupted;
    },
    get error() {
      return interruptError;
    },
    promise,
    dispose() {
      for (const { signal, handler } of handlers) off.call(target, signal, handler);
    }
  };
}

function signalTargetMethod(target: unknown, key: "once" | "off"): ((signal: NodeJS.Signals, handler: () => void) => unknown) | undefined {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
  let current: object | null = target;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as (signal: NodeJS.Signals, handler: () => void) => unknown : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

export async function withInterrupt<T>(operation: Promise<T>, interrupt: InterruptHandle): Promise<T> {
  try {
    const result = await Promise.race([operation, interrupt.promise]);
    if (interrupt.interrupted) throw interrupt.error;
    return result;
  } catch (error) {
    if (error instanceof InterruptError) await waitForOperationCleanup(operation);
    throw error;
  }
}

async function waitForOperationCleanup(operation: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, INTERRUPT_CLEANUP_TIMEOUT_MS);
        unrefTimer(timeout);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
