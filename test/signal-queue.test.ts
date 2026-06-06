import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SignalMessageQueue } from "../src/shared/signal-queue.js";
import { SignalMessageQueue as DistSignalMessageQueue } from "../dist-node/shared/signal-queue.js";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/shared/signal-queue.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/shared/signal-queue.js", import.meta.url), "utf8");
const validAuthTag = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("signal message queue buffers and drains early WebRTC signals", () => {
  const queue = new SignalMessageQueue(2);
  const offer = { type: "signal" as const, sid: "sid", signal: { kind: "offer" as const, sdp: "v=0\r\n", auth: validAuthTag } };
  const candidate = {
    type: "signal" as const,
    sid: "sid",
    signal: { kind: "candidate" as const, candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 1 typ host", sdpMid: "0" }, auth: validAuthTag }
  };

  queue.push(offer);
  queue.push(candidate);
  assert.deepEqual(queue.drain(), [offer, candidate]);
  assert.deepEqual(queue.drain(), []);
});

test("signal message queue is bounded", () => {
  const queue = new SignalMessageQueue(1);
  queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: validAuthTag } });
  assert.throws(
    () => queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: validAuthTag } }),
    /Too many buffered/
  );
});

test("signal message queue is byte bounded", () => {
  const queue = new SignalMessageQueue(10, 250);
  queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: validAuthTag } });
  assert.throws(
    () => queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n".repeat(80), auth: validAuthTag } }),
    /Too many buffered WebRTC signal bytes/
  );
  assert.equal(queue.drain().length, 1);
  assert.doesNotThrow(() => queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: validAuthTag } }));
});

test("signal message queue byte accounting uses safe signaling serialization", () => {
  const queue = new SignalMessageQueue(10, 250);
  const original = (Object.prototype as { toJSON?: unknown }).toJSON;
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        return { type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n".repeat(100), auth: validAuthTag } };
      }
    });
    queue.push({ type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: validAuthTag } });
  } finally {
    if (original === undefined) {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    } else {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: original });
    }
  }
  assert.equal(queue.drain().length, 1);
});

test("signal message queue validates limits and stores defensive message copies", () => {
  assert.match(securityPolicy, /buffered early WebRTC signal queues must validate queue limits and signal message shape/);
  let coerced = false;
  const hostileLimit = {
    valueOf() {
      coerced = true;
      return 1;
    }
  };
  const hostileSignal = Object.create(null);
  Object.defineProperty(hostileSignal, "type", {
    enumerable: true,
    get() {
      coerced = true;
      return "signal";
    }
  });

  for (const Queue of [SignalMessageQueue, DistSignalMessageQueue]) {
    assert.throws(() => new Queue(hostileLimit as never), /message limit is invalid/);
    assert.throws(() => new Queue(1, hostileLimit as never), /byte limit is invalid/);
    assert.throws(() => new Queue(0), /message limit is invalid/);
    assert.throws(() => new Queue(301), /message limit is invalid/);
    const queue = new Queue(2, 1000);
    assert.throws(() => queue.push(hostileSignal as never), /Buffered WebRTC signal message is invalid/);
    const message = { type: "signal" as const, sid: "sid", signal: { kind: "answer" as const, sdp: "v=0\r\n", auth: validAuthTag } };
    queue.push(message);
    message.signal.sdp = "v=0\r\n".repeat(1000);
    const drained = queue.drain();
    assert.equal(drained[0]?.signal.kind, "answer");
    assert.equal(drained[0]?.signal.kind === "answer" ? drained[0].signal.sdp : "", "v=0\r\n");
    assert.equal(queue.drain()[0], undefined);
  }
  assert.equal(coerced, false);

  for (const text of [source, distSource]) {
    assert.match(text, /function queueLimitInput/);
    assert.match(text, /function copySignalMessage/);
    assert.match(text, /parseJsonMessage\(serialized\)/);
    assert.match(text, /this\.messages\.push\(copy\)/);
    assert.doesNotMatch(text, /this\.messages\.push\(message\)/);
  }
});
