import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sanitizeDisplayText, sanitizeStructuredOutput } from "../src/shared/output-safety.js";
import { sanitizeStructuredOutput as distSanitizeStructuredOutput } from "../dist-node/shared/output-safety.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const outputSafetySource = fs.readFileSync(path.join(root, "src/shared/output-safety.ts"), "utf8");
const distOutputSafetySource = fs.readFileSync(path.join(root, "dist-node/shared/output-safety.js"), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(path.join(root, "SECURITY.md"), "utf8");

test("display text strips terminal controls and bidi overrides", () => {
  assert.equal(sanitizeDisplayText("safe\u001b[31m\u202etxt"), "safe [31m txt");
  assert.equal(sanitizeDisplayText("zero\u200bwidth"), "zero width");
  assert.equal(sanitizeDisplayText("\u0000\u202e"), "");
});

test("display text is capped before regex sanitization", () => {
  const unsafe = `${"a".repeat(4096)}\u202e${"b".repeat(4096)}`;
  assert.equal(sanitizeDisplayText(unsafe), `${"a".repeat(4096)}[Truncated]`);
  assert.match(outputSafetySource, /MAX_DISPLAY_TEXT_CHARS = 4096/);
  assert.match(outputSafetySource, /typeof value !== "string"[\s\S]*value\.length > MAX_DISPLAY_TEXT_CHARS[\s\S]*value\.slice\(0, MAX_DISPLAY_TEXT_CHARS\)/);
  assert.match(distOutputSafetySource, /MAX_DISPLAY_TEXT_CHARS = 4096/);
  assert.match(distOutputSafetySource, /typeof value !== "string"[\s\S]*value\.length > MAX_DISPLAY_TEXT_CHARS[\s\S]*value\.slice\(0, MAX_DISPLAY_TEXT_CHARS\)/);
  assert.match(distWebBundle, /4096/);
  assert.match(distWebBundle, /function [\w$]+\(e\)\{return typeof e==`string`\?\(e\.length>\w+\?/);
  assert.match(securityPolicy, /display text sanitization must cap raw strings before regex replacement/);
});

test("display text sanitizer rejects non-string runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 4;
    },
    get replace() {
      coerced = true;
      return () => "pwned";
    },
    toString() {
      coerced = true;
      return "pwned";
    }
  };

  assert.equal(sanitizeDisplayText(hostile as never), "[Truncated]");
  assert.equal(coerced, false);
  assert.match(securityPolicy, /display text sanitization must reject non-string runtime values before length, slice, replacement, or trim processing/);
});

test("structured output recursively sanitizes peer-controlled strings", () => {
  assert.deepEqual(
    sanitizeStructuredOutput({
      event: "pair_request",
      files: [{ name: "invoice\u202egnp.exe", size: 1 }],
      nested: ["ok\u0007", "zero\u200bwidth"]
    }),
    {
      event: "pair_request",
      files: [{ name: "invoice gnp.exe", size: 1 }],
      nested: ["ok", "zero width"]
    }
  );
});

test("structured output treats prototype setter names as data", () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":"ok\\u0007"}') as Record<string, unknown>;
  const sanitized = sanitizeStructuredOutput(parsed) as Record<string, unknown>;

  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "__proto__"), true);
  assert.deepEqual(sanitized.__proto__, { polluted: "yes" });
  assert.equal(sanitized.safe, "ok");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("structured output sanitizes control characters in object keys", () => {
  const sanitized = sanitizeStructuredOutput({
    "bad\u202ekey": "value\u0007",
    "\u0000": "empty-key",
    _: "existing"
  }) as Record<string, unknown>;

  assert.deepEqual(sanitized, {
    "bad key": "value",
    _: "empty-key",
    __1: "existing"
  });
  assert.equal(JSON.stringify(sanitized).includes("\u202e"), false);
  assert.equal(JSON.stringify(sanitized).includes("\u0000"), false);
});

test("structured output handles collision-heavy sanitized keys with counters", () => {
  const collisionHeavy: Record<string, unknown> = {};
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index === 31 ? 127 : index + 1));
  for (let index = 0; index < 96; index += 1) {
    collisionHeavy[`bad${controls[index % controls.length]}${controls[Math.floor(index / controls.length)]}key`] = index;
  }

  const sanitized = sanitizeStructuredOutput(collisionHeavy) as Record<string, unknown>;

  assert.equal(sanitized["bad key"], 0);
  assert.equal(sanitized["bad key_1"], 1);
  assert.equal(sanitized["bad key_95"], 95);
  assert.equal(Object.keys(sanitized).length, 96);
});

test("structured output only marks actual cycles as circular", () => {
  const shared = { name: "shared\u0007" };
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.deepEqual(sanitizeStructuredOutput({ first: shared, second: shared, circular }), {
    first: { name: "shared" },
    second: { name: "shared" },
    circular: { self: "[Circular]" }
  });
});

test("structured output only recurses into plain records", () => {
  class PeerControlled {
    value = "safe\u0007";
  }
  const instance = new PeerControlled();
  const sanitized = sanitizeStructuredOutput({ instance, plain: { value: "safe\u0007" } });

  assert.equal(sanitized.instance, "[Truncated]");
  assert.deepEqual(sanitized.plain, { value: "safe" });
});

test("structured output shadows inherited toJSON hooks before final stringify", () => {
  let objectToJsonCalled = false;
  let arrayToJsonCalled = false;
  const originalObjectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");

  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        objectToJsonCalled = true;
        return { pwned: true };
      }
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value() {
        arrayToJsonCalled = true;
        return ["pwned"];
      }
    });

    const sanitized = sanitizeStructuredOutput({ event: "ok\u0007", values: ["safe\u0007"] });
    assert.equal(JSON.stringify(sanitized), '{"event":"ok","values":["safe"]}');
    assert.equal(objectToJsonCalled, false);
    assert.equal(arrayToJsonCalled, false);
  } finally {
    if (originalObjectToJson) Object.defineProperty(Object.prototype, "toJSON", originalObjectToJson);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (originalArrayToJson) Object.defineProperty(Array.prototype, "toJSON", originalArrayToJson);
    else delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
});

test("structured output truncates non-plain objects so stringify cannot invoke getters", () => {
  let getterCalled = false;
  class HostileInstance {
    get secret() {
      getterCalled = true;
      return "pwned";
    }
  }

  const sanitized = sanitizeStructuredOutput({ instance: new HostileInstance() });
  assert.equal(JSON.stringify(sanitized), '{"instance":"[Truncated]"}');
  assert.equal(getterCalled, false);
});

test("structured output does not invoke accessors while sanitizing JSON-mode events", () => {
  let recordGetterCalled = false;
  const accessorRecord: Record<string, unknown> = { safe: "ok\u0007" };
  Object.defineProperty(accessorRecord, "secret", {
    enumerable: true,
    get() {
      recordGetterCalled = true;
      return "pwned\u202e";
    }
  });

  let arrayGetterCalled = false;
  const accessorArray = ["ok\u0007"];
  Object.defineProperty(accessorArray, "1", {
    enumerable: true,
    get() {
      arrayGetterCalled = true;
      return "pwned\u202e";
    }
  });

  assert.deepEqual(sanitizeStructuredOutput({ accessorRecord, accessorArray }), {
    accessorRecord: { safe: "ok", secret: "[Truncated]" },
    accessorArray: ["ok", "[Truncated]"]
  });
  assert.equal(recordGetterCalled, false);
  assert.equal(arrayGetterCalled, false);
});

test("structured output removes JSON stringify hooks and non-json values", () => {
  let ownToJsonCalled = false;
  const ownHook = {
    toJSON() {
      ownToJsonCalled = true;
      return { pwned: true };
    },
    value: "safe\u0007"
  };

  let inheritedToJsonCalled = false;
  class WithToJson {
    value = "safe\u0007";
    toJSON() {
      inheritedToJsonCalled = true;
      return { pwned: true };
    }
  }

  let toJsonGetterCalled = false;
  const accessorToJson = { value: "safe\u0007" };
  Object.defineProperty(accessorToJson, "toJSON", {
    enumerable: true,
    get() {
      toJsonGetterCalled = true;
      return () => ({ pwned: true });
    }
  });

  const sanitized = sanitizeStructuredOutput({
    ownHook,
    inheritedHook: new WithToJson(),
    accessorToJson,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    callback: () => "pwned",
    bigint: 1n,
    symbol: Symbol("pwned")
  }) as Record<string, unknown>;
  assert.doesNotThrow(() => JSON.stringify(sanitized));
  assert.equal(JSON.stringify(sanitized), JSON.stringify({
    ownHook: { toJSON: "[Truncated]", value: "safe" },
    inheritedHook: "[Truncated]",
    accessorToJson: { value: "safe", toJSON: "[Truncated]" },
    nan: "[Truncated]",
    infinity: "[Truncated]",
    negativeInfinity: "[Truncated]",
    callback: "[Truncated]",
    bigint: "[Truncated]",
    symbol: "[Truncated]"
  }));
  assert.equal(ownToJsonCalled, false);
  assert.equal(inheritedToJsonCalled, false);
  assert.equal(toJsonGetterCalled, false);
});

test("structured output does not let non-finite numbers stringify as null", () => {
  const sanitized = sanitizeStructuredOutput({ nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, ok: 1 });
  const distSanitized = distSanitizeStructuredOutput({ nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, ok: 1 });

  assert.deepEqual(sanitized, { nan: "[Truncated]", infinity: "[Truncated]", ok: 1 });
  assert.deepEqual(distSanitized, { nan: "[Truncated]", infinity: "[Truncated]", ok: 1 });
  assert.equal(JSON.stringify(sanitized), '{"nan":"[Truncated]","infinity":"[Truncated]","ok":1}');
});

test("structured output handles circular references without throwing", () => {
  const event: Record<string, unknown> = { event: "pair_request", name: "safe\u0007" };
  event.self = event;

  assert.deepEqual(sanitizeStructuredOutput(event), {
    event: "pair_request",
    name: "safe",
    self: "[Circular]"
  });
});

test("structured output truncates hostile depth and node counts", () => {
  let deep: Record<string, unknown> = { leaf: "safe\u0007" };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };

  let cursor = sanitizeStructuredOutput(deep) as Record<string, unknown>;
  for (let i = 0; i < 32; i += 1) {
    if (cursor.child === "[Truncated]") break;
    cursor = cursor.child as Record<string, unknown>;
  }
  assert.equal(cursor.child, "[Truncated]");

  const wide = Array.from({ length: 10_100 }, (_, index) => ({ index, value: "safe\u0007" }));
  const sanitizedWide = sanitizeStructuredOutput(wide);
  assert.equal(sanitizedWide.at(-1), "[Truncated]");
  assert.equal(sanitizedWide.length < wide.length, true);
  assert.equal(sanitizedWide.length <= 10_001, true);

  const primitiveWide = Array.from({ length: 20_000 }, (_, index) => index);
  const sanitizedPrimitiveWide = sanitizeStructuredOutput(primitiveWide);
  assert.equal(sanitizedPrimitiveWide.at(-1), "[Truncated]");
  assert.equal(sanitizedPrimitiveWide.length < primitiveWide.length, true);

  const manyPrimitiveProps = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`k${index}`, index]));
  const sanitizedManyPrimitiveProps = sanitizeStructuredOutput(manyPrimitiveProps) as Record<string, unknown>;
  assert.equal(sanitizedManyPrimitiveProps.truncated, "[Truncated]");
  assert.equal(Object.keys(sanitizedManyPrimitiveProps).length < Object.keys(manyPrimitiveProps).length, true);
});

test("structured output sanitizer keeps explicit cycle and size bounds", () => {
  for (const source of [outputSafetySource, distOutputSafetySource]) {
    assert.match(source, /MAX_STRUCTURED_OUTPUT_DEPTH/);
    assert.match(source, /MAX_STRUCTURED_OUTPUT_NODES/);
    assert.match(source, /WeakSet/);
    assert.match(source, /sanitizeStructuredArray/);
    assert.match(source, /sanitizeStructuredRecord/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, String\(index\)\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptors\(value\)/);
    assert.match(source, /shadowJsonStringifyHook/);
    assert.match(source, /if \(!recurse\)[\s\S]*return TRUNCATED_OUTPUT_VALUE/);
    assert.match(source, /typeof value === "number" && !Number\.isFinite\(value\)/);
    assert.match(source, /typeof value === "bigint" \|\| typeof value === "function" \|\| typeof value === "symbol"/);
    assert.doesNotMatch(source, /\.map\(\(item\) => sanitizeStructuredValue/);
    assert.doesNotMatch(source, /Object\.entries\(value\)/);
    assert.doesNotMatch(source, /hasJsonStringifyHook/);
    assert.match(source, /const keyCounts = new Map/);
    assert.match(source, /keyCounts\.get\(base\)/);
    assert.match(source, /keyCounts\.set\(base, index \+ 1\)/);
    assert.match(source, /safeOutputKey/);
    assert.match(source, /context\.seen\.delete\(value\)/);
    assert.match(source, /CIRCULAR_OUTPUT_VALUE/);
    assert.match(source, /TRUNCATED_OUTPUT_VALUE/);
  }
  assert.match(securityPolicy, /CLI JSON output sanitization must sanitize object keys with per-record collision counters/);
  assert.match(securityPolicy, /CLI JSON output sanitization must walk arrays and records through property descriptors/);
  assert.match(securityPolicy, /CLI JSON output sanitization must remove JSON stringify hooks, shadow inherited `toJSON`/);
});

function readDistWebBundle(): string {
  const assetsDir = path.join(root, "dist-web/assets");
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(path.join(assetsDir, bundleNames[0]!), "utf8");
}
