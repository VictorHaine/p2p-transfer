import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { unrefTimer } from "../src/cli/timers.js";
import { unrefTimer as distUnrefTimer } from "../dist-node/cli/timers.js";

const timerSource = fs.readFileSync(new URL("../src/cli/timers.ts", import.meta.url), "utf8");
const distTimerSource = fs.readFileSync(new URL("../dist-node/cli/timers.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("CLI timer helper unreferences Node timeout and interval handles", () => {
  const timeout = setTimeout(() => {}, 1_000);
  const interval = setInterval(() => {}, 1_000);
  try {
    assert.equal(timeout.hasRef(), true);
    assert.equal(interval.hasRef(), true);
    unrefTimer(timeout);
    unrefTimer(interval);
    assert.equal(timeout.hasRef(), false);
    assert.equal(interval.hasRef(), false);
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
  }
});

test("CLI timer helper ignores malformed timer-like accessors", () => {
  assert.match(securityPolicy, /CLI timer helpers must locate optional timer methods through data descriptors without invoking hostile accessors/);
  for (const helper of [unrefTimer, distUnrefTimer]) {
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "unref", {
      get() {
        invoked = true;
        return () => {
          invoked = true;
        };
      }
    });
    const inheritedHostile = Object.create(hostile);
    assert.doesNotThrow(() => helper(hostile as never));
    assert.doesNotThrow(() => helper(inheritedHostile as never));
    assert.equal(invoked, false);

    let calls = 0;
    const safeTimer = Object.create({
      unref() {
        calls += 1;
      }
    });
    assert.doesNotThrow(() => helper(safeTimer as never));
    assert.equal(calls, 1);
  }
  for (const source of [timerSource, distTimerSource]) {
    assert.match(source, /function timerMethod/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(current, key\)/);
    assert.doesNotMatch(source, /timer\.unref\?\.\(\)/);
  }
});

test("CLI connection and transfer watchdogs are unrefed", () => {
  const sources = [
    fs.readFileSync(new URL("../src/cli/signaling.ts", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../src/cli/rtc.ts", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8")
  ];
  for (const source of sources) {
    assert.match(source, /import \{ unrefTimer \} from "\.\/timers\.js";/);
  }
  assert.match(sources[0]!, /const timer = setTimeout\([\s\S]*CONNECT_TIMEOUT_MS\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[0]!, /const timer = setTimeout\([\s\S]*waitTimeoutMs\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[1]!, /const timer = setTimeout\(\(\) => fail\("WebRTC connection timed out\."\), CONNECT_TIMEOUT_MS\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[1]!, /interval = setInterval\([\s\S]*timer = setTimeout\([\s\S]*TRANSFER_CONTROL_TIMEOUT_MS\);\n\s+unrefTimer\(interval\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[2]!, /const timer = setTimeout\(\(\) => fail\(new Error\("Timed out waiting for data channels\."\)\), CONNECT_TIMEOUT_MS\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[2]!, /const timer = setTimeout\([\s\S]*PAIR_TIMEOUT_MS\);\n\s+unrefTimer\(timer\);/);
  assert.match(sources[3]!, /idleTimer = setTimeout\([\s\S]*idleTimeoutMs\);\n\s+unrefTimer\(idleTimer\);/);
  assert.doesNotMatch(sources[3]!, /idleTimer\.unref\?\.\(\)/);
});
