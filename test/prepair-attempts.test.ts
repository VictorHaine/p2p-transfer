import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RECEIVER_MAX_PREPAIR_ATTEMPTS } from "../src/shared/constants.js";
import { canRestorePrePairCode, consumePrePairAttempt, initialPrePairAttempts } from "../src/server/prepair-attempts.js";
import {
  canRestorePrePairCode as distCanRestorePrePairCode,
  consumePrePairAttempt as distConsumePrePairAttempt
} from "../dist-node/server/prepair-attempts.js";

const prePairSource = fs.readFileSync(new URL("../src/server/prepair-attempts.ts", import.meta.url), "utf8");
const distPrePairSource = fs.readFileSync(new URL("../dist-node/server/prepair-attempts.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("pre-pair attempt budget is consumed before receiver restoration", () => {
  let remaining = initialPrePairAttempts();
  assert.equal(remaining, RECEIVER_MAX_PREPAIR_ATTEMPTS);
  assert.equal(RECEIVER_MAX_PREPAIR_ATTEMPTS, 1);
  assert.match(securityPolicy, /strict one-shot pre-pair attempt budget/);
  assert.match(securityPolicy, /must expire the receiver code instead of allowing another online guess/);

  for (let attempt = 1; attempt <= RECEIVER_MAX_PREPAIR_ATTEMPTS; attempt += 1) {
    assert.equal(canRestorePrePairCode(remaining), true);
    remaining = consumePrePairAttempt(remaining);
  }

  assert.equal(remaining, 0);
  assert.equal(canRestorePrePairCode(remaining), false);
  assert.throws(() => consumePrePairAttempt(remaining), /No pre-pair attempts remain/);
});

test("pre-pair attempt helpers reject malformed runtime counters", () => {
  assert.match(securityPolicy, /pre-pair attempt helpers must reject malformed, unsafe, and over-budget runtime counters/);
  let coerced = false;
  const hostileCounter = {
    valueOf() {
      coerced = true;
      return 1;
    }
  };

  for (const restore of [canRestorePrePairCode, distCanRestorePrePairCode]) {
    assert.equal(restore(hostileCounter as never), false);
    assert.equal(restore(0), false);
    assert.equal(restore(RECEIVER_MAX_PREPAIR_ATTEMPTS + 1), false);
    assert.equal(restore(Number.MAX_SAFE_INTEGER + 1), false);
    assert.equal(restore(1.5), false);
    assert.equal(restore(1), true);
  }
  for (const consume of [consumePrePairAttempt, distConsumePrePairAttempt]) {
    assert.throws(() => consume(hostileCounter as never), /No pre-pair attempts remain/);
    assert.throws(() => consume(RECEIVER_MAX_PREPAIR_ATTEMPTS + 1), /No pre-pair attempts remain/);
    assert.throws(() => consume(Number.MAX_SAFE_INTEGER + 1), /No pre-pair attempts remain/);
    assert.equal(consume(1), 0);
  }
  assert.equal(coerced, false);

  for (const source of [prePairSource, distPrePairSource]) {
    assert.match(source, /function isValidRemainingPrePairAttempts/);
    assert.match(source, /typeof remaining === "number"/);
    assert.match(source, /Number\.isSafeInteger\(remaining\)/);
    assert.match(source, /remaining <= RECEIVER_MAX_PREPAIR_ATTEMPTS/);
  }
});

test("server burns a pre-pair attempt when a sender claims a rendezvous", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const connectBody = extractFunctionBody(serverSource, "connect");
  const relayBody = extractFunctionBody(serverSource, "relay");
  const rejectBody = extractFunctionBody(serverSource, "rejectRelayMessage");
  const malformedRejectBody = extractFunctionBody(serverSource, "rejectMalformedPrePairSenderMessage");

  assert.match(connectBody, /if \(waiting\.receiver\.id === peer\.id\) return badMessage\(peer, "Cannot connect to your own receiver code\."\)/);
  assert.match(connectBody, /const remainingPrePairAttempts = consumePrePairAttempt\(waiting\.remainingPrePairAttempts\)/);
  assert.match(connectBody, /remainingPrePairAttempts\s*\n\s*\}/);
  assert.doesNotMatch(relayBody, /consumePrePairAttempt\(session\.remainingPrePairAttempts\)/);
  assert.doesNotMatch(rejectBody, /consumePrePairAttempt\(session\.remainingPrePairAttempts\)/);
  assert.doesNotMatch(malformedRejectBody, /consumePrePairAttempt\(session\.remainingPrePairAttempts\)/);
});

test("receiver re-registering an owned waiting code does not refresh its TTL or attempt budget", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const registerBody = extractFunctionBody(serverSource, "register");

  assert.match(registerBody, /const now = Date\.now\(\)/);
  assert.match(
    registerBody,
    /if \(replacingClaimedCode && existingCode\) \{[\s\S]*waitingReceiverAvailable\(existingCode\.expiresAt, now, peer\.ws\.readyState, peer\.ws\.OPEN\)[\s\S]*send\(peer, \{ type: "registered", code, expiresInSec: remainingExpirySeconds\(existingCode\.expiresAt, now\) \}\);[\s\S]*return;[\s\S]*\}/
  );
  assert.match(registerBody, /const replacingOwnCode = replacingPreviousOwnCode/);
  assert.match(registerBody, /expiresAt: now \+ CODE_TTL_MS/);
  assert.doesNotMatch(registerBody, /replacingClaimedCode \|\| replacingPreviousOwnCode/);
});

test("pre-pair expiry clears both peer session states before closing sockets", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const expireBody = extractFunctionBody(serverSource, "expireReceiverAfterPrePairAttempts");
  const senderClear = expireBody.indexOf("clearPeerSessionState(session.sender)");
  const receiverClear = expireBody.indexOf("clearPeerSessionState(session.receiver)");
  const senderClose = expireBody.indexOf('closePeerAndRelease(session.sender, "too many invalid pairing attempts")');
  const receiverClose = expireBody.indexOf('closePeerAndRelease(session.receiver, "too many invalid pairing attempts")');
  assert.equal(senderClear >= 0, true);
  assert.equal(receiverClear >= 0, true);
  assert.equal(senderClose > senderClear, true);
  assert.equal(receiverClose > receiverClear, true);
  assert.doesNotMatch(expireBody, /session\.receiver\.code = undefined/);
  assert.doesNotMatch(expireBody, /session\.receiver\.role = undefined/);
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
