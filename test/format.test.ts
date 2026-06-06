import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, formatBytes, formatRate } from "../src/shared/format.js";

const formatSource = fs.readFileSync(new URL("../src/shared/format.ts", import.meta.url), "utf8");
const distFormatSource = fs.readFileSync(new URL("../dist-node/shared/format.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("byte and rate formatting stays stable for normal progress values", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatRate(2048), "2.0 KB/s");
});

test("byte and rate formatting reject invalid runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    valueOf() {
      coerced = true;
      return 1024;
    }
  };

  assert.throws(() => formatBytes(hostile as never), /Byte count is invalid/);
  assert.throws(() => formatRate(hostile as never), /Byte count is invalid/);
  assert.throws(() => formatBytes(Number.NaN), /Byte count is invalid/);
  assert.throws(() => formatBytes(Number.POSITIVE_INFINITY), /Byte count is invalid/);
  assert.throws(() => formatBytes(-1), /Byte count is invalid/);
  assert.equal(coerced, false);
  assert.match(securityPolicy, /byte and rate formatters must reject non-finite, negative, and non-number runtime values before numeric coercion/);
  for (const source of [formatSource, distFormatSource]) {
    assert.match(source, /typeof bytes !== "number" \|\| !Number\.isFinite\(bytes\) \|\| bytes < 0/);
  }
});

test("basename extracts leaves without splitting unbounded path strings", () => {
  assert.equal(basename("/tmp/file.txt"), "file.txt");
  assert.equal(basename("C:\\tmp\\file.txt"), "file.txt");
  assert.equal(basename("/tmp/file.txt/"), "file.txt");
  assert.equal(basename("////"), "////");
  assert.equal(basename(`${"a/".repeat(5000)}keep.txt`), "keep.txt");
  assert.equal(basename(`${"x".repeat(5000)}.txt`).endsWith(".txt"), true);
  assert.match(securityPolicy, /exported basename helpers must extract leaves with a bounded reverse scan/);
  assert.match(securityPolicy, /exported basename helpers must reject non-string runtime values before length, character, or slice processing/);
  for (const source of [formatSource, distFormatSource]) {
    assert.match(source, /typeof path !== "string"/);
    assert.match(source, /MAX_BASENAME_INPUT_CHARS = 4096/);
    assert.match(source, /for \(let index = end - 1; index >= min; index -= 1\)/);
    assert.doesNotMatch(source, /filter\(Boolean\)\.at\(-1\)/);
  }
});

test("basename rejects non-string runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 8;
    },
    charCodeAt() {
      coerced = true;
      return 47;
    },
    toString() {
      coerced = true;
      return "/tmp/file.txt";
    }
  };

  assert.throws(() => basename(hostile as never), /Path must be a string/);
  assert.equal(coerced, false);
});
