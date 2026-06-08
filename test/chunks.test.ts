import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { CHUNK_SIZE, MAX_FILE_BYTES, MAX_FILE_NAME_CHARS, MAX_FILES_PER_SESSION, MAX_MIME_CHARS, MAX_OUTPUT_NAME_ATTEMPTS, PROTOCOL_VERSION } from "../src/shared/constants.js";
import { decodeChunk, encodeChunk } from "../src/shared/chunks.js";
import { assertManifestWithinLimits, assertTransferManifestWithinLimits, safeCollisionFileName, safeFileName, SAFE_FILE_NAME_BYTES } from "../src/shared/limits.js";
import {
  assertManifestWithinLimits as distAssertManifestWithinLimits,
  assertTransferManifestWithinLimits as distAssertTransferManifestWithinLimits,
  safeCollisionFileName as distSafeCollisionFileName
} from "../dist-node/shared/limits.js";
import { isClientMessage, isServerMessage, parseJsonMessage, serializeMessage } from "../src/shared/messages.js";
import { abortControlMessage, assertControlMessage, assertSenderControlMessage, assertTransferManifestMatchesAccepted, remoteAbortError, MAX_ABORT_REASON_CHARS, REMOTE_ABORT_MESSAGE } from "../src/shared/transfer.js";
import { assertControlMessage as distAssertControlMessage, assertSenderControlMessage as distAssertSenderControlMessage, assertTransferManifestMatchesAccepted as distAssertTransferManifestMatchesAccepted } from "../dist-node/shared/transfer.js";
import { generateCode, GENERATED_RENDEZVOUS_DIGITS, isValidCode, isValidRendezvous, MAX_CODE_INPUT_BYTES, normalizeCode, parseCode, RENDEZVOUS_DIGITS } from "../src/shared/wordlist.js";

const vectorsSource = fs.readFileSync(new URL("../conformance/protocol-v10.json", import.meta.url), "utf8");
const vectors = JSON.parse(vectorsSource) as {
  protocolVersion: number;
  chunkFrames: { fileId: number; chunkSeq: number; payloadHex: string; frameHex: string }[];
  controlMessages: { name: string; message: unknown; senderControl?: boolean }[];
  signalingMessages: { name: string; direction: "client" | "server"; message: unknown; json: string }[];
};
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const transferSource = fs.readFileSync(new URL("../src/shared/transfer.ts", import.meta.url), "utf8");
const distTransferSource = fs.readFileSync(new URL("../dist-node/shared/transfer.js", import.meta.url), "utf8");
const limitsSource = fs.readFileSync(new URL("../src/shared/limits.ts", import.meta.url), "utf8");
const distLimitsSource = fs.readFileSync(new URL("../dist-node/shared/limits.js", import.meta.url), "utf8");
const transferCodeSource = fs.readFileSync(new URL("../src/shared/wordlist.ts", import.meta.url), "utf8");
const distTransferCodeSource = fs.readFileSync(new URL("../dist-node/shared/wordlist.js", import.meta.url), "utf8");
const chunksSource = fs.readFileSync(new URL("../src/shared/chunks.ts", import.meta.url), "utf8");
const distChunksSource = fs.readFileSync(new URL("../dist-node/shared/chunks.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("conformance fixture protocol version matches runtime", () => {
  assert.equal(vectors.protocolVersion, PROTOCOL_VERSION);
  assert.match(securityPolicy, /wire-incompatible changes must bump `PROTOCOL_VERSION`/);
});

test("conformance fixture does not contain duplicate JSON object keys", () => {
  assertNoDuplicateJsonObjectKeys(vectorsSource, "conformance/protocol-v10.json");
});

test("chunk framing round-trips file id, sequence, and payload", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const decoded = decodeChunk(encodeChunk(7, 42, payload));
  assert.equal(decoded.fileId, 7);
  assert.equal(decoded.chunkSeq, 42);
  assert.deepEqual(decoded.payload, payload);
});

test("chunk framing matches the wire-format conformance vectors", () => {
  assert.equal(vectors.chunkFrames.length >= 2, true);
  assert.equal(vectors.chunkFrames.some((vector) => vector.fileId === 255 && vector.chunkSeq === 0xffffffff && vector.payloadHex === ""), true);
  for (const vector of vectors.chunkFrames) {
    const payload = Buffer.from(vector.payloadHex, "hex");
    const encoded = Buffer.from(encodeChunk(vector.fileId, vector.chunkSeq, payload));
    assert.equal(encoded.toString("hex"), vector.frameHex);
    const decoded = decodeChunk(encoded);
    assert.equal(decoded.fileId, vector.fileId);
    assert.equal(decoded.chunkSeq, vector.chunkSeq);
    assert.deepEqual([...decoded.payload], [...payload]);
  }
});

test("control-message conformance vectors cover the transfer state machine", () => {
  const controlTypes = new Set<string>();
  const senderControlTypes = new Set<string>();
  for (const vector of vectors.controlMessages) {
    const parsed = assertControlMessage(vector.message);
    controlTypes.add(parsed.t);
    assert.deepEqual(parsed, vector.message, vector.name);
    if (vector.senderControl) {
      senderControlTypes.add(assertSenderControlMessage(parsed).t);
    } else {
      assert.throws(() => assertSenderControlMessage(parsed), /Unexpected sender control message/, vector.name);
    }
  }

  assert.deepEqual([...controlTypes].sort(), ["abort", "all-done", "all-done-ok", "file-begin", "file-end", "file-ok", "manifest", "ready", "restart"]);
  assert.deepEqual([...senderControlTypes].sort(), ["abort", "all-done-ok", "file-ok", "ready"]);
});

test("signaling-message conformance vectors validate schema and canonical serialization", () => {
  assert.equal(vectors.signalingMessages.length >= 4, true);
  assert.equal(
    vectors.signalingMessages.some((vector) => {
      const message = vector.message as { type?: unknown; reason?: unknown };
      return message.type === "pair-reject" && message.reason === "user_declined";
    }),
    true
  );
  for (const vector of vectors.signalingMessages) {
    assert.equal(vector.direction === "client" ? isClientMessage(vector.message) : isServerMessage(vector.message), true, vector.name);
    assert.equal(serializeMessage(vector.message as never), vector.json, vector.name);
    assert.deepEqual(parseJsonMessage(vector.json), vector.message, vector.name);
  }
});

test("pair-request conformance vector exposes only redacted public manifest metadata", () => {
  const pairRequest = vectors.signalingMessages.find((vector) => vector.name === "sender pair request")?.message as
    | { type?: unknown; manifest?: unknown }
    | undefined;
  assert.equal(pairRequest?.type, "pair-request");
  assert.deepEqual(pairRequest.manifest, {
    files: Array.from({ length: MAX_FILES_PER_SESSION }, (_, id) => ({ id, name: `encrypted-${id}`, size: MAX_FILE_BYTES })),
    fileCount: MAX_FILES_PER_SESSION,
    totalBytes: MAX_FILE_BYTES * MAX_FILES_PER_SESSION
  });
  assert.doesNotMatch(JSON.stringify(pairRequest.manifest), /photo\.jpg|image\/jpeg/);
});

test("chunk framing rejects malformed lengths and oversized payloads", () => {
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 1, false);
  view.setUint32(5, 99, false);
  assert.throws(() => decodeChunk(frame), /length mismatch/);
  assert.doesNotThrow(() => encodeChunk(1, 1, new Uint8Array(CHUNK_SIZE + 16)));
  assert.throws(() => encodeChunk(1, 1, new Uint8Array(CHUNK_SIZE + 17)), /exceeds/);
  assert.throws(() => encodeChunk(1.5, 1, new Uint8Array()), /fileId/);
  assert.throws(() => encodeChunk(1, 0x1_0000_0000, new Uint8Array()), /chunkSeq/);

  const oversized = new Uint8Array(9 + CHUNK_SIZE + 17);
  const oversizedView = new DataView(oversized.buffer);
  oversizedView.setUint8(0, 1);
  oversizedView.setUint32(1, 1, false);
  oversizedView.setUint32(5, CHUNK_SIZE + 17, false);
  assert.throws(() => decodeChunk(oversized), /exceeds/);
});

test("chunk framing rejects non-binary runtime inputs before coercion or allocation", () => {
  let lengthGetterCalled = false;
  const fakeFrame = {};
  Object.defineProperty(fakeFrame, "length", {
    enumerable: true,
    get() {
      lengthGetterCalled = true;
      return 9;
    }
  });
  assert.throws(() => decodeChunk(fakeFrame as never), /ArrayBuffer or Uint8Array/);
  assert.equal(lengthGetterCalled, false);

  let byteLengthGetterCalled = false;
  const fakePayload = {};
  Object.defineProperty(fakePayload, "byteLength", {
    enumerable: true,
    get() {
      byteLengthGetterCalled = true;
      return 1;
    }
  });
  assert.throws(() => encodeChunk(1, 1, fakePayload as never), /Uint8Array/);
  assert.equal(byteLengthGetterCalled, false);

  let typedArrayGetterCalled = false;
  class HostilePayload extends Uint8Array {
    override get byteLength() {
      typedArrayGetterCalled = true;
      return 1;
    }
  }
  const hostilePayload = new HostilePayload(1);
  assert.throws(() => encodeChunk(1, 1, hostilePayload), /Uint8Array/);
  assert.throws(() => decodeChunk(hostilePayload), /Uint8Array/);
  assert.equal(typedArrayGetterCalled, false);

  class HostileFrame extends ArrayBuffer {}
  assert.throws(() => decodeChunk(new HostileFrame(9)), /ArrayBuffer or Uint8Array/);

  const dataView = new DataView(new ArrayBuffer(9));
  assert.throws(() => decodeChunk(dataView as never), /ArrayBuffer or Uint8Array/);
  assert.throws(() => encodeChunk(1, 1, dataView as never), /Uint8Array/);
});

test("chunk framing helper validates exact binary types in checked artifacts", () => {
  assert.match(securityPolicy, /chunk framing helpers must reject non-canonical binary values and non-binary runtime values before typed-array coercion or byte-length reads/);
  for (const source of [chunksSource, distChunksSource]) {
    assert.match(source, /must be a Uint8Array/);
    assert.match(source, /function assertUint8Array/);
    assert.match(source, /function chunkFrameBytes/);
    assert.match(source, /function isCanonicalBinaryPrototype/);
    assert.match(source, /prototype === Uint8Array\.prototype/);
    assert.match(source, /prototype === Buffer\.prototype/);
    assert.match(source, /Object\.getPrototypeOf\(input\) === ArrayBuffer\.prototype/);
    assert.match(source, /chunk frame must be an ArrayBuffer or Uint8Array/);
    assert.doesNotMatch(source, /input instanceof ArrayBuffer \? new Uint8Array\(input\)/);
  }
  assert.match(distWebBundle, /Uint8Array\.prototype/);
  assert.match(distWebBundle, /`payload`\)/);
  assert.match(distWebBundle, /e instanceof ArrayBuffer&&Object\.getPrototypeOf\(e\)===ArrayBuffer\.prototype\?new Uint8Array\(e\)/);
  assert.match(distWebBundle, /must be a Uint8Array/);
  assert.match(distWebBundle, /chunk frame must be an ArrayBuffer or Uint8Array/);
});

test("receiver-side limits reject inconsistent manifests", () => {
  assert.match(securityPolicy, /accepted manifest filenames must already be portable output-safe/);
  assert.throws(() => assertManifestWithinLimits(null as never), /Manifest is invalid/);
  assert.throws(() => assertManifestWithinLimits([] as never), /Manifest is invalid/);
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: null } as never), /file list/);
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [null] } as never), /file entry/);
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [new Date()] } as never), /file entry/);
  const sparseManifestFiles: unknown[] = [];
  sparseManifestFiles.length = 1;
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 0, files: sparseManifestFiles } as never), /file entry/);
  const accessorManifestFiles = [{ name: "x.txt", size: 1 }];
  Object.defineProperty(accessorManifestFiles, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: accessorManifestFiles } as never), /file entry/);
  const accessorManifestEntry = {};
  Object.defineProperty(accessorManifestEntry, "name", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [accessorManifestEntry] } as never), /file entry/);
  let symbolManifestReads = 0;
  const symbolAccessorManifest = { fileCount: 1, totalBytes: 1, files: [{ name: "a.txt", size: 1 }] };
  Object.defineProperty(symbolAccessorManifest, Symbol("hidden"), {
    enumerable: true,
    get() {
      symbolManifestReads += 1;
      return true;
    }
  });
  assert.throws(() => assertManifestWithinLimits(symbolAccessorManifest as never), /Manifest is invalid/);
  assert.throws(() => distAssertManifestWithinLimits(symbolAccessorManifest as never), /Manifest is invalid/);
  assert.equal(symbolManifestReads, 0);
  const symbolAccessorManifestEntry = { name: "a.txt", size: 1 };
  Object.defineProperty(symbolAccessorManifestEntry, Symbol("hidden"), {
    enumerable: true,
    get() {
      symbolManifestReads += 1;
      return true;
    }
  });
  assert.throws(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [symbolAccessorManifestEntry] } as never), /file entry/);
  assert.throws(() => distAssertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [symbolAccessorManifestEntry] } as never), /file entry/);
  assert.equal(symbolManifestReads, 0);
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 99, files: [{ name: "a.txt", size: 1 }] }),
    /total size/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "a.txt", size: 1 }], extra: true } as never),
    /Manifest is invalid/
  );
  assert.throws(
    () => distAssertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "a.txt", size: 1 }], extra: true } as never),
    /Manifest is invalid/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "a.txt", size: 1, extra: true }] } as never),
    /file entry/
  );
  assert.throws(
    () => distAssertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "a.txt", size: 1, extra: true }] } as never),
    /file entry/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 101, totalBytes: 101, files: Array.from({ length: 101 }, (_, index) => ({ name: `${index}.txt`, size: 1 })) }),
    /File count/
  );
  assert.throws(
    () =>
      assertManifestWithinLimits({
        fileCount: 2,
        totalBytes: 2,
        files: [
          { id: 0, name: "a.txt", size: 1 },
          { id: 0, name: "b.txt", size: 1 }
        ]
      }),
    /Duplicate file id/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "x".repeat(MAX_FILE_NAME_CHARS + 1), size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "../secret.txt", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "..\\secret.txt", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "report\u202egnp.exe", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "zero\u200bwidth.txt", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "\u0000", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "   ", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: ".", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "bad:name?.txt", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: ".env", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "CON.txt", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "name. ", size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: `${"a".repeat(240)}.txt`, size: 1 }] }),
    /File name/
  );
  assert.throws(
    () => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "x.txt", size: 1, mime: "x".repeat(MAX_MIME_CHARS + 1) }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain\nbad" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain; charset=utf-8" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain;charset=utf-8" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/" }] }),
    /MIME/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain\u200b" }] }),
    /MIME/
  );
  assert.doesNotThrow(() => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "image/svg+xml" }] }));
  assert.doesNotThrow(() => assertManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "public.txt", size: 1 }] }));
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ name: "missing-id.txt", size: 1 }] }),
    /file id is required/
  );
  assert.throws(
    () => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 7, name: "sparse-id.txt", size: 1 }] }),
    /canonical and sequential/
  );
  let iteratorInvoked = false;
  const iterableTransferFiles = [{ id: 0, name: "x.txt", size: 1 }];
  Object.defineProperty(iterableTransferFiles, Symbol.iterator, {
    get() {
      iteratorInvoked = true;
      throw new Error("iterator should not run");
    }
  });
  assert.doesNotThrow(() => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: iterableTransferFiles }));
  assert.equal(iteratorInvoked, false);
  assert.throws(
    () =>
      assertTransferManifestWithinLimits({
        fileCount: 2,
        totalBytes: 2,
        files: [
          { id: 1, name: "a.txt", size: 1 },
          { id: 0, name: "b.txt", size: 1 }
        ]
      }),
    /canonical and sequential/
  );
  assert.doesNotThrow(() => assertTransferManifestWithinLimits({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "ready.txt", size: 1 }] }));
  for (const source of [limitsSource, distLimitsSource]) {
    assert.match(source, /function ownArrayDataValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.doesNotMatch(source, /manifest\.files\.entries\(\)/);
  }
  assert.match(distWebBundle, /Manifest is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
});

test("control manifest parsing rejects sparse and accessor-backed file arrays", () => {
  assert.match(securityPolicy, /schema allowed-key checks must reject non-enumerable and symbol properties/);
  const sparseFiles: unknown[] = [];
  sparseFiles.length = 1;
  assert.throws(() => assertControlMessage({ t: "manifest", files: sparseFiles, totalBytes: 0 } as never), /manifest file entry/i);
  const accessorFiles = [{ id: 0, name: "x.txt", size: 1 }];
  Object.defineProperty(accessorFiles, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => assertControlMessage({ t: "manifest", files: accessorFiles, totalBytes: 1 } as never), /manifest file entry/i);
  const accessorFile = {};
  Object.defineProperty(accessorFile, "id", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => assertControlMessage({ t: "manifest", files: [accessorFile], totalBytes: 1 } as never), /manifest file entry/i);

  const hiddenExtraReady = { t: "ready", id: 0 };
  Object.defineProperty(hiddenExtraReady, "extra", { enumerable: false, value: true });
  assert.throws(() => assertControlMessage(hiddenExtraReady), /control message/i);
  const hiddenRequiredDone = {};
  Object.defineProperty(hiddenRequiredDone, "t", { enumerable: false, value: "all-done" });
  assert.throws(() => assertControlMessage(hiddenRequiredDone), /control message/i);
  const symbolExtraDone = { t: "all-done" };
  Object.defineProperty(symbolExtraDone, Symbol("extra"), { enumerable: true, value: true });
  assert.throws(() => assertControlMessage(symbolExtraDone), /all-done control message/i);

  for (const source of [transferSource, distTransferSource]) {
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /!descriptor\.enumerable/);
  }
  assert.match(distWebBundle, /Reflect\.ownKeys/);
  assert.match(distWebBundle, /\.enumerable/);
});

test("manifest limit validators do not read inherited manifest getters", () => {
  assert.match(securityPolicy, /manifest validators, manifest comparison helpers, and control-message parsers must walk control fields, manifests, file arrays, and file metadata by own data descriptors, reject unknown manifest and file-entry fields/);
  for (const source of [limitsSource, distLimitsSource]) {
    assert.match(source, /function ownDataValue/);
    assert.match(source, /function ownArrayDataValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.doesNotMatch(source, /manifest\.files/);
    assert.doesNotMatch(source, /file\.id/);
    assert.doesNotMatch(source, /file\.name/);
    assert.doesNotMatch(source, /file\.size/);
    assert.doesNotMatch(source, /file\.mime/);
  }
  assert.match(distWebBundle, /Manifest file list is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /`files`,`fileCount`,`totalBytes`/);
  assert.doesNotMatch(distWebBundle, /Array\.isArray\(\w+\.files\)/);
  assert.doesNotMatch(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+\.files,String/);

  const keys = ["files", "fileCount", "totalBytes", "id", "name", "size", "mime"];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let inheritedGetterReads = 0;
  try {
    for (const key of keys) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          inheritedGetterReads += 1;
          return undefined;
        },
        set() {
          // Keep the test fixture from breaking platform objects that assign one of these names.
        }
      });
    }

    const manifest = { files: [{ id: 0, name: "x", size: 1 }], fileCount: 1, totalBytes: 1 };
    for (const validate of [assertManifestWithinLimits, distAssertManifestWithinLimits]) {
      assert.doesNotThrow(() => validate(manifest));
      assert.throws(() => validate({ fileCount: 1, totalBytes: 1 } as never), /Manifest file list/);
    }
    for (const validate of [assertTransferManifestWithinLimits, distAssertTransferManifestWithinLimits]) {
      assert.doesNotThrow(() => validate(manifest));
      assert.throws(() => validate({ files: [{ name: "x", size: 1 }], fileCount: 1, totalBytes: 1 } as never), /Transfer manifest file id/);
    }
    assert.equal(inheritedGetterReads, 0);
  } finally {
    for (const key of keys) {
      const original = originals.get(key);
      if (original) {
        Object.defineProperty(Object.prototype, key, original);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
});

test("control-message parser does not read inherited control getters", () => {
  assert.match(securityPolicy, /control fields, manifests, file arrays, and file metadata by own data descriptors/);
  for (const source of [transferSource, distTransferSource]) {
    assert.match(source, /function ownDataValue/);
    assert.match(source, /const type = ownDataValue\(value, "t"\)/);
    assert.match(source, /const filesValue = ownDataValue\(value, "files"\)/);
    assert.doesNotMatch(source, /typeof value\.t/);
    assert.doesNotMatch(source, /value\.reason/);
    assert.doesNotMatch(source, /value\.sha256/);
    assert.doesNotMatch(source, /value\.files\.length/);
  }
  assert.match(distWebBundle, /Malformed control message/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /Unexpected sender control message/);

  const keys = ["t", "id", "name", "size", "sha256", "reason", "files", "totalBytes", "mime"];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let inheritedGetterReads = 0;
  let observedInheritedGetterReads = -1;
  try {
    for (const key of keys) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          inheritedGetterReads += 1;
          return undefined;
        },
        set() {
          // Keep platform/test objects that assign common names from failing during cleanup.
        }
      });
    }

    for (const validate of [assertControlMessage, distAssertControlMessage]) {
      const ready = validate({ t: "ready", id: 2 });
      if (ready.t !== "ready" || ready.id !== 2) throw new Error("ready control message was not parsed.");
      const manifest = validate({ t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 });
      if (manifest.t !== "manifest" || manifest.totalBytes !== 1 || manifest.files.length !== 1 || manifest.files[0]?.name !== "x.txt") {
        throw new Error("manifest control message was not parsed.");
      }
      assert.throws(() => validate({ id: 0 } as never), /Malformed control/);
      assert.throws(() => validate({ t: "file-begin", id: 0, size: 1 } as never), /Malformed file-begin/);
      assert.throws(() => validate({ t: "manifest", totalBytes: 1 } as never), /Malformed manifest/);
    }
    for (const validateSender of [assertSenderControlMessage, distAssertSenderControlMessage]) {
      const fileOk = validateSender({ t: "file-ok", id: 0 });
      if (fileOk.t !== "file-ok" || fileOk.id !== 0) throw new Error("file-ok control message was not parsed.");
      assert.throws(() => validateSender({ id: 0 } as never), /Unexpected sender control message: unknown/);
    }
    observedInheritedGetterReads = inheritedGetterReads;
  } finally {
    for (const key of keys) {
      const original = originals.get(key);
      if (original) {
        Object.defineProperty(Object.prototype, key, original);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
  assert.equal(observedInheritedGetterReads, 0);
});

test("transfer manifest must match the accepted encrypted manifest", () => {
  const accepted = { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "accepted.txt", size: 1, mime: "text/plain" }] };
  assert.doesNotThrow(() =>
    assertTransferManifestMatchesAccepted(accepted, { t: "manifest", totalBytes: 1, files: [{ id: 0, name: "accepted.txt", size: 1, mime: "text/plain" }] })
  );
  assert.throws(
    () => assertTransferManifestMatchesAccepted(accepted, { t: "manifest", totalBytes: 1, files: [{ id: 0, name: "swapped.exe", size: 1, mime: "text/plain" }] }),
    /accepted manifest/
  );
  assert.throws(
    () => assertTransferManifestMatchesAccepted(accepted, { t: "manifest", totalBytes: 2, files: [{ id: 0, name: "accepted.txt", size: 2, mime: "text/plain" }] }),
    /accepted manifest/
  );
});

test("transfer manifest comparison does not read inherited manifest getters", () => {
  for (const source of [transferSource, distTransferSource]) {
    assert.match(source, /const acceptedFiles = ownDataValue\(accepted, "files"\)/);
    assert.match(source, /const transferFiles = ownDataValue\(transfer, "files"\)/);
    assert.match(source, /ownDataValue\(acceptedFile, "id"\)/);
    assert.match(source, /ownDataValue\(transferFile, "id"\)/);
    assert.doesNotMatch(source, /accepted\.files/);
    assert.doesNotMatch(source, /transfer\.files/);
    assert.doesNotMatch(source, /accepted\.totalBytes/);
    assert.doesNotMatch(source, /transfer\.totalBytes/);
    assert.doesNotMatch(source, /acceptedFile\.id/);
    assert.doesNotMatch(source, /transferFile\.id/);
  }
  assert.match(distWebBundle, /accepted manifest/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e,t\)\{[\s\S]{0,900}t\.files\.length/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e,t\)\{[\s\S]{0,900}e\.files\.length/);

  const keys = ["files", "fileCount", "totalBytes", "id", "name", "size", "mime"];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let inheritedGetterReads = 0;
  let observedInheritedGetterReads = -1;
  try {
    for (const key of keys) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          inheritedGetterReads += 1;
          return undefined;
        },
        set() {
          // Keep platform/test objects that assign common names from failing during cleanup.
        }
      });
    }

    const accepted = { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain" }] };
    const transfer = { t: "manifest" as const, totalBytes: 1, files: [{ id: 0, name: "x.txt", size: 1, mime: "text/plain" }] };
    const malformedTransfer = { t: "manifest" as const, totalBytes: 1 };
    const malformedAccepted = { fileCount: 1, totalBytes: 1 };
    const expectThrow = (fn: () => void): void => {
      let threw = false;
      try {
        fn();
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("manifest comparison accepted malformed input.");
    };

    for (const validate of [assertTransferManifestMatchesAccepted, distAssertTransferManifestMatchesAccepted]) {
      validate(accepted, transfer);
      expectThrow(() => validate(accepted, malformedTransfer as never));
      expectThrow(() => validate(malformedAccepted as never, transfer));
    }
    observedInheritedGetterReads = inheritedGetterReads;
  } finally {
    for (const key of keys) {
      const original = originals.get(key);
      if (original) {
        Object.defineProperty(Object.prototype, key, original);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
  assert.equal(observedInheritedGetterReads, 0);
});

test("receiver-side filename sanitization prevents path traversal", () => {
  assert.equal(safeFileName("../../secret.txt"), "secret.txt");
  assert.equal(safeFileName("..\\secret.txt"), "secret.txt");
  assert.equal(safeFileName("\u0000"), "file");
  assert.equal(safeFileName("CON.txt"), "_CON.txt");
  assert.equal(safeFileName("bad:name?.txt"), "badname.txt");
  assert.equal(safeFileName("report\u202egnp.exe"), "reportgnp.exe");
  assert.equal(safeFileName("zero\u200bwidth.txt"), "zerowidth.txt");
  assert.equal(safeFileName("name. "), "name");
  assert.equal(safeFileName(".env"), "_env");
  assert.equal(safeFileName(".ssh"), "_ssh");
  assert.equal(safeFileName(".CON"), "_CON");
  assert.equal(safeFileName("CON .txt"), "_CON .txt");
  assert.equal(safeFileName("COM1...txt"), "_COM1...txt");
  assert.equal(safeFileName("LPT1 .log"), "_LPT1 .log");
  assert.equal(safeFileName(`${"a".repeat(240)}.txt`).length, 200);
  assert.equal(new TextEncoder().encode(safeFileName(`${"😀".repeat(80)}.txt`)).byteLength <= 200, true);
  assert.equal(safeFileName(`${"😀".repeat(80)}.txt`).endsWith(".txt"), true);
  assert.equal(safeFileName(`${"x/".repeat(5000)}keep.txt`), "keep.txt");
  assert.equal(safeFileName(`${"x".repeat(5000)}.txt`).endsWith(".txt"), true);
  assert.match(securityPolicy, /safe filename helpers must extract leaf names with a bounded reverse scan/);
  assert.match(securityPolicy, /safe filename helpers must reject non-string runtime values and over-budget collision indexes before leaf, reserved-name, collision, or UTF-8 byte processing/);
  for (const source of [limitsSource, distLimitsSource]) {
    assert.match(source, /typeof name !== "string"/);
    assert.match(source, /typeof safeName !== "string"/);
    assert.match(source, /function hasOnlyDataProperties/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /MAX_SAFE_FILE_NAME_INPUT_CHARS = 4096/);
    assert.match(source, /function leafName/);
    assert.match(source, /for \(let index = end - 1; index >= min; index -= 1\)/);
    assert.match(source, /function isWindowsReservedName/);
    assert.match(source, /function utf8ByteLength/);
    assert.match(source, /charCodeAt\(index\)/);
    assert.doesNotMatch(source, /const text = new TextEncoder\(\)/);
    assert.doesNotMatch(source, /text\.encode\(value\)\.byteLength/);
    assert.match(source, /charCodeAt\(index\) === 46/);
    assert.doesNotMatch(source, /\.split\("\."\)/);
    assert.doesNotMatch(source, /\.split\(`\.`\)/);
    assert.doesNotMatch(source, /filter\(Boolean\)\.at\(-1\)/);
  }
  assert.match(distWebBundle, /4096/);
  assert.match(distWebBundle, /for\(let \w of Reflect\.ownKeys\(\w+\)\)/);
  assert.match(distWebBundle, /typeof e!=`string`[\s\S]{0,80}File name is invalid/);
  assert.match(distWebBundle, /for\(let \w=\w-1;\w>=\w;--\w\)if/);
  assert.match(distWebBundle, /function [\w$]+\(e\)\{let t=0;for\(let n=0;n<e\.length;n\+=1\)\{let r=e\.charCodeAt\(n\)/);
  assert.match(distWebBundle, /function [\w$]+\(e\)\{let t=e\.length;for\(let n=0;n<e\.length;n\+=1\)if\(e\.charCodeAt\(n\)===46\)/);
  assert.match(distWebBundle, /File name is invalid/);
  assert.doesNotMatch(distWebBundle, /\.split\(`\.`\)\[0\]\?\.replace/);
});

test("receiver-side filename helpers reject non-string runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 8;
    },
    get lastIndexOf() {
      coerced = true;
      return () => -1;
    },
    toString() {
      coerced = true;
      return "safe.txt";
    },
    [Symbol.iterator]() {
      coerced = true;
      return [][Symbol.iterator]();
    }
  };
  assert.throws(() => safeFileName(hostile as never), /File name is invalid/);
  assert.throws(() => safeCollisionFileName(hostile as never, 0), /Safe file name is invalid/);
  assert.throws(() => safeCollisionFileName(hostile as never, 1), /Safe file name is invalid/);
  assert.equal(coerced, false);
});

test("receiver-side filename collision helpers cap indexes before emitting over-budget names", () => {
  assert.match(securityPolicy, /safe filename helpers must reject non-string runtime values and over-budget collision indexes/);
  for (const helper of [safeCollisionFileName, distSafeCollisionFileName]) {
    const bounded = helper("a".repeat(SAFE_FILE_NAME_BYTES), MAX_OUTPUT_NAME_ATTEMPTS - 1);
    assert.equal(new TextEncoder().encode(bounded).byteLength <= SAFE_FILE_NAME_BYTES, true);
    assert.match(bounded, /\(255\)$/);
    assert.throws(() => helper("safe.txt", MAX_OUTPUT_NAME_ATTEMPTS), /Collision index is invalid/);
    assert.throws(() => helper("safe.txt", Number.MAX_SAFE_INTEGER), /Collision index is invalid/);
  }
  for (const source of [limitsSource, distLimitsSource]) {
    assert.match(source, /MAX_OUTPUT_NAME_ATTEMPTS/);
    assert.match(source, /index >= MAX_OUTPUT_NAME_ATTEMPTS/);
    assert.doesNotMatch(source, /Collision index must be a positive integer/);
  }
});

test("encrypted control messages are schema-validated before transfer handling", () => {
  assert.match(securityPolicy, /DataChannel transfer manifests must enforce file-count limits before allocating normalized file-entry arrays/);
  assert.match(securityPolicy, /manifest validators, manifest comparison helpers, and control-message parsers must walk control fields, manifests, file arrays, and file metadata by own data descriptors, reject unknown manifest and file-entry fields/);
  for (const source of [limitsSource, distLimitsSource]) {
    assert.match(source, /hasOnlyKeys\(manifest, \["files", "fileCount", "totalBytes"\]\)/);
    assert.match(source, /hasOnlyKeys\(file, \["id", "name", "size", "mime"\]\)/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /!descriptor\.enumerable/);
  }
  assert.match(distWebBundle, /`files`,`fileCount`,`totalBytes`/);
  assert.match(distWebBundle, /`id`,`name`,`size`,`mime`/);
  for (const source of [transferSource, distTransferSource]) {
    assert.match(source, /function ownDataValue/);
    assert.match(source, /const filesValue = ownDataValue\(value, "files"\)/);
    assert.match(source, /const totalBytes = ownDataValue\(value, "totalBytes"\)/);
    assert.doesNotMatch(source, /value\.files\.map/);
    assert.doesNotMatch(source, /typeof value\.t/);
    assert.doesNotMatch(source, /value\.files\.length/);
    assert.doesNotMatch(source, /file\.id/);
    assert.doesNotMatch(source, /file\.name/);
    assert.doesNotMatch(source, /file\.size/);
    assert.doesNotMatch(source, /file\.mime/);
  }
  assert.match(distWebBundle, /Malformed control message/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.doesNotMatch(distWebBundle, /typeof \w+\.t/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e\)\{[\s\S]{0,900}e\.files\.length/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e\)[\s\S]{0,900}e\.files\.map/);
  assert.throws(() => assertControlMessage([]), /Malformed control/);
  assert.throws(() => assertControlMessage(new Date()), /Malformed control/);
  assert.deepEqual(assertControlMessage({ t: "ready", id: 2 }), { t: "ready", id: 2 });
  assert.throws(() => assertControlMessage({ t: "ready", id: "2" }), /Malformed ready/);
  assert.throws(() => assertControlMessage({ t: "ready", id: 2, extra: true }), /Malformed ready/);
  assert.throws(() => assertControlMessage({ t: "file-end", id: 0, sha256: "not-a-digest" }), /Malformed file-end/);
  assert.throws(() => assertControlMessage({ t: "ack", id: 0, bytes: 1 }), /Unknown control message/);
  assert.throws(() => assertControlMessage({ t: "all-done", extra: true }), /Malformed all-done/);
  assert.deepEqual(assertControlMessage({ t: "all-done-ok" }), { t: "all-done-ok" });
  assert.throws(() => assertControlMessage({ t: "all-done-ok", extra: true }), /Malformed all-done-ok/);
  assert.throws(() => assertControlMessage({ t: "abort", reason: "x".repeat(1001) }), /Malformed abort/);
  assert.throws(() => assertControlMessage({ t: "abort", reason: "\u001b[31mnope" }), /Malformed abort/);
  assert.throws(() => assertControlMessage({ t: "abort", reason: "zero\u200bwidth" }), /Malformed abort/);
  assert.throws(() => assertControlMessage({ t: "abort", reason: "\u001b[31mnope" }), /Malformed abort/);
  assert.throws(() => assertControlMessage({ t: "abort", reason: "zero\u200bwidth" }), /Malformed abort/);
  assert.doesNotMatch(transferSource, /UNSAFE_REASON_CHARS = \/[^\n]+\/gu/);
  assert.doesNotMatch(distTransferSource, /UNSAFE_REASON_CHARS = \/[^\n]+\/gu/);
  assert.match(distWebBundle, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u/);
  assert.match(securityPolicy, /DataChannel control-message validators must not use stateful regular expressions/);
  assert.deepEqual(assertControlMessage(abortControlMessage("")), { t: "abort", reason: "Transfer aborted." });
  assert.deepEqual(assertControlMessage(abortControlMessage("zero\u200bwidth")), { t: "abort", reason: "Transfer aborted." });
  assert.deepEqual(assertControlMessage(abortControlMessage(new Error("\u001b[31mboom\nnow"))), { t: "abort", reason: "Transfer aborted." });
  assert.deepEqual(assertControlMessage(abortControlMessage(new Error(`secret path /Users/victorhaine/${"x".repeat(MAX_ABORT_REASON_CHARS)}`))), {
    t: "abort",
    reason: "Transfer aborted."
  });
  assert.equal(remoteAbortError().message, REMOTE_ABORT_MESSAGE);
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 0,
        files: []
      }),
    /File count/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: MAX_FILES_PER_SESSION + 1,
        files: Array.from({ length: MAX_FILES_PER_SESSION + 1 }, (_, id) => ({ id, name: `${id}.txt`, size: 1 }))
      }),
    /File count/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 2,
        files: [
          { id: 0, name: "a.txt", size: 1 },
          { id: 0, name: "b.txt", size: 1 }
        ]
      }),
    /Duplicate file id/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [{ id: 7, name: "a.txt", size: 1 }]
      }),
    /canonical and sequential/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 2,
        files: [
          { id: 1, name: "a.txt", size: 1 },
          { id: 0, name: "b.txt", size: 1 }
        ]
      }),
    /canonical and sequential/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [[0, "a.txt", 1]]
      }),
    /Malformed manifest file entry/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [{ id: 0, name: "a.txt", size: 1, extra: true }]
      }),
    /Malformed manifest file entry/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [{ id: 0, name: "a.txt", size: 1, mime: "x".repeat(256) }]
      }),
    /Malformed manifest MIME type/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [{ id: 0, name: "a.txt", size: 1, mime: "text/plain; charset=utf-8" }]
      }),
    /MIME/
  );
  assert.throws(
    () =>
      assertControlMessage({
        t: "manifest",
        totalBytes: 1,
        files: [{ id: 0, name: "x".repeat(MAX_FILE_NAME_CHARS + 1), size: 1 }]
      }),
    /File name/
  );
});

test("sender-side control messages fail closed to receiver acknowledgements only", () => {
  assert.deepEqual(assertSenderControlMessage({ t: "ready", id: 1 }), { t: "ready", id: 1 });
  assert.deepEqual(assertSenderControlMessage({ t: "file-ok", id: 1 }), { t: "file-ok", id: 1 });
  assert.deepEqual(assertSenderControlMessage({ t: "all-done-ok" }), { t: "all-done-ok" });
  assert.deepEqual(assertSenderControlMessage({ t: "abort", reason: "stop" }), { t: "abort", reason: "stop" });
  assert.throws(() => assertSenderControlMessage({ t: "all-done" }), /Unexpected sender control message/);
  assert.throws(() => assertSenderControlMessage({ t: "file-begin", id: 1, name: "x.txt", size: 1 }), /Unexpected sender control message/);
});

test("transfer code parser separates public rendezvous from secret words", () => {
  assert.equal(RENDEZVOUS_DIGITS, 8);
  assert.equal(GENERATED_RENDEZVOUS_DIGITS, 12);
  assert.match(securityPolicy, /current clients must generate twelve decimal digits, and legacy compatibility must not accept less than eight decimal digits/);
  assert.deepEqual(parseCode("123456789012-Apple-Anchor"), {
    handle: "123456789012-apple-anchor",
    rendezvous: "123456789012",
    secret: "apple-anchor"
  });
  assert.deepEqual(parseCode("12345678-Apple-Anchor"), {
    handle: "12345678-apple-anchor",
    rendezvous: "12345678",
    secret: "apple-anchor"
  });
  assert.equal(parseCode("apple-anchor"), null);
  assert.equal(parseCode("12345678-apple-apple"), null);
  assert.equal(parseCode("123456-apple-anchor"), null);
  assert.equal(parseCode("1234567890-apple-anchor"), null);
  assert.equal(parseCode("1234567890123-apple-anchor"), null);
  assert.equal(isValidRendezvous("123456789012"), true);
  assert.equal(isValidRendezvous("12345678"), true);
  assert.equal(isValidRendezvous("123456"), false);
  assert.match(generateCode(), /^[0-9]{12}-[a-z]+-[a-z]+$/);
  const generated = parseCode(generateCode());
  assert.notEqual(generated?.secret.split("-")[0], generated?.secret.split("-")[1]);
  assert.equal(generated?.rendezvous.length, GENERATED_RENDEZVOUS_DIGITS);
});

test("transfer code parser caps raw input before normalization", () => {
  assert.match(securityPolicy, /transfer code inputs must be capped before trim\/lowercase normalization/);
  assert.equal(parseCode(" ".repeat(MAX_CODE_INPUT_BYTES + 1)), null);
  assert.equal(parseCode(`${" ".repeat(MAX_CODE_INPUT_BYTES)}12345678-apple-anchor`), null);
  assert.equal(normalizeCode(`${"é".repeat(Math.floor(MAX_CODE_INPUT_BYTES / 2))}x`), "");
  assert.match(transferCodeSource, /MAX_CODE_INPUT_BYTES = 256/);
  assert.match(transferCodeSource, /function utf8ByteLengthExceeds/);
  assert.match(transferCodeSource, /charCodeAt\(index\)/);
  assert.match(transferCodeSource, /codeInputUtf8ByteLengthExceeds\(code\)[\s\S]*return ""/);
  assert.match(distTransferCodeSource, /MAX_CODE_INPUT_BYTES = 256/);
  assert.match(distTransferCodeSource, /function utf8ByteLengthExceeds/);
  assert.match(distTransferCodeSource, /charCodeAt\(index\)/);
  assert.match(distTransferCodeSource, /codeInputUtf8ByteLengthExceeds\(code\)[\s\S]*return ""/);
  assert.match(distWebBundle, /charCodeAt\(/);
});

test("transfer code parser rejects non-string runtime values before coercion", () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 25;
    },
    get trim() {
      coerced = true;
      return () => "12345678-apple-anchor";
    },
    toString() {
      coerced = true;
      return "12345678-apple-anchor";
    }
  };

  assert.equal(normalizeCode(hostile as never), "");
  assert.equal(parseCode(hostile as never), null);
  assert.equal(isValidCode(hostile as never), false);
  assert.equal(isValidRendezvous(hostile as never), false);
  assert.equal(coerced, false);
  assert.match(securityPolicy, /transfer code helpers must reject non-string runtime values before length, trim, lowercase, or regular-expression processing/);
  for (const source of [transferCodeSource, distTransferCodeSource]) {
    assert.match(source, /typeof code !== "string"/);
    assert.match(source, /typeof value === "string" && RENDEZVOUS_PATTERN\.test\(value\)/);
  }
  assert.match(distWebBundle, /return typeof e==`string`&&\w+\.test\(e\)/);
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}

function assertNoDuplicateJsonObjectKeys(source: string, label: string): void {
  const file = ts.parseJsonText(label, source);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  assert.deepEqual(
    parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
    `${label} must be valid JSON`
  );

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set<string>();
      for (const property of node.properties) {
        assert.ok(ts.isPropertyAssignment(property), `${label} must contain only JSON property assignments`);
        const key = jsonPropertyName(property.name, label);
        if (keys.has(key)) {
          const position = file.getLineAndCharacterOfPosition(property.name.getStart(file));
          assert.fail(`${label}:${position.line + 1}:${position.character + 1} duplicates JSON key ${JSON.stringify(key)}`);
        }
        keys.add(key);
      }
    }
    node.forEachChild(visit);
  };

  visit(file);
}

function jsonPropertyName(name: ts.PropertyName, label: string): string {
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) return name.text;
  throw new Error(`${label} contains an unsupported JSON property name.`);
}
