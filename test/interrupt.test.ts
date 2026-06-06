import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { InterruptError, onInterrupt, withInterrupt } from "../src/cli/interrupt.js";
import { onInterrupt as distOnInterrupt } from "../dist-node/cli/interrupt.js";

const source = fs.readFileSync(new URL("../src/cli/interrupt.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/cli/interrupt.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("withInterrupt returns the operation result when no signal arrives", async () => {
  const target = new EventEmitter();
  const interrupt = onInterrupt(() => {
    throw new Error("cleanup should not run");
  }, target as never);

  assert.equal(await withInterrupt(Promise.resolve(42), interrupt), 42);
  interrupt.dispose();
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("withInterrupt rejects once and runs cleanup on SIGINT without exiting the process", async () => {
  const target = new EventEmitter();
  let cleanupCalls = 0;
  let finishOperation!: () => void;
  const operation = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });
  const interrupt = onInterrupt(() => {
    cleanupCalls += 1;
    finishOperation();
    throw new Error("cleanup failure is best-effort");
  }, target as never);

  const raced = withInterrupt(operation, interrupt);
  target.emit("SIGINT");
  target.emit("SIGINT");

  await assert.rejects(raced, (error) => error instanceof InterruptError && error.signal === "SIGINT");
  assert.equal(interrupt.interrupted, true);
  assert.equal(cleanupCalls, 1);
  interrupt.dispose();
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("withInterrupt also treats SIGTERM as command cancellation", async () => {
  const target = new EventEmitter();
  let cleanupCalls = 0;
  let finishOperation!: () => void;
  const operation = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });
  const interrupt = onInterrupt(() => {
    cleanupCalls += 1;
    finishOperation();
  }, target as never);

  const raced = withInterrupt(operation, interrupt);
  target.emit("SIGTERM");

  await assert.rejects(raced, (error) => error instanceof InterruptError && error.signal === "SIGTERM");
  assert.equal(cleanupCalls, 1);
  interrupt.dispose();
});

test("onInterrupt rejects malformed targets without accessors or leaked partial listeners", () => {
  assert.match(securityPolicy, /CLI interrupt helpers must locate signal listener methods through data descriptors/);
  for (const helper of [onInterrupt, distOnInterrupt]) {
    let invokedAccessor = false;
    const hostileTarget = {};
    Object.defineProperty(hostileTarget, "once", {
      get() {
        invokedAccessor = true;
        return () => undefined;
      }
    });
    Object.defineProperty(hostileTarget, "off", {
      get() {
        invokedAccessor = true;
        return () => undefined;
      }
    });
    assert.throws(() => helper(() => undefined, hostileTarget as never), /Interrupt signal target is invalid/);
    assert.equal(invokedAccessor, false);

    const registered = new Map<string, () => void>();
    const rollbackTarget = {
      once(signal: string, handler: () => void) {
        if (signal === "SIGTERM") throw new Error("registration failed");
        registered.set(signal, handler);
      },
      off(signal: string, handler: () => void) {
        if (registered.get(signal) === handler) registered.delete(signal);
      }
    };
    assert.throws(() => helper(() => undefined, rollbackTarget as never), /Interrupt signal target is invalid/);
    assert.equal(registered.size, 0);
  }

  for (const document of [source, distSource]) {
    assert.match(document, /function signalTargetMethod/);
    assert.match(document, /Object\.getOwnPropertyDescriptor\(current, key\)/);
    assert.match(document, /unrefTimer\(timeout\)/);
    assert.doesNotMatch(document, /target\.once\(/);
    assert.doesNotMatch(document, /target\.off\(/);
    assert.doesNotMatch(document, /timeout\.unref\?\.\(\)/);
  }
});
