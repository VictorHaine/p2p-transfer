import test from "node:test";
import assert from "node:assert/strict";
import { websocketCloseReason } from "../src/server/close-reason.js";
import { websocketCloseReason as distWebsocketCloseReason } from "../dist-node/server/close-reason.js";
import fs from "node:fs";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const closeReasonSource = fs.readFileSync(new URL("../src/server/close-reason.ts", import.meta.url), "utf8");
const distCloseReasonSource = fs.readFileSync(new URL("../dist-node/server/close-reason.js", import.meta.url), "utf8");

test("websocket close reasons are bounded by protocol byte length", () => {
  assert.equal(websocketCloseReason("complete"), "complete");
  assert.equal(websocketCloseReason("bad\u001b[31m\nreason"), "bad [31m reason");
  assert.equal(websocketCloseReason(`ok\u202e${"x".repeat(1000)}`).startsWith("ok "), true);
  const reason = websocketCloseReason("🔥".repeat(100));
  assert.equal(new TextEncoder().encode(reason).byteLength <= 123, true);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(reason)));
});

test("websocket close reason helper rejects non-strings before replace coercion", () => {
  let replaceCalled = false;
  const hostile = {
    replace() {
      replaceCalled = true;
      return "complete";
    },
    toString() {
      replaceCalled = true;
      return "complete";
    }
  };

  assert.throws(() => websocketCloseReason(hostile as never), /must be a string/);
  assert.throws(() => distWebsocketCloseReason(hostile as never), /must be a string/);
  assert.equal(replaceCalled, false);
  assert.match(securityPolicy, /WebSocket close reason helpers must reject non-string values before replacement or byte-length accounting and must not allocate a fully sanitized copy/);
  for (const source of [closeReasonSource, distCloseReasonSource]) {
    assert.match(source, /typeof reason !== "string"/);
    assert.match(source, /WebSocket close reason must be a string/);
    assert.match(source, /function closeReasonChar/);
    assert.match(source, /for \(const char of reason\)/);
    assert.doesNotMatch(source, /reason\.replace/);
  }
});
