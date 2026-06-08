import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("receivers restore the code on invalid encrypted pair requests before acceptance", () => {
  for (const source of [cliSource, webSource]) {
    assert.match(source, /openManifest<FileManifest>\(keys, request\.sealedManifest\)[\s\S]*catch \(error\)[\s\S]*reason: "prepair_retry"/);
    assert.match(source, /assertTransferManifestWithinLimits\(manifest\)[\s\S]*catch \(error\)[\s\S]*reason: "prepair_retry"/);
  }
});

test("receivers treat malformed PAKE payloads as pre-pair retry attempts", () => {
  assert.match(securityPolicy, /malformed PAKE payload or invalid sender flow before pair acceptance must expire the receiver code instead of allowing another online guess/);
  for (const source of [cliSource, webSource]) {
    assert.match(source, /function isPrePairRetryable[\s\S]*invalid PAKE/);
  }
});
