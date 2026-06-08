import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ICE_CONFIG_MAX_REQUESTS_PER_MINUTE, TURN_REST_CREDENTIALS_MAX_ISSUES_PER_MINUTE } from "../src/shared/constants.js";
import { hitFixedWindowRateLimit, hitIceConfigRateLimit, hitTurnCredentialIssueRateLimit, pruneFixedWindowRateLimits, recordFixedWindowHit } from "../src/server/rate-limit.js";

const rateLimitSource = fs.readFileSync(new URL("../src/server/rate-limit.ts", import.meta.url), "utf8");
const distRateLimitSource = fs.readFileSync(new URL("../dist-node/server/rate-limit.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("fixed-window rate limiter rejects requests over the configured cap", () => {
  const hits = new Map<string, number[]>();
  assert.equal(hitFixedWindowRateLimit(hits, "ip", 1_000, 60_000, 2), true);
  assert.equal(hitFixedWindowRateLimit(hits, "ip", 1_001, 60_000, 2), true);
  assert.equal(hitFixedWindowRateLimit(hits, "ip", 1_002, 60_000, 2), false);
  assert.deepEqual(hits.get("ip"), [1_000, 1_001, 1_002]);
  assert.equal(hitFixedWindowRateLimit(hits, "ip", 61_001, 60_000, 2), true);
  assert.deepEqual(hits.get("ip"), [1_002, 61_001]);
});

test("fixed-window rate limiter caps retained hits for abusive keys", () => {
  const hits = new Map<string, number[]>();
  for (let i = 0; i < 1_000; i += 1) {
    hitFixedWindowRateLimit(hits, "ip", 1_000 + i, 60_000, 2);
  }
  assert.deepEqual(hits.get("ip"), [1_997, 1_998, 1_999]);
  assert.equal(hitFixedWindowRateLimit(hits, "ip", 61_998, 60_000, 2), true);
  assert.deepEqual(hits.get("ip"), [1_999, 61_998]);
});

test("fixed-window hit recorder caps per-connection retained message timestamps", () => {
  let values: number[] = [];
  for (let i = 0; i < 1_000; i += 1) {
    const result = recordFixedWindowHit(values, 1_000 + i, 60_000, 240);
    values = result.hits;
  }
  assert.equal(values.length, 241);
  assert.equal(values.at(0), 1_759);
  assert.equal(values.at(-1), 1_999);
  assert.equal(recordFixedWindowHit(values, 2_000, 60_000, 240).allowed, false);
});

test("fixed-window hit recorder does not filter over unbounded caller arrays", () => {
  const hostile = Array.from({ length: 20_000 }, (_, index) => 1_000 + index);
  const result = recordFixedWindowHit(hostile, 21_000, 60_000, 2);
  assert.deepEqual(result.hits, [20_998, 20_999, 21_000]);
  assert.equal(result.allowed, false);
  for (const source of [rateLimitSource, distRateLimitSource]) {
    assert.match(source, /recent\.length < maxRetained/);
    assert.doesNotMatch(source, /values\.filter\(\(time\) => now - time < windowMs\)/);
  }
  assert.match(securityPolicy, /fixed-window hit recording must retain from the bounded tail/);
});

test("fixed-window hit recorder rejects malformed runtime values before arithmetic or accessors", () => {
  let invoked = false;
  const hostileNumber = {
    valueOf() {
      invoked = true;
      return 1;
    }
  };
  const accessorHits = [1_000];
  Object.defineProperty(accessorHits, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return 1_000;
    }
  });

  assert.deepEqual(recordFixedWindowHit("not-array" as never, 2_000, 60_000, 2), { allowed: false, hits: [] });
  assert.deepEqual(recordFixedWindowHit([], hostileNumber as never, 60_000, 2), { allowed: false, hits: [] });
  assert.deepEqual(recordFixedWindowHit([], 2_000, hostileNumber as never, 2), { allowed: false, hits: [] });
  assert.deepEqual(recordFixedWindowHit([], 2_000, 60_000, hostileNumber as never), { allowed: false, hits: [] });
  assert.deepEqual(recordFixedWindowHit([], 2_000, 60_000, 100_000), { allowed: false, hits: [] });
  assert.deepEqual(recordFixedWindowHit(accessorHits, 2_000, 60_000, 2), { allowed: false, hits: [2_000] });

  const hits = new Map<string, number[]>([["bad", accessorHits]]);
  pruneFixedWindowRateLimits(hits, 2_000, 60_000);
  assert.equal(hits.has("bad"), false);
  pruneFixedWindowRateLimits(hits, hostileNumber as never, 60_000);
  assert.equal(invoked, false);

  for (const source of [rateLimitSource, distRateLimitSource]) {
    assert.match(source, /function ownNumberArrayValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, String\(index\)\)/);
    assert.doesNotMatch(source, /values\[index\]/);
    assert.doesNotMatch(source, /values\.slice\(start\)/);
  }
  assert.match(securityPolicy, /fixed-window rate-limit helpers must reject malformed runtime values before arithmetic/);
});

test("fixed-window rate limiter pruning removes stale keys", () => {
  const hits = new Map<string, number[]>([
    ["old", [1_000]],
    ["mixed", [1_000, 61_000]]
  ]);
  pruneFixedWindowRateLimits(hits, 61_001, 60_000);
  assert.equal(hits.has("old"), false);
  assert.deepEqual(hits.get("mixed"), [61_000]);
});

test("ICE configuration limiter caps unauthenticated discovery per IP", () => {
  const hits = new Map<string, number[]>();
  for (let i = 0; i < ICE_CONFIG_MAX_REQUESTS_PER_MINUTE; i += 1) {
    assert.equal(hitIceConfigRateLimit(hits, "ip", 1_000 + i), true);
  }
  assert.equal(hitIceConfigRateLimit(hits, "ip", 2_000), false);
  assert.equal(hitIceConfigRateLimit(hits, "other-ip", 2_000), true);
});

test("TURN credential issue limiter is stricter than unauthenticated ICE discovery", () => {
  assert.ok(TURN_REST_CREDENTIALS_MAX_ISSUES_PER_MINUTE < ICE_CONFIG_MAX_REQUESTS_PER_MINUTE);
  const hits = new Map<string, number[]>();
  for (let i = 0; i < TURN_REST_CREDENTIALS_MAX_ISSUES_PER_MINUTE; i += 1) {
    assert.equal(hitTurnCredentialIssueRateLimit(hits, "ip", 1_000 + i), true);
  }
  assert.equal(hitTurnCredentialIssueRateLimit(hits, "ip", 2_000), false);
  assert.equal(hitTurnCredentialIssueRateLimit(hits, "other-ip", 2_000), true);
});
