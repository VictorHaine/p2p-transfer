import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PAIR_TIMEOUT_MS, PAKE_TIMEOUT_MS } from "../src/shared/constants.js";
import { initialSessionExpiresAt, nextSessionExpiresAt, remainingExpirySeconds } from "../src/server/session-expiry.js";

const sessionExpirySource = fs.readFileSync(new URL("../src/server/session-expiry.ts", import.meta.url), "utf8");
const distSessionExpirySource = fs.readFileSync(new URL("../dist-node/server/session-expiry.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const AUTH_TAG = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("new signaling sessions expire at the PAKE deadline until sender proves the code", () => {
  const now = 1_000_000;
  assert.equal(initialSessionExpiresAt(now), now + PAKE_TIMEOUT_MS);
});

test("pair request and receiver acceptance use the bounded setup deadline", () => {
  const now = 1_000_000;
  const current = initialSessionExpiresAt(now);
  assert.equal(nextSessionExpiresAt(current, now + 10, { type: "pake", sid: "sid", data: "share" }), current);
  assert.equal(nextSessionExpiresAt(current, now + 20, { type: "pair-request", sid: "sid", manifest: { fileCount: 1, totalBytes: 1, files: [{ name: "x", size: 1 }] }, sealedManifest: "sealed" }), now + 20 + PAIR_TIMEOUT_MS);
  assert.equal(nextSessionExpiresAt(current, now + 30, { type: "pair-accept", sid: "sid", auth: AUTH_TAG }), now + 30 + PAIR_TIMEOUT_MS);
  assert.match(securityPolicy, /post-accept signaling sessions must keep only a bounded WebRTC setup window/);
  assert.doesNotMatch(sessionExpirySource, /SESSION_TTL_MS/);
});

test("restored pre-pair registrations report remaining original code TTL", () => {
  const now = 1_000_000;
  assert.equal(remainingExpirySeconds(now + 12_345, now), 12);
  assert.equal(remainingExpirySeconds(now - 1, now), 0);
});

test("session expiry helpers reject malformed runtime values before coercion or accessors", () => {
  let coerced = false;
  const hostileNumber = {
    valueOf() {
      coerced = true;
      return 1_000;
    }
  };
  assert.throws(() => initialSessionExpiresAt(hostileNumber as never), /Session expiry time is invalid/);
  assert.throws(() => nextSessionExpiresAt(hostileNumber as never, 1_000, { type: "pake", sid: "sid", data: "share" }), /Session expiry time is invalid/);
  assert.equal(remainingExpirySeconds(hostileNumber as never, 1_000), 0);
  assert.equal(coerced, false);

  let getterCalled = false;
  const accessorMessage = {};
  Object.defineProperty(accessorMessage, "type", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "pair-accept";
    }
  });
  assert.equal(nextSessionExpiresAt(2_000, 1_000, accessorMessage as never), 2_000);
  assert.equal(getterCalled, false);
  assert.match(securityPolicy, /session expiry helpers must reject malformed runtime times and read message types through own data descriptors/);
  for (const source of [sessionExpirySource, distSessionExpirySource]) {
    assert.match(source, /typeof value !== "number" \|\| !Number\.isFinite\(value\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.doesNotMatch(source, /message\.type ===/);
  }
});

test("sender lookups of expired waiting codes notify and clear the stale receiver", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const connectBody = extractFunctionBody(serverSource, "connect");

  assert.match(
    connectBody,
    /if \(!waitingReceiverAvailable\(waiting\.expiresAt, Date\.now\(\), waiting\.receiver\.ws\.readyState, waiting\.receiver\.ws\.OPEN\)\) \{[\s\S]*codes\.delete\(code\);[\s\S]*clearPeerSessionState\(waiting\.receiver\);[\s\S]*fail\(waiting\.receiver, "expired", "Code expired before a sender connected\."\);[\s\S]*closePeerAndRelease\(waiting\.receiver, "expired"\);[\s\S]*return fail\(peer, "code_not_found", "No receiver is waiting for that code\."\);[\s\S]*\}/
  );
});

test("all waiting-code expiry paths clear receiver state before closing", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const connectBody = extractFunctionBody(serverSource, "connect");

  assert.match(
    serverSource,
    /if \(entry\.expiresAt <= now\) \{[\s\S]*send\(entry\.receiver, \{ type: "error", code: "expired", message: "Code expired before a sender connected\." \}\);[\s\S]*clearPeerSessionState\(entry\.receiver\);[\s\S]*closePeerAndRelease\(entry\.receiver, "expired"\);[\s\S]*codes\.delete\(code\);[\s\S]*\}/
  );
  assert.match(
    connectBody,
    /if \(!canRestorePrePairCode\(waiting\.remainingPrePairAttempts\)\) \{[\s\S]*codes\.delete\(code\);[\s\S]*clearPeerSessionState\(waiting\.receiver\);[\s\S]*fail\(waiting\.receiver, "expired", "Receive code expired after too many invalid pairing attempts\."\);[\s\S]*closePeerAndRelease\(waiting\.receiver, "too many invalid pairing attempts"\);[\s\S]*return fail\(peer, "code_not_found", "No receiver is waiting for that code\."\);[\s\S]*\}/
  );
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
