import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SIGNALING_MAX_BUFFERED_BYTES } from "../src/shared/constants.js";
import { signalingBackpressureExceeded } from "../src/shared/signaling-backpressure.js";

test("signaling send path treats excessive queued websocket bytes as backpressure", () => {
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: 0 }, SIGNALING_MAX_BUFFERED_BYTES), false);
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: SIGNALING_MAX_BUFFERED_BYTES }, SIGNALING_MAX_BUFFERED_BYTES), false);
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: SIGNALING_MAX_BUFFERED_BYTES + 1 }, SIGNALING_MAX_BUFFERED_BYTES), true);
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: Number.NaN }, SIGNALING_MAX_BUFFERED_BYTES), true);
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: "1" as never }, SIGNALING_MAX_BUFFERED_BYTES), true);

  let coerced = false;
  const hostileMax = {
    valueOf() {
      coerced = true;
      return SIGNALING_MAX_BUFFERED_BYTES;
    }
  };
  assert.equal(signalingBackpressureExceeded({ bufferedAmount: 0 }, hostileMax as never), true);
  assert.equal(coerced, false);

  const throwingSocket = {};
  Object.defineProperty(throwingSocket, "bufferedAmount", {
    get() {
      throw new Error("bufferedAmount getter failed");
    }
  });
  assert.equal(signalingBackpressureExceeded(throwingSocket as never, SIGNALING_MAX_BUFFERED_BYTES), true);
});

test("server signaling send cleans up peers when outbound buffering exceeds the cap", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  const backpressureSource = fs.readFileSync(new URL("../src/shared/signaling-backpressure.ts", import.meta.url), "utf8");
  const distBackpressureSource = fs.readFileSync(new URL("../dist-node/shared/signaling-backpressure.js", import.meta.url), "utf8");
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const distServerSource = fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8");
  const distWebBundle = readDistWebBundle();
  assert.match(securityPolicy, /signaling backpressure helpers must treat malformed byte limits or unreadable queued-byte counts as backpressure/);
  assert.match(securityPolicy, /signaling send failures from pre-send backpressure, post-send backpressure, or WebSocket send exceptions must immediately clean up/);
  for (const source of [backpressureSource, distBackpressureSource]) {
    assert.match(source, /typeof maxBufferedBytes !== "number"/);
    assert.match(source, /catch \{/);
    assert.match(source, /typeof bufferedAmount !== "number"/);
  }
  assert.match(distWebBundle, /typeof t!=`number`/);
  assert.match(distWebBundle, /catch\{return!0\}/);

  for (const source of [serverSource, distServerSource]) {
    const sendBody = extractFunctionBody(source, "send");
    const cleanupBody = extractFunctionBody(source, "closePeerForSendFailure");
    const wsSendIndex = sendBody.indexOf("peer.ws.send(serializeMessage(message))");
    assert.notEqual(wsSendIndex, -1);
    const afterSend = sendBody.slice(wsSendIndex);
    assert.match(sendBody, /signalingBackpressureExceeded\(peer\.ws, SIGNALING_MAX_BUFFERED_BYTES\)[\s\S]*closePeerForSendFailure\(peer, "signaling backpressure"\)[\s\S]*return false/);
    assert.match(afterSend, /signalingBackpressureExceeded\(peer\.ws, SIGNALING_MAX_BUFFERED_BYTES\)[\s\S]*closePeerForSendFailure\(peer, "signaling backpressure"\)[\s\S]*return false/);
    assert.match(sendBody, /catch \{[\s\S]*closePeerForSendFailure\(peer, "send_error"\)[\s\S]*return false/);
    assert.match(cleanupBody, /cleanupPeer\(peer, reason\);[\s\S]*closePeerAndRelease\(peer, reason\)/);
  }
});

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  const bodyStart = findFunctionBodyStart(source, start + signature.length - 1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not extract ${name} body.`);
}

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}

function findFunctionBodyStart(source: string, index: number): number {
  let parenDepth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (char === "{" && parenDepth === 0) return cursor;
  }
  throw new Error("Could not find function body.");
}
