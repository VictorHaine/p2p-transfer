import test, { after } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHUNK_SIZE, MAX_FILES_PER_SESSION } from "../src/shared/constants.js";
import { decodeChunk } from "../src/shared/chunks.js";
import { createSha256, digestHex } from "../src/shared/hash.js";
import { finishPake, openBulk, openControl, ownPakeShareB64, sealControl, startPake, type SessionKeys } from "../src/shared/security.js";
import type { ControlMessage } from "../src/shared/transfer.js";
import { buildManifest } from "../src/cli/files.js";
import { buildManifest as distBuildManifest } from "../dist-node/cli/files.js";
import { sendFiles } from "../src/cli/transfer.js";
import { sendFiles as distSendFiles } from "../dist-node/cli/transfer.js";

type FakeChannel = RTCDataChannel & {
  sent: unknown[];
  emit(data: unknown): Promise<void>;
  emitClose(): void;
};

const sourceTransfer = fsSync.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
const distTransfer = fsSync.readFileSync(new URL("../dist-node/cli/transfer.js", import.meta.url), "utf8");
const sourceFiles = fsSync.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const distFiles = fsSync.readFileSync(new URL("../dist-node/cli/files.js", import.meta.url), "utf8");
const securityPolicy = fsSync.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const VALID_SHA256 = "0".repeat(64);
const testStartedAt = Date.now();

after(async () => {
  await removeCreatedTempDirs(["ff-send-"]);
});

test("CLI sender rejects files that grow beyond the accepted manifest size while streaming", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-size-changed");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-size-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "ab");
  const handle = await fs.open(filePath, "r");
  const control = fakeChannel();
  const bulk = fakeChannel();
  const send = sendFiles(control, bulk, senderKeys, [{ id: 0, name: "x.txt", size: 1, path: filePath, handle, sha256: VALID_SHA256, chunkSha256: [VALID_SHA256] }], false, true);

  await waitForControl(control, receiverKeys, "file-begin");
  await control.emit(await seal(receiverKeys, { t: "ready", id: 0 }));

  await assert.rejects(send, /changed while sending/);
});

test("CLI sender streams the preflighted file handle even if the path is replaced", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-symlink-swap");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-swap-"));
  const filePath = path.join(dir, "x.txt");
  const replacement = path.join(dir, "secret.txt");
  await fs.writeFile(filePath, "safe");
  await fs.writeFile(replacement, "pwn!");
  const { files } = await buildManifest([filePath]);
  await fs.rm(filePath);
  await fs.symlink(replacement, filePath);

  const control = fakeChannel();
  const bulk = fakeChannel();
  autoAckSenderControl(control, receiverKeys);

  await sendFiles(control, bulk, senderKeys, files, false, true);

  const frame = decodeChunk(bulk.sent[0] as ArrayBuffer);
  const plaintext = await openBulk(receiverKeys, frame.fileId, frame.chunkSeq, frame.payload);
  assert.equal(new TextDecoder().decode(plaintext), "safe");
  assert.equal(control.onmessage, null);
  assert.equal(control.onclose, null);
  assert.equal(bulk.onclose, null);
});

test("CLI sender resumes at the receiver ready offset", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-resume-offset");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-resume-"));
  const filePath = path.join(dir, "resume.bin");
  const prefix = Buffer.alloc(CHUNK_SIZE, 1);
  const suffix = new TextEncoder().encode("tail");
  await fs.writeFile(filePath, Buffer.concat([prefix, suffix]));
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  control.onmessage = null;
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  await waitForControl(control, receiverKeys, "file-begin");
  await control.emit(await seal(receiverKeys, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(prefix) }));
  await waitForControl(control, receiverKeys, "file-end");
  await control.emit(await seal(receiverKeys, { t: "file-ok", id: 0 }));
  await waitForControl(control, receiverKeys, "all-done");
  await control.emit(await seal(receiverKeys, { t: "all-done-ok" }));
  await send;

  assert.equal(bulk.sent.length, 1);
  const frame = decodeChunk(bulk.sent[0] as ArrayBuffer);
  assert.equal(frame.fileId, 0);
  assert.equal(frame.chunkSeq, 1);
  const plaintext = await openBulk(receiverKeys, frame.fileId, frame.chunkSeq, frame.payload);
  assert.deepEqual(plaintext, suffix);
  const fileEnd = (await openedControlMessages(control, receiverKeys)).find((message): message is Extract<ControlMessage, { t: "file-end" }> => message.t === "file-end");
  assert.equal(fileEnd?.sha256, files[0]!.sha256);
});

test("CLI sender rejects a mutated skipped resume prefix before sending suffix bytes", async () => {
  assert.match(securityPolicy, /CLI senders must also rehash and per-chunk verify any skipped resume prefix before sending resumed suffix bytes/);

  for (const sender of [sendFiles, distSendFiles]) {
    const { senderKeys, receiverKeys } = await makeKeys(`send-resume-prefix-${sender === sendFiles ? "src" : "dist"}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-resume-prefix-"));
    const filePath = path.join(dir, "resume.bin");
    const prefix = Buffer.alloc(CHUNK_SIZE, 1);
    const suffix = new TextEncoder().encode("tail");
    await fs.writeFile(filePath, Buffer.concat([prefix, suffix]));
    const { files } = await buildManifest([filePath]);
    await fs.writeFile(filePath, Buffer.concat([Buffer.alloc(CHUNK_SIZE, 2), suffix]));
    const control = fakeChannel();
    const bulk = fakeChannel();
    const send = sender(control, bulk, senderKeys, files, false, true);

    await waitForControl(control, receiverKeys, "file-begin");
    await control.emit(await seal(receiverKeys, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(prefix) }));

    await assert.rejects(send, /changed before resumed chunk 0 could be trusted/);
    assert.equal(bulk.sent.length, 0);
  }
});

test("CLI sender restarts from zero when receiver resume prefix does not match", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-resume-prefix-restart");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-resume-restart-"));
  const filePath = path.join(dir, "resume.bin");
  const prefix = Buffer.alloc(CHUNK_SIZE, 1);
  const suffix = new TextEncoder().encode("tail");
  await fs.writeFile(filePath, Buffer.concat([prefix, suffix]));
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  await waitForControl(control, receiverKeys, "file-begin");
  await control.emit(await seal(receiverKeys, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(Buffer.alloc(CHUNK_SIZE, 9)) }));
  await waitForControl(control, receiverKeys, "restart");
  await control.emit(await seal(receiverKeys, { t: "ready", id: 0 }));
  await waitForControl(control, receiverKeys, "file-end");
  await control.emit(await seal(receiverKeys, { t: "file-ok", id: 0 }));
  await waitForControl(control, receiverKeys, "all-done");
  await control.emit(await seal(receiverKeys, { t: "all-done-ok" }));
  await send;

  assert.equal(bulk.sent.length, 2);
  const first = decodeChunk(bulk.sent[0] as ArrayBuffer);
  const second = decodeChunk(bulk.sent[1] as ArrayBuffer);
  assert.equal(first.chunkSeq, 0);
  assert.equal(second.chunkSeq, 1);
});

test("CLI sender rejects same-size file mutations after manifest preflight", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-same-size-mutation");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-mutated-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  await fs.writeFile(filePath, "evil");

  const control = fakeChannel();
  const bulk = fakeChannel();
  autoAckSenderControl(control, receiverKeys);

  await assert.rejects(() => sendFiles(control, bulk, senderKeys, files, false, true), /changed before chunk 0/);
  assert.equal(bulk.sent.length, 0);
});

test("CLI sender preflight records per-chunk hashes for send-time TOCTOU checks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-chunk-hash-"));
  const filePath = path.join(dir, "x.bin");
  await fs.writeFile(filePath, Buffer.alloc(CHUNK_SIZE + 1, 7));

  const { files } = await buildManifest([filePath]);
  try {
    assert.equal(files[0]?.chunkSha256?.length, 2);
  } finally {
    await Promise.allSettled(files.map((file) => file.handle.close()));
  }
});

test("CLI sender preflight rejects files that grow while being hashed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-preflight-grow-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const probe = await fs.open(filePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { createReadStream(options?: unknown): unknown };
  await probe.close();
  const originalCreateReadStream = fileHandlePrototype.createReadStream;
  let mutated = false;
  try {
    fileHandlePrototype.createReadStream = function patchedCreateReadStream(this: fs.FileHandle, options?: unknown) {
      if (!mutated) {
        mutated = true;
        fsSync.appendFileSync(filePath, "!");
      }
      return originalCreateReadStream.call(this, options);
    };

    await assert.rejects(() => buildManifest([filePath]), /changed while preparing/);
  } finally {
    fileHandlePrototype.createReadStream = originalCreateReadStream;
  }
});

test("CLI sender preflight rejects same-size file mutations while being hashed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-preflight-rewrite-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const probe = await fs.open(filePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { createReadStream(options?: unknown): NodeJS.ReadableStream };
  await probe.close();
  const originalCreateReadStream = fileHandlePrototype.createReadStream;
  let mutated = false;
  try {
    fileHandlePrototype.createReadStream = function patchedCreateReadStream(this: fs.FileHandle, options?: unknown) {
      const stream = originalCreateReadStream.call(this, options);
      if (!mutated) {
        stream.once("end", () => {
          mutated = true;
          fsSync.writeFileSync(filePath, "evil");
        });
      }
      return stream;
    };

    await assert.rejects(() => buildManifest([filePath]), /changed while preparing/);
  } finally {
    fileHandlePrototype.createReadStream = originalCreateReadStream;
  }
});

test("CLI sender preflight rejects unsafe manifest file names before sending", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-unsafe-name-"));
  const filePath = path.join(dir, "zero\u200bwidth.txt");
  await fs.writeFile(filePath, "safe");

  await assert.rejects(() => buildManifest([filePath]), /File path must not contain control or format characters|File name is invalid/);
});

test("CLI sender preflight rejects non-canonical file stream chunks before Buffer coercion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-preflight-chunk-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const probe = await fs.open(filePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { createReadStream(options?: unknown): unknown };
  await probe.close();
  const originalCreateReadStream = fileHandlePrototype.createReadStream;
  let iteratorAccessorRead = false;

  try {
    fileHandlePrototype.createReadStream = () =>
      (async function* () {
        yield hostileChunk(() => {
          iteratorAccessorRead = true;
        });
      })();

    for (const builder of [buildManifest, distBuildManifest]) {
      await assert.rejects(() => builder([filePath]), /Unsupported file stream chunk type/);
    }
  } finally {
    fileHandlePrototype.createReadStream = originalCreateReadStream;
  }

  assert.equal(iteratorAccessorRead, false);
});

test("CLI sender revalidates transfer manifests at the send boundary", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-boundary-manifest");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-boundary-manifest-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  files[0]!.id = 7;
  const control = fakeChannel();
  const bulk = fakeChannel();

  await assert.rejects(() => sendFiles(control, bulk, senderKeys, files, false, true), /Send file entry is invalid/);
  assert.deepEqual(await openedControlTypes(control, receiverKeys), ["abort"]);
  assert.equal(bulk.sent.length, 0);
});

test("CLI sender transfer boundary rejects accessor-backed file inputs before invoking getters", async () => {
  assert.match(securityPolicy, /CLI sender transfer boundary must descriptor-validate and bound send file arrays, entries, handles, read\/stream methods, canonical hashes, and chunk hashes/);

  let arrayAccessorRead = false;
  const accessorFiles: unknown[] = [];
  Object.defineProperty(accessorFiles, "0", {
    enumerable: true,
    get() {
      arrayAccessorRead = true;
      return {};
    }
  });

  let entryAccessorRead = false;
  const accessorEntry = {};
  Object.defineProperty(accessorEntry, "id", {
    enumerable: true,
    get() {
      entryAccessorRead = true;
      return 0;
    }
  });

  let readAccessorRead = false;
  const readAccessorHandle = {
    createReadStream: () =>
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    close: async () => {}
  };
  Object.defineProperty(readAccessorHandle, "read", {
    enumerable: true,
    get() {
      readAccessorRead = true;
      return async () => ({ bytesRead: 0 });
    }
  });

  const deepMethodPrototype = {
    createReadStream: () =>
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    read: async () => ({ bytesRead: 1 })
  };
  let deepHandle: object = deepMethodPrototype;
  for (let depth = 0; depth < 9; depth += 1) {
    deepHandle = Object.create(deepHandle);
  }

  for (const sender of [sendFiles, distSendFiles]) {
    const { senderKeys } = await makeKeys(`send-boundary-accessor-${sender === sendFiles ? "src" : "dist"}`);
    await assert.rejects(() => sender(fakeChannel(), fakeChannel(), senderKeys, accessorFiles as never, false, true), /Send file entry is invalid/);
    await assert.rejects(() => sender(fakeChannel(), fakeChannel(), senderKeys, [accessorEntry] as never, false, true), /Send file entry is invalid/);
    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 0, name: "x.txt", size: 1, handle: readAccessorHandle, sha256: VALID_SHA256, chunkSha256: [VALID_SHA256] }] as never, false, true),
      /Send file handle is invalid/
    );
    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 0, name: "x.txt", size: 1, handle: deepHandle, sha256: VALID_SHA256, chunkSha256: [VALID_SHA256] }] as never, false, true),
      /Send file handle is invalid/
    );
  }

  assert.equal(arrayAccessorRead, false);
  assert.equal(entryAccessorRead, false);
  assert.equal(readAccessorRead, false);

  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /function buildSendPlan/);
    assert.match(source, /files\.length === 0 \|\| files\.length > MAX_FILES_PER_SESSION/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
    assert.match(source, /function sendPlanFileInput/);
    assert.match(source, /id !== index/);
    assert.match(source, /assertFileWithinLimits\(name, size\)/);
    assert.match(source, /function ownDataMethod/);
    assert.match(source, /depth < 8/);
    assert.match(source, /const read = ownDataMethod\(handle, "read"\)/);
    assert.doesNotMatch(source, /files\.map\(\(\{ id, name, size, mime, handle, sha256, chunkSha256 \}\)/);
  }
});

test("CLI sender transfer boundary rejects accessor-backed chunk hashes before cloning", async () => {
  let hashAccessorRead = false;
  const chunkSha256: unknown[] = [];
  Object.defineProperty(chunkSha256, "0", {
    enumerable: true,
    get() {
      hashAccessorRead = true;
      return "0".repeat(64);
    }
  });

  for (const sender of [sendFiles, distSendFiles]) {
    const { senderKeys } = await makeKeys(`send-boundary-hash-${sender === sendFiles ? "src" : "dist"}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-boundary-hash-"));
    const filePath = path.join(dir, "x.txt");
    await fs.writeFile(filePath, "safe");
    const { files } = await buildManifest([filePath]);
    files[0]!.chunkSha256 = chunkSha256 as never;

    await assert.rejects(() => sender(fakeChannel(), fakeChannel(), senderKeys, files, false, true), /Send file chunk hashes are invalid/);
  }

  assert.equal(hashAccessorRead, false);
});

test("CLI sender transfer boundary bounds and validates chunk hashes before cloning", async () => {
  assert.match(securityPolicy, /CLI sender transfer boundary must descriptor-validate and bound send file arrays, entries, handles, read\/stream methods, canonical hashes, and chunk hashes/);

  for (const sender of [sendFiles, distSendFiles]) {
    const { senderKeys } = await makeKeys(`send-boundary-hash-bound-${sender === sendFiles ? "src" : "dist"}`);
    const handle = {
      createReadStream: () =>
        (async function* () {
          yield new Uint8Array([1]);
        })(),
      read: async () => ({ bytesRead: 1 }),
      close: async () => {}
    };

    let distantHashRead = false;
    const oversizedHashes: unknown[] = ["0".repeat(64)];
    oversizedHashes.length = 1_000_000;
    Object.defineProperty(oversizedHashes, "999999", {
      enumerable: true,
      get() {
        distantHashRead = true;
        return "0".repeat(64);
      }
    });

    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 0, name: "x.txt", size: 1, handle, sha256: VALID_SHA256, chunkSha256: oversizedHashes }] as never, false, true),
      /Send file chunk hashes are invalid/
    );
    assert.equal(distantHashRead, false);

    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 0, name: "x.txt", size: 1, handle, sha256: "not-a-sha256" }] as never, false, true),
      /Send file hash is invalid/
    );
    await assert.rejects(
      () =>
        sender(
          fakeChannel(),
          fakeChannel(),
          senderKeys,
          [{ id: 0, name: "x.txt", size: CHUNK_SIZE + 1, handle, sha256: VALID_SHA256, chunkSha256: [VALID_SHA256] }] as never,
          false,
          true
        ),
      /Send file chunk hashes are invalid/
    );
    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 0, name: "x.txt", size: 1, handle, sha256: VALID_SHA256, chunkSha256: ["z".repeat(64)] }] as never, false, true),
      /Send file chunk hashes are invalid/
    );
    await assert.rejects(
      () => sender(fakeChannel(), fakeChannel(), senderKeys, [{ id: 1, name: "x.txt", size: 1, handle, sha256: VALID_SHA256, chunkSha256: [VALID_SHA256] }] as never, false, true),
      /Send file entry is invalid/
    );
    await assert.rejects(() => sender(fakeChannel(), fakeChannel(), senderKeys, [] as never, false, true), /Send file list is invalid/);
    const tooMany = Array.from({ length: MAX_FILES_PER_SESSION + 1 }, (_, id) => ({ id, name: `x-${id}.txt`, size: 0, handle, sha256: VALID_SHA256, chunkSha256: [] }));
    await assert.rejects(() => sender(fakeChannel(), fakeChannel(), senderKeys, tooMany as never, false, true), /Send file list is invalid/);
  }

  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /MAX_CHUNK_HASHES_PER_FILE/);
    assert.match(source, /SHA256_HEX/);
    assert.match(source, /value\.length !== expectedChunks/);
  }
});

test("CLI sender send-time stream chunks reject non-canonical runtime values before Buffer coercion", async () => {
  assert.match(securityPolicy, /CLI sender preflight and send-time file stream chunks must reject non-canonical runtime chunks/);

  for (const sender of [sendFiles, distSendFiles]) {
    const { senderKeys, receiverKeys } = await makeKeys(`send-stream-chunk-${sender === sendFiles ? "src" : "dist"}`);
    let iteratorAccessorRead = false;
    const files = [
      {
        id: 0,
        name: "x.txt",
        size: 1,
        path: "x.txt",
        sha256: VALID_SHA256,
        chunkSha256: [VALID_SHA256],
        handle: {
          createReadStream: () =>
            (async function* () {
              yield hostileChunk(() => {
                iteratorAccessorRead = true;
              });
            })(),
          read: async () => ({ bytesRead: 1 }),
          close: async () => {}
        }
      }
    ];
    const control = fakeChannel();
    const bulk = fakeChannel();
    autoAckSenderControl(control, receiverKeys);

    await assert.rejects(() => sender(control, bulk, senderKeys, files as never, false, true), /Unsupported binary chunk type/);
    assert.equal(iteratorAccessorRead, false);
    assert.equal(bulk.sent.length, 0);
  }

  for (const source of [sourceTransfer, distTransfer]) {
    const sendBody = extractFunctionBody(source, "sendFiles");
    assert.match(sendBody, /const \{ hash \} = await hashSendPrefix\(file, resumeOffset\)/);
    assert.match(sendBody, /const \{ hash \} = await hashSendPrefix\(file, resumeOffset\);\n\s+await throwIfSenderFailed\(\);/);
    const digestBody = extractFunctionBody(source, "digestFilePath");
    assert.match(sendBody, /const payload = toBytes\(chunk\)/);
    assert.doesNotMatch(sendBody, /resumeOffset === 0 && actualSha256/);
    assert.match(digestBody, /const payload = toBytes\(chunk\)/);
    assert.doesNotMatch(sendBody, /Buffer\.from\(chunk\)/);
    assert.doesNotMatch(digestBody, /Buffer\.from\(chunk\)/);
  }
  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /function hashFileHandle[\s\S]*const payload = fileStreamChunkBytes\(chunk\)/);
    assert.match(source, /function hashFileHandle[\s\S]*sameFileMutationSnapshot\(await fileMutationSnapshot\(handle\), expectedMutation\)/);
    assert.doesNotMatch(source, /function hashFileHandle[\s\S]*Buffer\.from\(chunk\)/);
    assert.match(source, /function fileStreamChunkBytes/);
    assert.match(source, /function isCanonicalFileStreamBytes/);
  }
});

test("CLI sender uses an immutable send plan after boundary validation", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-plan-snapshot");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-plan-snapshot-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const originalSend = (control.send as (data: unknown) => void).bind(control);
  let mutated = false;
  control.send = (data: unknown) => {
    originalSend(data);
    void openControl<ControlMessage>(receiverKeys, String(data))
      .then(async (message) => {
        if (message.t === "manifest" && !mutated) {
          mutated = true;
          files[0]!.name = "mutated.exe";
          files[0]!.id = 7;
        }
        if (message.t === "file-begin") await control.emit(await seal(receiverKeys, { t: "ready", id: message.id }));
        if (message.t === "file-end") await control.emit(await seal(receiverKeys, { t: "file-ok", id: message.id }));
        if (message.t === "all-done") await control.emit(await seal(receiverKeys, { t: "all-done-ok" }));
      })
      .catch(() => {});
  };

  await sendFiles(control, bulk, senderKeys, files, false, true);

  const messages = await openedControlMessages(control, receiverKeys);
  assert.deepEqual(messages.slice(0, 2), [
    { t: "manifest", totalBytes: 4, files: [{ id: 0, name: "x.txt", size: 4 }] },
    { t: "file-begin", id: 0, name: "x.txt", size: 4 }
  ]);
  const frame = decodeChunk(bulk.sent[0] as ArrayBuffer);
  assert.equal(frame.fileId, 0);
});

test("CLI sender rejects unexpected channel close before transfer completion", async () => {
  const { senderKeys } = await makeKeys("send-channel-close");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-close-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  control.emitClose();

  await assert.rejects(send, /Control channel closed/);
  assert.equal(control.onmessage, null);
  assert.equal(control.onclose, null);
  assert.equal(bulk.onclose, null);
});

test("CLI sender accepts final acknowledgement before a queued close", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-final-ack-before-close");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-final-close-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const originalSend = (control.send as (data: unknown) => void).bind(control);
  control.send = (data: unknown) => {
    originalSend(data);
    void openControl<ControlMessage>(receiverKeys, String(data))
      .then(async (message) => {
        if (message.t === "file-begin") await control.emit(await seal(receiverKeys, { t: "ready", id: message.id }));
        if (message.t === "file-end") await control.emit(await seal(receiverKeys, { t: "file-ok", id: message.id }));
        if (message.t === "all-done") {
          await control.emit(await seal(receiverKeys, { t: "all-done-ok" }));
          control.emitClose();
        }
      })
      .catch(() => {});
  };

  await sendFiles(control, bulk, senderKeys, files, false, true);

  const controlMessages = await openedControlTypes(control, receiverKeys);
  assert.deepEqual(controlMessages, ["manifest", "file-begin", "file-end", "all-done"]);
  assert.equal(control.onmessage, null);
  assert.equal(control.onclose, null);
  assert.equal(bulk.onclose, null);
});

test("CLI sender rejects unexpected receiver control messages", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-unexpected-control");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-unexpected-control-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  await control.emit(await seal(receiverKeys, { t: "all-done" }));

  await assert.rejects(send, /Unexpected sender control message/);
  assert.equal(control.onmessage, null);
  assert.equal(control.onclose, null);
  assert.equal(bulk.onclose, null);
});

test("CLI sender rejects acknowledgements before the matching transfer phase is armed", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-stale-ack");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-stale-ack-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  await control.emit(await seal(receiverKeys, { t: "file-ok", id: 0 }));

  await assert.rejects(send, /Unexpected file-ok acknowledgement/);
  assert.equal(bulk.sent.length, 0);
  assert.equal(control.onmessage, null);
});

test("CLI sender stops before the next control phase after a peer failure", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("send-stop-after-failure");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-stop-after-failure-"));
  const filePath = path.join(dir, "x.txt");
  await fs.writeFile(filePath, "safe");
  const { files } = await buildManifest([filePath]);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const badAck = await seal(receiverKeys, { t: "all-done-ok" });
  const originalBulkSend = (bulk.send as (data: unknown) => void).bind(bulk);
  bulk.send = (data: unknown) => {
    originalBulkSend(data);
    void control.emit(badAck);
  };
  const send = sendFiles(control, bulk, senderKeys, files, false, true);

  await waitForControl(control, receiverKeys, "file-begin");
  await control.emit(await seal(receiverKeys, { t: "ready", id: 0 }));

  await assert.rejects(send, /Unexpected all-done-ok acknowledgement/);
  const controlMessages = await openedControlTypes(control, receiverKeys);
  assert.deepEqual(controlMessages, ["manifest", "file-begin", "abort"]);
});

async function makeKeys(label: string): Promise<{ senderKeys: SessionKeys; receiverKeys: SessionKeys }> {
  const sender = startPake("sender", "123456-apple-anchor", label);
  const receiver = startPake("receiver", "123456-apple-anchor", label);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  return { senderKeys, receiverKeys };
}

async function waitForControl(control: FakeChannel, keys: SessionKeys, type: ControlMessage["t"]): Promise<void> {
  const deadline = Date.now() + 100;
  for (;;) {
    if ((await openedControlTypes(control, keys)).includes(type)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}.`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function openedControlTypes(control: FakeChannel, keys: SessionKeys): Promise<ControlMessage["t"][]> {
  return (await openedControlMessages(control, keys)).map((message) => message.t);
}

async function openedControlMessages(control: FakeChannel, keys: SessionKeys): Promise<ControlMessage[]> {
  const messages: ControlMessage[] = [];
  for (const sent of control.sent) {
    try {
      messages.push(await openControl<ControlMessage>(keys, String(sent)));
    } catch {
      // Ignore messages not sealed for this peer direction.
    }
  }
  return messages;
}

function seal(keys: SessionKeys, message: ControlMessage): Promise<string> {
  return sealControl(keys, message);
}

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

function hostileChunk(onIteratorRead: () => void): object {
  const chunk = {};
  Object.defineProperty(chunk, Symbol.iterator, {
    get() {
      onIteratorRead();
      return function* iterator() {
        yield 1;
      };
    }
  });
  return chunk;
}

function fakeChannel(): FakeChannel {
  const channel = {
    sent: [] as unknown[],
    readyState: "open",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    binaryType: "arraybuffer",
    send(data: unknown) {
      this.sent.push(data);
    },
    async emit(data: unknown) {
      const handler = (this as { onmessage: ((event: MessageEvent) => unknown) | null }).onmessage;
      if (handler) await handler({ data } as MessageEvent);
    },
    emitClose() {
      const handler = (this as { onclose: ((event: Event) => unknown) | null }).onclose;
      if (handler) handler(new Event("close"));
    },
    close() {},
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
    onbufferedamountlow: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    }
  };
  return channel as unknown as FakeChannel;
}

function autoAckSenderControl(control: FakeChannel, receiverKeys: SessionKeys): void {
  const originalSend = (control.send as (data: unknown) => void).bind(control);
  control.send = (data: unknown) => {
    originalSend(data);
    void openControl<ControlMessage>(receiverKeys, String(data))
      .then(async (message) => {
        if (message.t === "file-begin") await control.emit(await seal(receiverKeys, { t: "ready", id: message.id }));
        if (message.t === "file-end") await control.emit(await seal(receiverKeys, { t: "file-ok", id: message.id }));
        if (message.t === "all-done") await control.emit(await seal(receiverKeys, { t: "all-done-ok" }));
      })
      .catch(() => {});
  };
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = createSha256();
  hash.update(bytes);
  return digestHex(hash);
}

async function removeCreatedTempDirs(prefixes: readonly string[]): Promise<void> {
  const tmp = os.tmpdir();
  const cutoff = testStartedAt - 1_000;
  for (const entry of await fs.readdir(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const fullPath = path.join(tmp, entry.name);
    const stat = await fs.stat(fullPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat || (stat.birthtimeMs < cutoff && stat.ctimeMs < cutoff && stat.mtimeMs < cutoff)) continue;
    await fs.rm(fullPath, { recursive: true, force: true });
  }
}
