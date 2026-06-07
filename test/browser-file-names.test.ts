import test from "node:test";
import assert from "node:assert/strict";
import {
  browserFinalCandidateName,
  browserPartCandidateName,
  browserPartName,
  isOpaqueBrowserPartName,
  MAX_BROWSER_FINAL_NAME_BYTES,
  MAX_BROWSER_OUTPUT_NAME_BYTES,
  opaqueBrowserOutputName,
  opaqueBrowserPartName,
  randomizedBrowserOutputName
} from "../src/web/file-names.js";
import fs from "node:fs";
import { assertBrowserOpaquePartFileName, assertBrowserTokenizedFileName, availableBrowserName, createAvailableBrowserFile, isNotFoundError } from "../src/web/file-system.js";

const fileSystemSource = fs.readFileSync(new URL("../src/web/file-system.ts", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("browser folder output names include a collision-resistant suffix before the extension", () => {
  assert.equal(randomizedBrowserOutputName("photo.jpg", "0123456789abcdef0123456789abcdef"), "photo (ff-0123456789abcdef0123456789abcdef).jpg");
  assert.equal(randomizedBrowserOutputName("archive", "abcdef0123456789abcdef0123456789"), "archive (ff-abcdef0123456789abcdef0123456789)");
  assert.equal(randomizedBrowserOutputName(".env", "11111111111111111111111111111111"), "_env (ff-11111111111111111111111111111111)");
  assert.match(randomizedBrowserOutputName("photo.jpg"), /^photo \(ff-[a-f0-9]{32}\)\.jpg$/);
  assert.throws(() => randomizedBrowserOutputName("photo.jpg", "short"), /token/);
  assert.throws(() => randomizedBrowserOutputName("photo.jpg", "0123456789abcdef"), /token/);
  assert.throws(() => randomizedBrowserOutputName("photo.jpg", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), /token/);
});

test("browser folder output names sanitize peer-supplied unsafe names before writing", () => {
  assert.equal(randomizedBrowserOutputName("../secret.txt", "0123456789abcdef0123456789abcdef"), "secret (ff-0123456789abcdef0123456789abcdef).txt");
  assert.equal(randomizedBrowserOutputName("CON", "0123456789abcdef0123456789abcdef"), "_CON (ff-0123456789abcdef0123456789abcdef)");
  assert.equal(randomizedBrowserOutputName("CON .txt", "0123456789abcdef0123456789abcdef"), "_CON  (ff-0123456789abcdef0123456789abcdef).txt");
  assert.equal(
    randomizedBrowserOutputName("invoice\u202ecod.exe", "0123456789abcdef0123456789abcdef"),
    "invoicecod (ff-0123456789abcdef0123456789abcdef).exe"
  );
  assert.doesNotMatch(randomizedBrowserOutputName("bad/name\u0000.txt", "0123456789abcdef0123456789abcdef"), /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
});

test("browser output and part names stay within portable filesystem byte limits", () => {
  const long = `${"a".repeat(220)}.jpg`;
  const output = randomizedBrowserOutputName(long, "0123456789abcdef0123456789abcdef");
  const part = browserPartName(output);
  assert.equal(new TextEncoder().encode(output).byteLength <= MAX_BROWSER_FINAL_NAME_BYTES, true);
  assert.equal(new TextEncoder().encode(part).byteLength <= MAX_BROWSER_OUTPUT_NAME_BYTES, true);
  assert.equal(output.includes("ff-0123456789abcdef0123456789abcdef"), true);
  assert.equal(part, `${output}.part`);
});

test("browser output trimming preserves utf-8 character boundaries", () => {
  const output = randomizedBrowserOutputName(`${"照片".repeat(80)}.jpg`, "abcdef0123456789abcdef0123456789");
  assert.equal(new TextEncoder().encode(output).byteLength <= MAX_BROWSER_FINAL_NAME_BYTES, true);
  assert.equal(output.includes("ff-abcdef0123456789abcdef0123456789"), true);
});

test("browser part names refuse final names that did not reserve suffix space", () => {
  assert.throws(() => browserPartName("x".repeat(196)), /too long/);
});

test("browser resume partial names are opaque tokenized part files", () => {
  assert.equal(opaqueBrowserPartName("0123456789abcdef0123456789abcdef"), "ff-0123456789abcdef0123456789abcdef.part");
  assert.equal(isOpaqueBrowserPartName("ff-0123456789abcdef0123456789abcdef.part"), true);
  assert.equal(isOpaqueBrowserPartName("report (ff-0123456789abcdef0123456789abcdef).txt.part"), false);
  assert.doesNotThrow(() => assertBrowserOpaquePartFileName("ff-0123456789abcdef0123456789abcdef.part"));
  assert.throws(() => opaqueBrowserPartName("short"), /token/);
  assert.throws(() => assertBrowserOpaquePartFileName("report (ff-0123456789abcdef0123456789abcdef).txt.part"), /opaque/);
});

test("browser opaque output names do not embed peer-supplied basenames", () => {
  assert.equal(opaqueBrowserOutputName("0123456789abcdef0123456789abcdef"), "ff-0123456789abcdef0123456789abcdef");
  assert.match(opaqueBrowserOutputName(), /^ff-[a-f0-9]{32}$/);
  assert.doesNotMatch(opaqueBrowserOutputName("abcdef0123456789abcdef0123456789"), /photo|jpg|secret|txt/);
  assert.throws(() => opaqueBrowserOutputName("short"), /token/);
  assert.throws(() => opaqueBrowserOutputName("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), /token/);
});

test("browser collision names stay bounded and preserve random suffixes", () => {
  const output = randomizedBrowserOutputName("a".repeat(220), "0123456789abcdef0123456789abcdef");
  const collision = browserFinalCandidateName(output, 255);
  const partCollision = browserPartCandidateName(browserPartName(collision), 255);
  assert.equal(new TextEncoder().encode(collision).byteLength <= MAX_BROWSER_FINAL_NAME_BYTES, true);
  assert.equal(new TextEncoder().encode(partCollision).byteLength <= MAX_BROWSER_OUTPUT_NAME_BYTES, true);
  assert.equal(collision.includes("ff-0123456789abcdef0123456789abcdef"), true);
  assert.equal(collision.includes("(255)"), true);
  assert.equal(partCollision.endsWith(".part"), true);
});

test("browser output name helpers reject hostile runtime values before coercion", () => {
  let invoked = false;
  const hostile = {
    toString() {
      invoked = true;
      return "safe.txt";
    },
    valueOf() {
      invoked = true;
      return 1;
    },
    get length() {
      invoked = true;
      return 8;
    },
    lastIndexOf() {
      invoked = true;
      return -1;
    }
  };

  assert.throws(() => randomizedBrowserOutputName(hostile as never, "0123456789abcdef0123456789abcdef"), /Browser output name/);
  assert.throws(() => randomizedBrowserOutputName("safe.txt", hostile as never), /Browser output token/);
  assert.throws(() => opaqueBrowserOutputName(hostile as never), /Browser output token/);
  assert.throws(() => browserPartName(hostile as never), /Browser output name/);
  assert.throws(() => browserFinalCandidateName(hostile as never, 1), /Browser output name/);
  assert.throws(() => browserPartCandidateName(hostile as never, 1), /Browser output name/);
  assert.throws(() => browserFinalCandidateName("safe.txt", hostile as never), /collision index/);
  assert.throws(() => browserPartCandidateName("safe.txt", hostile as never), /collision index/);
  assert.throws(() => browserFinalCandidateName("safe.txt", 256), /collision index/);
  assert.throws(() => browserPartCandidateName("safe.txt", -1), /collision index/);
  assert.equal(invoked, false);

  assert.match(securityPolicy, /browser output name helpers must reject non-string names, non-string random tokens, and invalid collision indexes/);
  assert.match(securityPolicy, /browser output name helpers must count UTF-8 bytes without full-buffer encoding/);
  const fileNamesSource = fs.readFileSync(new URL("../src/web/file-names.ts", import.meta.url), "utf8");
  assert.match(fileNamesSource, /function assertBrowserNameInput/);
  assert.match(fileNamesSource, /function assertCollisionIndex/);
  assert.match(fileNamesSource, /function utf8ByteLength/);
  assert.match(fileNamesSource, /charCodeAt\(index\)/);
  assert.match(fileNamesSource, /typeof token !== "string"/);
  assert.doesNotMatch(fileNamesSource, /const text = new TextEncoder\(\)/);
  assert.match(distWebBundle, /Browser output name is invalid/);
  assert.match(distWebBundle, /Browser output collision index is invalid/);
  assert.match(distWebBundle, /function [\w$]+\(e\)\{let t=0;for\(let n=0;n<e\.length;n\+=1\)/);
  assert.match(distWebBundle, /Browser output name is invalid/);
});

test("browser output helper byte counters reject oversized names without encoded-copy allocation", () => {
  const oversized = "😀".repeat(51);

  assert.throws(() => browserPartName(oversized), /too long/);
  assert.throws(() => browserFinalCandidateName(oversized, 0), /too long/);
  assert.throws(() => browserPartCandidateName(oversized, 0), /too long/);
});

test("browser file creation skips existing zero-byte tokenized names instead of overwriting them", async () => {
  const tokenized = "report (ff-0123456789abcdef0123456789abcdef).txt";
  const directory = new FakeDirectory([[tokenized, 0]]);

  assert.equal(await availableBrowserName(directory as never, tokenized, simpleCandidateName), "report (ff-0123456789abcdef0123456789abcdef) (1).txt");

  const created = await createAvailableBrowserFile(directory as never, tokenized, simpleCandidateName);
  assert.equal(created.name, "report (ff-0123456789abcdef0123456789abcdef) (1).txt");
  assert.equal(directory.created.includes("report.txt"), false);
  assert.equal(directory.created.includes("report (ff-0123456789abcdef0123456789abcdef) (1).txt"), true);
});

test("browser file creation rejects deterministic candidate names without reservation tokens", async () => {
  const directory = new FakeDirectory();

  await assert.rejects(() => createAvailableBrowserFile(directory as never, "report.txt", simpleCandidateName), /random reservation token/);
  await assert.rejects(() => createAvailableBrowserFile(directory as never, "report.txt", tokenCandidateName), /random reservation token/);
  assert.equal(directory.touched, 0);
  assert.deepEqual(directory.created, []);

  assert.match(securityPolicy, /browser folder receives must only create File System Access entries from base names and candidate names that contain a collision-resistant reservation token/);
  assert.equal(fileSystemSource.includes("const BROWSER_RESERVATION_TOKEN = /\\bff-[a-f0-9]{32}\\b/;"), true);
  assert.match(fileSystemSource, /assertBrowserReservationToken\(name\);/);
  assert.match(fileSystemSource, /assertBrowserReservationToken\(candidate\);/);
  assert.match(distWebBundle, /Browser output file names must include a random reservation token/);
});

test("browser tokenized file-name validator accepts only safe reservation-token names", () => {
  assert.doesNotThrow(() => assertBrowserTokenizedFileName("report (ff-0123456789abcdef0123456789abcdef).txt.part"));
  assert.throws(() => assertBrowserTokenizedFileName("report.txt.part"), /random reservation token/);
  assert.throws(() => assertBrowserTokenizedFileName("../report (ff-0123456789abcdef0123456789abcdef).txt.part"), /Browser output file name/);

  assert.match(fileSystemSource, /export function assertBrowserTokenizedFileName/);
  assert.match(fileSystemSource, /assertBrowserFileName\(name\);[\s\S]*assertBrowserReservationToken\(name\);/);
});

test("browser file helpers reject unsafe candidate names before touching the directory", async () => {
  for (const unsafe of [
    "../secret.txt",
    "..\\secret.txt",
    "bad:name?.txt",
    "zero\u200bwidth.txt",
    "\u0000.txt",
    "",
    "   ",
    ".",
    "..",
    ".env",
    "name. ",
    "CON",
    "CON.txt",
    "CON .txt",
    "COM1...txt",
    "LPT1.log",
    "x".repeat(MAX_BROWSER_OUTPUT_NAME_BYTES + 1)
  ]) {
    const directory = new FakeDirectory();
    const candidate = () => unsafe;
    await assert.rejects(() => availableBrowserName(directory as never, "safe.txt", candidate), /Browser output file name/);
    await assert.rejects(() => createAvailableBrowserFile(directory as never, "safe (ff-0123456789abcdef0123456789abcdef).txt", candidate), /Browser output file name/);
    assert.equal(directory.touched, 0);
    assert.deepEqual(directory.created, []);
  }
});

test("browser file helpers reject malformed base names and candidate callbacks before name generation", async () => {
  let invoked = false;
  const hostileName = {
    get length() {
      invoked = true;
      return 8;
    },
    trim() {
      invoked = true;
      return "safe.txt";
    },
    lastIndexOf() {
      invoked = true;
      return -1;
    },
    toString() {
      invoked = true;
      return "safe.txt";
    }
  };
  const candidate = () => {
    invoked = true;
    return "safe.txt";
  };

  for (const helper of [availableBrowserName, createAvailableBrowserFile]) {
    const directory = new FakeDirectory();
    await assert.rejects(() => helper(directory as never, hostileName as never, candidate), /Browser output file name/);
    await assert.rejects(() => helper(directory as never, "safe (ff-0123456789abcdef0123456789abcdef).txt", {} as never), /Browser output candidate function/);
    assert.equal(directory.touched, 0);
    assert.deepEqual(directory.created, []);
  }

  assert.equal(invoked, false);
  assert.match(securityPolicy, /browser folder candidate-name validation must reject malformed base names and malformed candidate callbacks before invoking callback-controlled name generation/);
  assert.match(fileSystemSource, /assertBrowserFileName\(name\);/);
  assert.match(fileSystemSource, /assertBrowserCandidateName\(candidateName\);/);
  assert.match(fileSystemSource, /function assertBrowserCandidateName\(candidateName: unknown\)/);
  assert.match(distWebBundle, /Browser output candidate function is invalid/);
  assert.match(distWebBundle, /for\(let \w=0;\w<256;\w\+=1\)/);
});

test("browser file helpers reject overlong candidate names without encoded-copy allocation", async () => {
  assert.match(securityPolicy, /browser folder candidate-name validation must reject malformed base names and malformed candidate callbacks/);
  assert.match(securityPolicy, /reject overlong UTF-8 names with early-exit byte counting/);
  const oversized = "😀".repeat(51);
  const candidate = () => oversized;
  const directory = new FakeDirectory();

  await assert.rejects(() => availableBrowserName(directory as never, "safe.txt", candidate), /Browser output file name/);
  await assert.rejects(() => createAvailableBrowserFile(directory as never, "safe (ff-0123456789abcdef0123456789abcdef).txt", candidate), /Browser output file name/);
  assert.equal(directory.touched, 0);
  assert.deepEqual(directory.created, []);

  assert.match(fileSystemSource, /function utf8ByteLengthExceeds/);
  assert.match(fileSystemSource, /charCodeAt\(index\)/);
  assert.doesNotMatch(fileSystemSource, /const text = new TextEncoder\(\)/);
  assert.doesNotMatch(fileSystemSource, /text\.encode\(name\)\.byteLength/);
  assert.match(distWebBundle, /function [\w$]+\(e,t\)\{let n=0;for\(let r=0;r<e\.length;r\+=1\)/);
  assert.match(distWebBundle, /Browser output file name is invalid/);
});

test("browser not-found classifier uses native DOMException name without hostile getters", () => {
  assert.equal(isNotFoundError(new DOMException("missing", "NotFoundError")), true);
  assert.equal(isNotFoundError(new DOMException("invalid", "InvalidStateError")), false);
  assert.equal(isNotFoundError({ name: "NotFoundError" }), false);

  let getterCalled = false;
  class HostileNotFound extends DOMException {
    override get name(): string {
      getterCalled = true;
      return "NotFoundError";
    }
  }

  assert.equal(isNotFoundError(new HostileNotFound("invalid", "InvalidStateError")), false);
  assert.equal(getterCalled, false);
  assert.match(securityPolicy, /browser filesystem not-found classifiers must read DOMException names through the native prototype getter/);
  assert.match(fileSystemSource, /Object\.getOwnPropertyDescriptor\(DOMException\.prototype, "name"\)/);
  assert.match(fileSystemSource, /function isWindowsReservedName/);
  assert.match(fileSystemSource, /charCodeAt\(index\) === 46/);
  assert.doesNotMatch(fileSystemSource, /\.split\("\."\)/);
  assert.doesNotMatch(fileSystemSource, /error\.name === "NotFoundError"/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(DOMException\.prototype,`name`\)/);
  assert.match(distWebBundle, /function [\w$]+\(e\)\{let t=e\.length;for\(let n=0;n<e\.length;n\+=1\)if\(e\.charCodeAt\(n\)===46\)/);
  assert.doesNotMatch(distWebBundle, /function [\w$]+\(e\)\{let t=e\.split\(`\.`\)\[0\]\?\.replace/);
  assert.doesNotMatch(distWebBundle, /e\.name===`NotFoundError`/);
});

function simpleCandidateName(name: string, index: number): string {
  if (index === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`;
}

function tokenCandidateName(_name: string, index: number): string {
  const tokenized = "report (ff-0123456789abcdef0123456789abcdef).txt";
  return simpleCandidateName(tokenized, index);
}

class FakeDirectory {
  readonly files = new Map<string, FakeFileHandle>();
  readonly created: string[] = [];
  touched = 0;

  constructor(entries: [string, number][] = []) {
    for (const [name, size] of entries) this.files.set(name, new FakeFileHandle(size));
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    this.touched += 1;
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("not found", "NotFoundError");
    const created = new FakeFileHandle(0);
    this.files.set(name, created);
    this.created.push(name);
    return created;
  }
}

class FakeFileHandle {
  constructor(private readonly size: number) {}

  async getFile(): Promise<{ size: number }> {
    return { size: this.size };
  }
}

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
