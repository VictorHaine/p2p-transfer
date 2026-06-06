import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canCreateSession, canRegisterWaitingCode, staticFileWithinLimit } from "../src/server/capacity.js";
import { waitingCodeOwnedBy, waitingReceiverAvailable } from "../src/server/waiting.js";

const capacitySource = fs.readFileSync(new URL("../src/server/capacity.ts", import.meta.url), "utf8");
const distCapacitySource = fs.readFileSync(new URL("../dist-node/server/capacity.js", import.meta.url), "utf8");
const waitingSource = fs.readFileSync(new URL("../src/server/waiting.ts", import.meta.url), "utf8");
const distWaitingSource = fs.readFileSync(new URL("../dist-node/server/waiting.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("server capacity rejects new waiting codes and sessions at hard limits", () => {
  assert.equal(canRegisterWaitingCode(9, 10, false), true);
  assert.equal(canRegisterWaitingCode(10, 10, false), false);
  assert.equal(canRegisterWaitingCode(10, 10, true), true);
  assert.equal(canCreateSession(9, 10), true);
  assert.equal(canCreateSession(10, 10), false);
});

test("server capacity helpers reject malformed runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    valueOf() {
      coerced = true;
      return 0;
    }
  };

  assert.equal(canRegisterWaitingCode(hostile as never, 10, false), false);
  assert.equal(canRegisterWaitingCode(0, hostile as never, false), false);
  assert.equal(canRegisterWaitingCode(10, 10, { valueOf: () => true } as never), false);
  assert.equal(canCreateSession(hostile as never, 10), false);
  assert.equal(canCreateSession(0, hostile as never), false);
  assert.equal(staticFileWithinLimit(0, hostile as never), false);
  assert.equal(staticFileWithinLimit(hostile as never, 10), false);
  assert.equal(coerced, false);
  assert.match(securityPolicy, /server capacity and static-file limit helpers must reject malformed runtime values before numeric comparison or boolean bypass decisions/);
  for (const source of [capacitySource, distCapacitySource]) {
    assert.match(source, /replacingOwnCode === true/);
    assert.match(source, /typeof value === "number" && Number\.isSafeInteger\(value\) && value >= 0/);
  }
});

test("static file size limit accepts only safe non-negative bounded sizes", () => {
  assert.equal(staticFileWithinLimit(0, 10), true);
  assert.equal(staticFileWithinLimit(10, 10), true);
  assert.equal(staticFileWithinLimit(11, 10), false);
  assert.equal(staticFileWithinLimit(-1, 10), false);
  assert.equal(staticFileWithinLimit(Number.MAX_SAFE_INTEGER + 1, 10), false);
});

test("waiting receiver availability requires live socket and unexpired code", () => {
  const now = 1_000;
  assert.equal(waitingReceiverAvailable(now + 1, now, 1, 1), true);
  assert.equal(waitingReceiverAvailable(now, now, 1, 1), false);
  assert.equal(waitingReceiverAvailable(now + 1, now, 3, 1), false);
});

test("waiting helpers reject malformed runtime values and accessor-backed ownership", () => {
  let coerced = false;
  const hostileNumber = {
    valueOf() {
      coerced = true;
      return 2_000;
    }
  };
  assert.equal(waitingReceiverAvailable(hostileNumber as never, 1_000, 1, 1), false);
  assert.equal(waitingReceiverAvailable(2_000, hostileNumber as never, 1, 1), false);
  assert.equal(waitingReceiverAvailable(2_000, 1_000, "1" as never, 1), false);
  assert.equal(coerced, false);

  let getterCalled = false;
  const accessorEntry = {};
  Object.defineProperty(accessorEntry, "receiver", {
    enumerable: true,
    get() {
      getterCalled = true;
      return { id: "peer-a" };
    }
  });
  assert.equal(waitingCodeOwnedBy(accessorEntry as never, "peer-a"), false);
  assert.equal(getterCalled, false);
  assert.match(securityPolicy, /server waiting-code helpers must reject malformed runtime values and accessor-backed ownership records before expiry or peer-id decisions/);
  for (const source of [waitingSource, distWaitingSource]) {
    assert.match(source, /Number\.isFinite\(expiresAt\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.doesNotMatch(source, /entry\?\.receiver\.id/);
  }
});

test("waiting code ownership distinguishes refreshes from code collisions", () => {
  assert.equal(waitingCodeOwnedBy(undefined, "peer-a"), false);
  assert.equal(waitingCodeOwnedBy({ receiver: { id: "peer-a" } }, "peer-a"), true);
  assert.equal(waitingCodeOwnedBy({ receiver: { id: "peer-b" } }, "peer-a"), false);
});
