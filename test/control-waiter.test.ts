import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ControlAckWaiter } from "../src/shared/control-waiter.js";
import { ControlAckWaiter as DistControlAckWaiter } from "../dist-node/shared/control-waiter.js";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/shared/control-waiter.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/shared/control-waiter.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("control ack waiter resolves only armed acknowledgements", async () => {
  const waiter = new ControlAckWaiter(50);
  assert.equal(waiter.mark("ready", 0), false);
  await assert.rejects(() => waiter.wait("ready", 0), /Timed out waiting for ready/);

  const pending = waiter.wait("file-ok", 1);
  setTimeout(() => assert.equal(waiter.mark("file-ok", 1), true), 1);
  await pending;

  const done = waiter.wait("all-done-ok");
  setTimeout(() => assert.equal(waiter.mark("all-done-ok"), true), 1);
  await done;
});

test("control ack waiter reuses duplicate waits without orphaning timers", async () => {
  const waiter = new ControlAckWaiter(50);
  const first = waiter.wait("ready", 4);
  const second = waiter.wait("ready", 4);
  assert.equal(first, second);
  setTimeout(() => assert.equal(waiter.mark("ready", 4), true), 1);
  await first;
  await second;
});

test("control ack waiter does not keep Node processes alive during timeout waits", () => {
  assert.match(securityPolicy, /control acknowledgement waiters must reject malformed acknowledgement types[\s\S]*unref timers through descriptor lookup/);
  for (const text of [source, distSource]) {
    assert.match(text, /function unrefTimer/);
    assert.match(text, /function timerMethod/);
    assert.match(text, /Object\.getOwnPropertyDescriptor\(current, key\)/);
    assert.match(text, /unrefTimer\(timer\)/);
    assert.doesNotMatch(text, /timer\.unref\?\.\(\)/);
  }
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+,\w+\)/);
  assert.match(distWebBundle, /\.call\(\w+\)/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(n,t\)/);
  assert.doesNotMatch(distWebBundle, /\.unref\?\.\(\)/);
});

test("control ack waiter rejects pending and future waits after peer failure", async () => {
  const waiter = new ControlAckWaiter(50);
  const pending = waiter.wait("ready", 2);
  waiter.fail(new Error("peer aborted"));
  await assert.rejects(pending, /peer aborted/);
  await assert.rejects(() => waiter.wait("file-ok", 2), /peer aborted/);
});

test("control ack waiter times out missing acknowledgements", async () => {
  const waiter = new ControlAckWaiter(5);
  await assert.rejects(() => waiter.wait("ready", 3), /Timed out waiting for ready/);
});

test("control ack waiter rejects malformed runtime inputs before coercion or timers", () => {
  assert.match(securityPolicy, /exported control acknowledgement waiters must reject malformed acknowledgement types, ids, and timeout values/);
  let coerced = false;
  const hostileKind = {
    toString() {
      coerced = true;
      return "ready";
    }
  };
  const hostileId = {
    valueOf() {
      coerced = true;
      return 1;
    }
  };
  const hostileTimeout = {
    valueOf() {
      coerced = true;
      return 5;
    }
  };

  for (const Waiter of [ControlAckWaiter, DistControlAckWaiter]) {
    assert.throws(() => new Waiter(hostileTimeout as never), /timeout is invalid/);
    const waiter = new Waiter(5);
    assert.throws(() => waiter.wait(hostileKind as never, 1), /type is invalid/);
    assert.throws(() => waiter.wait("ready", hostileId as never), /file id is invalid/);
    assert.throws(() => waiter.wait("ready"), /file id is invalid/);
    assert.throws(() => waiter.wait("all-done-ok", 0), /file id is invalid/);
    assert.throws(() => waiter.mark("other", 0), /type is invalid/);
    assert.throws(() => new Waiter(0), /timeout is invalid/);
    assert.throws(() => new Waiter(60_001), /timeout is invalid/);
  }
  assert.equal(coerced, false);

  for (const text of [source, distSource]) {
    assert.match(text, /function controlTimeoutInput/);
    assert.match(text, /function controlAckInput/);
    assert.match(text, /CONTROL_ACK_KINDS/);
    assert.match(text, /typeof kind !== "string"/);
    assert.match(text, /typeof id !== "number"/);
    assert.doesNotMatch(text, /function controlKey/);
  }
  assert.match(distWebBundle, /Control acknowledgement type is invalid/);
  assert.match(distWebBundle, /Control acknowledgement timeout is invalid/);
  assert.match(distWebBundle, /Control acknowledgement timeout is invalid/);
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.equal(bundleNames.length, 1);
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
