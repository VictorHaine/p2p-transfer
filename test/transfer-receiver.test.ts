import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeChunk } from "../src/shared/chunks.js";
import { CHUNK_SIZE, RECEIVE_QUEUE_MAX_MESSAGES } from "../src/shared/constants.js";
import { createSha256, digestHex } from "../src/shared/hash.js";
import { finishPake, openControl, ownPakeShareB64, sealBulk, sealControl, startPake, type SessionKeys } from "../src/shared/security.js";
import type { ControlMessage } from "../src/shared/transfer.js";
import { reserveOutputFile } from "../src/cli/files.js";
import { receiveFiles } from "../src/cli/transfer.js";

type FakeChannel = RTCDataChannel & {
  sent: unknown[];
  closed: boolean;
  emit(data: unknown): Promise<void>;
  emitClose(): void;
};

const testStartedAt = Date.now();

after(async () => {
  await removeCreatedTempDirs(["ff-recv-"]);
});

test("CLI receiver accepts a valid encrypted single-file transfer without WebRTC sockets", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("valid-receive");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-valid-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("hello");
  const hash = createSha256();
  hash.update(payload);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "hello.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "hello.txt", size: payload.byteLength }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await receive;
  assert.equal(await fs.readFile(path.join(outDir, "hello.txt"), "utf8"), "hello");
  assert.equal(await hasSealedControl(control, senderKeys, "all-done-ok"), true);
  assert.equal(control.onmessage, null);
  assert.equal(bulk.onmessage, null);
  assert.equal(control.onclose, null);
  assert.equal(bulk.onclose, null);
});

test("CLI receiver resumes from a chunk-aligned partial when resume is enabled", { skip: process.platform === "win32" ? "CLI resume is disabled on Windows until ACL privacy checks exist." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("resume-receive");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-resume-"));
  const prefix = Buffer.alloc(CHUNK_SIZE, 1);
  const suffix = new TextEncoder().encode("tail");
  const payload = Buffer.concat([prefix, suffix]);
  const partial = await reserveOutputFile(outDir, "resume.bin", { resume: true, size: payload.byteLength });
  await partial.handle.writeFile(prefix);
  await partial.handle.close();
  assert.match(path.basename(partial.partPath), /^ff-resume-[a-f0-9]{64}\.part$/);
  assert.equal(path.basename(partial.partPath).includes("resume.bin"), false);
  const hash = createSha256();
  hash.update(payload);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const acceptedManifest = { fileCount: 1, totalBytes: payload.byteLength, files: [{ id: 0, name: "resume.bin", size: payload.byteLength }] };
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, undefined, acceptedManifest, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "resume.bin", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "resume.bin", size: payload.byteLength }));
  const ready = await firstSealedControl(control, senderKeys, "ready");
  assert.deepEqual(ready, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(prefix) });
  await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, suffix)));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await receive;
  assert.deepEqual(await fs.readFile(path.join(outDir, "resume.bin")), payload);
  await assert.rejects(() => fs.stat(partial.partPath), { code: "ENOENT" });
});

test("CLI receiver truncates a stale resume partial when the sender requests restart", { skip: process.platform === "win32" ? "CLI resume is disabled on Windows until ACL privacy checks exist." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("resume-receive-restart");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-resume-restart-"));
  const stalePrefix = Buffer.alloc(CHUNK_SIZE, 1);
  const prefix = Buffer.alloc(CHUNK_SIZE, 2);
  const suffix = new TextEncoder().encode("fresh-tail");
  const payload = Buffer.concat([prefix, suffix]);
  const partial = await reserveOutputFile(outDir, "resume.bin", { resume: true, size: payload.byteLength });
  await partial.handle.writeFile(stalePrefix);
  await partial.handle.close();
  const hash = createSha256();
  hash.update(payload);
  const control = fakeChannel();
  const bulk = fakeChannel();
  const acceptedManifest = { fileCount: 1, totalBytes: payload.byteLength, files: [{ id: 0, name: "resume.bin", size: payload.byteLength }] };
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, undefined, acceptedManifest, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "resume.bin", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "resume.bin", size: payload.byteLength }));
  const staleReady = await firstSealedControl(control, senderKeys, "ready");
  assert.deepEqual(staleReady, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(stalePrefix) });

  const sentBeforeRestart = control.sent.length;
  await control.emit(await seal(senderKeys, { t: "restart", id: 0 }));
  const freshReady = await firstSealedControlAfter(control, senderKeys, "ready", sentBeforeRestart);
  assert.deepEqual(freshReady, { t: "ready", id: 0 });
  assert.equal((await fs.stat(partial.partPath)).size, 0);

  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, prefix)));
  await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, suffix)));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await receive;
  assert.deepEqual(await fs.readFile(path.join(outDir, "resume.bin")), payload);
  await assert.rejects(() => fs.stat(partial.partPath), { code: "ENOENT" });
});

test("CLI receiver rejects hardlinked resume partials before restart truncation", { skip: process.platform === "win32" ? "hardlink behavior differs on Windows." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("resume-receive-restart-hardlink");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-resume-hardlink-restart-"));
  const stalePrefix = Buffer.alloc(CHUNK_SIZE, 1);
  const payload = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 2), new TextEncoder().encode("fresh-tail")]);
  const partial = await reserveOutputFile(outDir, "resume.bin", { resume: true, size: payload.byteLength });
  await partial.handle.writeFile(stalePrefix);
  await partial.handle.close();
  const control = fakeChannel();
  const bulk = fakeChannel();
  const acceptedManifest = { fileCount: 1, totalBytes: payload.byteLength, files: [{ id: 0, name: "resume.bin", size: payload.byteLength }] };
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, undefined, acceptedManifest, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "resume.bin", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "resume.bin", size: payload.byteLength }));
  const staleReady = await firstSealedControl(control, senderKeys, "ready");
  assert.deepEqual(staleReady, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(stalePrefix) });

  const linkedPath = path.join(outDir, "linked-target");
  await fs.link(partial.partPath, linkedPath);
  await control.emit(await seal(senderKeys, { t: "restart", id: 0 }));

  await assert.rejects(receive, /Resume partial has multiple hard links/);
  assert.equal((await fs.stat(linkedPath)).size, CHUNK_SIZE);
});

test("CLI receiver rejects non-private resume partials before restart truncation", { skip: process.platform === "win32" ? "POSIX permissions required." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("resume-receive-restart-public");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-resume-public-restart-"));
  const stalePrefix = Buffer.alloc(CHUNK_SIZE, 1);
  const payload = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 2), new TextEncoder().encode("fresh-tail")]);
  const partial = await reserveOutputFile(outDir, "resume.bin", { resume: true, size: payload.byteLength });
  await partial.handle.writeFile(stalePrefix);
  await partial.handle.close();
  const control = fakeChannel();
  const bulk = fakeChannel();
  const acceptedManifest = { fileCount: 1, totalBytes: payload.byteLength, files: [{ id: 0, name: "resume.bin", size: payload.byteLength }] };
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, undefined, acceptedManifest, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "resume.bin", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "resume.bin", size: payload.byteLength }));
  const staleReady = await firstSealedControl(control, senderKeys, "ready");
  assert.deepEqual(staleReady, { t: "ready", id: 0, offset: CHUNK_SIZE, prefixSha256: sha256Hex(stalePrefix) });

  await fs.chmod(partial.partPath, 0o644);
  await control.emit(await seal(senderKeys, { t: "restart", id: 0 }));

  await assert.rejects(receive, /Resume partial is not private/);
  assert.equal((await fs.stat(partial.partPath)).size, CHUNK_SIZE);
});

test("CLI receiver tolerates all-done before bulk chunks drain across DataChannels", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("cross-channel-order");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-cross-channel-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("hello");
  const hash = createSha256();
  hash.update(payload);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "hello.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "hello.txt", size: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));

  await receive;
  assert.equal(await fs.readFile(path.join(outDir, "hello.txt"), "utf8"), "hello");
  assert.equal(await hasSealedControl(control, senderKeys, "all-done-ok"), true);
});

test("CLI receiver serializes async control messages from the ordered DataChannel", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("serialized-control-order");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-control-order-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "empty.txt", size: 0 }], totalBytes: 0 }));
  const begin = control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "empty.txt", size: 0 }));
  const end = control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: emptyHash }));
  const done = control.emit(await seal(senderKeys, { t: "all-done" }));
  await Promise.all([begin, end, done]);

  await receive;
  assert.equal(await fs.readFile(path.join(outDir, "empty.txt"), "utf8"), "");
  assert.equal(await hasSealedControl(control, senderKeys, "all-done-ok"), true);
});

test("CLI receiver rejects duplicate file-end before bulk chunks drain", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("duplicate-file-end");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-dup-end-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("hello");
  const hash = createSha256();
  hash.update(payload);
  const sha256 = digestHex(hash);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "hello.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "hello.txt", size: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256 }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256 }));

  await assert.rejects(receive, /Duplicate file-end/);
});

test("CLI receiver rejects duplicate all-done before completion", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("duplicate-all-done");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-dup-done-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("hello");
  const hash = createSha256();
  hash.update(payload);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "hello.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "hello.txt", size: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await assert.rejects(receive, /Duplicate all-done/);
});

test("CLI receiver rejects chunks after zero-byte file-end", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("chunk-after-done");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-after-done-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "empty.txt", size: 0 }], totalBytes: 0 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "empty.txt", size: 0 }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, new Uint8Array())));

  await assert.rejects(receive, /completed file/);
});

test("CLI receiver rejects empty bulk chunks before they can spin a transfer", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("empty-bulk-chunk");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-empty-chunk-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "empty.txt", size: 0 }], totalBytes: 0 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "empty.txt", size: 0 }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, new Uint8Array())));

  await assert.rejects(receive, /Empty chunk/);
  assert.equal(bulk.closed, true);
});

test("CLI receiver caps queued inbound DataChannel messages", async () => {
  const { receiverKeys } = await makeKeys("queued-inbound-cap");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-queue-cap-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const handler = bulk.onmessage;
  assert.ok(handler);

  for (let index = 0; index <= RECEIVE_QUEUE_MAX_MESSAGES; index += 1) {
    handler.call(bulk, { data: new Uint8Array([0]) } as MessageEvent);
  }

  await assert.rejects(receive, /Receive queue backpressure exceeded\./);
  assert.equal(control.onmessage, null);
  assert.equal(bulk.onmessage, null);
});

test("CLI receiver rejects non-canonical DataChannel binary views before accessor reads", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("hostile-binary-view");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-hostile-view-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  let getterInvoked = false;

  const DataViewCtor = DataView as { new (buffer: ArrayBuffer): DataView };
  class HostileDataView extends DataViewCtor {
    override get buffer(): ArrayBufferLike {
      getterInvoked = true;
      return super.buffer;
    }

    override get byteOffset(): number {
      getterInvoked = true;
      return super.byteOffset;
    }

    override get byteLength(): number {
      getterInvoked = true;
      return super.byteLength;
    }
  }

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  await bulk.emit(new HostileDataView(new ArrayBuffer(9)));

  await assert.rejects(receive, /Receive queue backpressure exceeded\./);
  assert.equal(getterInvoked, false);
  assert.equal(bulk.closed, true);
});

test("DataChannel binary ingress policy is present in source and shipped artifacts", () => {
  const cliSource = fsSync.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
  const cliDist = fsSync.readFileSync(new URL("../dist-node/cli/transfer.js", import.meta.url), "utf8");
  const webSource = fsSync.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
  const webDist = readDistWebBundle();
  const securityPolicy = fsSync.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

  assert.doesNotMatch(cliSource, /ArrayBuffer\.isView\(data\)/);
  assert.doesNotMatch(cliDist, /ArrayBuffer\.isView\(data\)/);
  assert.doesNotMatch(webSource, /ArrayBuffer\.isView\(data\)/);
  assert.doesNotMatch(webDist, /Unsupported chunk data[\s\S]{0,300}ArrayBuffer\.isView/);
  assert.match(cliSource, /Object\.getPrototypeOf\(data\) === ArrayBuffer\.prototype/);
  assert.match(cliSource, /prototype !== Uint8Array\.prototype && prototype !== Buffer\.prototype/);
  assert.match(cliDist, /Object\.getPrototypeOf\(data\) === ArrayBuffer\.prototype/);
  assert.match(webSource, /Object\.getPrototypeOf\(data\) === ArrayBuffer\.prototype/);
  assert.match(webSource, /prototype !== Uint8Array\.prototype/);
  assert.match(webDist, /function \w+\(e\)\{if\(e instanceof ArrayBuffer&&Object\.getPrototypeOf\(e\)===ArrayBuffer\.prototype\)/);
  assert.match(securityPolicy, /DataChannel binary ingress must reject DataView, typed-array subclasses/);
});

test("CLI receiver rejects all-done before every manifest file starts", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("all-done-missing-file");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-missing-start-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(
    await seal(senderKeys, {
      t: "manifest",
      files: [
        { id: 0, name: "a.txt", size: 0 },
        { id: 1, name: "b.txt", size: 0 }
      ],
      totalBytes: 0
    })
  );
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "a.txt", size: 0 }));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await assert.rejects(receive, /Not all manifest files/);
});

test("CLI receiver rejects file-begin before the encrypted manifest", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("begin-before-manifest");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-order-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));

  await assert.rejects(receive, /before manifest/);
  assert.equal(bulk.closed, true);
});

test("CLI receiver rejects file-begin values that do not match the manifest", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("manifest-mismatch");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-mismatch-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 2 }));

  await assert.rejects(receive, /does not match manifest/);
});

test("CLI receiver rejects a transfer manifest that differs from the accepted request", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("accepted-manifest-mismatch");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-accepted-mismatch-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const acceptedManifest = { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "accepted.txt", size: 1 }] };
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, undefined, acceptedManifest);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "swapped.txt", size: 1 }], totalBytes: 1 }));

  await assert.rejects(receive, /accepted manifest/);
});

test("CLI receiver times out stalled transfers and removes partial files", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("stalled-transfer-timeout");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-stalled-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true, 20);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "stalled.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "stalled.txt", size: 1 }));

  await assert.rejects(receive, /timed out/);
  assert.deepEqual(await findCliPartPaths(outDir, "stalled.txt"), []);
  assert.equal(control.closed, true);
  assert.equal(bulk.closed, true);
});

test("CLI receiver rejects out-of-order chunks", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("chunk-order");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-seq-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, new Uint8Array([1]))));

  await assert.rejects(receive, /Unexpected chunk sequence/);
});

test("CLI receiver preserves transfer error when partial cleanup also fails", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("cleanup-error-preserves-root-cause");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-cleanup-root-cause-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  const partPath = await findSingleCliPartPath(outDir, "x.txt");
  await fs.rm(partPath, { force: true });
  await fs.mkdir(partPath);
  await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, new Uint8Array([1]))));

  await assert.rejects(receive, /Unexpected chunk sequence/);
});

test("CLI receiver reports partial cleanup failure without path evidence", { skip: process.platform === "win32" ? "POSIX permissions required." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("cleanup-error-warning");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-cleanup-warning-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const stderr: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const receive = receiveFiles(control, bulk, receiverKeys, outDir, true, false);
    await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "secret-local-name.txt", size: 1 }], totalBytes: 1 }));
    await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "secret-local-name.txt", size: 1 }));
    await findSingleCliPartPath(outDir, "secret-local-name.txt");
    await fs.chmod(outDir, 0o500);
    await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, new Uint8Array([1]))));

    await assert.rejects(receive, /Unexpected chunk sequence/);
  } finally {
    console.error = originalError;
    await fs.chmod(outDir, 0o700).catch(() => {});
  }

  assert.equal(stderr.length, 1);
  const warning = JSON.parse(stderr[0] ?? "{}");
  assert.deepEqual(warning, {
    event: "warning",
    warning: "receive_cleanup_failed",
    message: "Warning: transfer failed and a received file or partial file could not be cleaned up. Inspect the receive output directory manually."
  });
  assert.doesNotMatch(stderr.join("\n"), /secret-local-name|ff-recv-cleanup-warning|Unexpected chunk sequence|EISDIR|ENOTEMPTY/);
});

test("CLI receiver reports partial cleanup failure even in quiet modes", { skip: process.platform === "win32" ? "POSIX permissions required." : false }, async () => {
  for (const json of [true, false]) {
    const { senderKeys, receiverKeys } = await makeKeys(`cleanup-error-quiet-${json ? "json" : "human"}`);
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `ff-recv-cleanup-quiet-${json ? "json" : "human"}-`));
    const control = fakeChannel();
    const bulk = fakeChannel();
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      stderr.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const receive = receiveFiles(control, bulk, receiverKeys, outDir, json, true);
      await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "quiet-secret-name.txt", size: 1 }], totalBytes: 1 }));
      await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "quiet-secret-name.txt", size: 1 }));
      await findSingleCliPartPath(outDir, "quiet-secret-name.txt");
      await fs.chmod(outDir, 0o500);
      await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, new Uint8Array([1]))));

      await assert.rejects(receive, /Unexpected chunk sequence/);
    } finally {
      console.error = originalError;
      await fs.chmod(outDir, 0o700).catch(() => {});
    }

    assert.equal(stderr.length, 1);
    if (json) {
      assert.deepEqual(JSON.parse(stderr[0] ?? "{}"), {
        event: "warning",
        warning: "receive_cleanup_failed",
        message: "Warning: transfer failed and a received file or partial file could not be cleaned up. Inspect the receive output directory manually."
      });
    } else {
      assert.equal(stderr[0], "Warning: transfer failed and a received file or partial file could not be cleaned up. Inspect the receive output directory manually.");
    }
    assert.doesNotMatch(stderr.join("\n"), /quiet-secret-name|ff-recv-cleanup-quiet|Unexpected chunk sequence|EISDIR|ENOTEMPTY/);
  }
});

test("CLI receiver removes published output if final acknowledgement fails", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("published-output-ack-failure");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-published-ack-failure-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const originalSend = control.send.bind(control);
  let sends = 0;
  control.send = ((data: unknown) => {
    sends += 1;
    if (sends > 2) throw new Error("mock final acknowledgement failure");
    (originalSend as (value: unknown) => void)(data);
  }) as RTCDataChannel["send"];
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("published output");
  const hash = createSha256();
  hash.update(payload);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "post-publish.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "post-publish.txt", size: payload.byteLength }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
  assert.equal(await fs.readFile(path.join(outDir, "post-publish.txt"), "utf8"), "published output");
  await control.emit(await seal(senderKeys, { t: "all-done" }));

  await assert.rejects(receive, /mock final acknowledgement failure/);
  await assert.rejects(() => fs.stat(path.join(outDir, "post-publish.txt")), { code: "ENOENT" });
  assert.deepEqual(await findCliPartPaths(outDir, "post-publish.txt"), []);
});

test("CLI receiver reports published output cleanup failure without path evidence", { skip: process.platform === "win32" ? "POSIX permissions required." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("published-output-cleanup-failure");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-published-cleanup-failure-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const originalSend = control.send.bind(control);
  let sends = 0;
  control.send = ((data: unknown) => {
    sends += 1;
    if (sends > 2) throw new Error("mock final acknowledgement failure");
    (originalSend as (value: unknown) => void)(data);
  }) as RTCDataChannel["send"];
  const stderr: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const receive = receiveFiles(control, bulk, receiverKeys, outDir, true, true);
    const payload = new TextEncoder().encode("published cleanup failure");
    const hash = createSha256();
    hash.update(payload);

    await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "published-secret-name.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
    await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "published-secret-name.txt", size: payload.byteLength }));
    await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));
    await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
    await fs.chmod(outDir, 0o500);
    await control.emit(await seal(senderKeys, { t: "all-done" }));

    await assert.rejects(receive, /mock final acknowledgement failure/);
  } finally {
    console.error = originalError;
    await fs.chmod(outDir, 0o700).catch(() => {});
  }

  assert.equal(stderr.length, 1);
  assert.deepEqual(JSON.parse(stderr[0] ?? "{}"), {
    event: "warning",
    warning: "receive_cleanup_failed",
    message: "Warning: transfer failed and a received file or partial file could not be cleaned up. Inspect the receive output directory manually."
  });
  assert.doesNotMatch(stderr.join("\n"), /published-secret-name|ff-recv-published-cleanup-failure|mock final acknowledgement failure|EACCES|EPERM|ENOTEMPTY/);
});

test("CLI receiver cleanup does not remove a replaced partial pathname", { skip: process.platform === "win32" ? "Windows does not allow replacing an open partial file path." : false }, async () => {
  const { senderKeys, receiverKeys } = await makeKeys("cleanup-replaced-part-path");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-cleanup-replaced-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  const partPath = await findSingleCliPartPath(outDir, "x.txt");
  await fs.rm(partPath);
  await fs.writeFile(partPath, "replacement");
  await bulk.emit(encodeChunk(0, 1, await sealBulk(senderKeys, 0, 1, new Uint8Array([1]))));

  await assert.rejects(receive, /Unexpected chunk sequence/);
  assert.equal(await fs.readFile(partPath, "utf8"), "replacement");
});

test("CLI receiver rejects chunks that exceed the accepted file size", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("chunk-overrun");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-overrun-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, new Uint8Array([1, 2]))));

  await assert.rejects(receive, /more bytes than declared/);
  assert.deepEqual(await findCliPartPaths(outDir, "x.txt"), []);
  assert.equal(bulk.closed, true);
});

test("CLI receiver rejects partial files corrupted on disk before publish", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("part-corruption-before-publish");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-part-corrupt-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
  const payload = new TextEncoder().encode("safe");
  const hash = createSha256();
  hash.update(payload);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: payload.byteLength }));
  await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));
  const partPath = await findSingleCliPartPath(outDir, "x.txt");
  await fs.writeFile(partPath, "evil");
  await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));

  await assert.rejects(receive, /On-disk hash mismatch/);
  await assert.rejects(() => fs.stat(path.join(outDir, "x.txt")), { code: "ENOENT" });
  await assert.rejects(() => fs.stat(partPath), { code: "ENOENT" });
});

test("CLI receiver verifies partial and published paths with no-follow nonblocking opens", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("verify-open-flags");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-verify-flags-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const payload = new TextEncoder().encode("safe");
  const hash = createSha256();
  hash.update(payload);
  const observed: { target: string; flags: unknown }[] = [];
  const originalOpen = fsSync.promises.open;
  const mutablePromises = fsSync.promises as unknown as {
    open: typeof fsSync.promises.open;
  };

  try {
    mutablePromises.open = (target, flags, mode) => {
      const targetPath = String(target);
      if (targetPath.startsWith(outDir)) observed.push({ target: targetPath, flags });
      return originalOpen.call(fsSync.promises, target, flags, mode);
    };

    const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);
    await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: payload.byteLength }], totalBytes: payload.byteLength }));
    await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: payload.byteLength }));
    await bulk.emit(encodeChunk(0, 0, await sealBulk(senderKeys, 0, 0, payload)));
    await control.emit(await seal(senderKeys, { t: "file-end", id: 0, sha256: digestHex(hash) }));
    await control.emit(await seal(senderKeys, { t: "all-done" }));
    await receive;
  } finally {
    mutablePromises.open = originalOpen;
  }

  const safeReadFlags = fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK;
  assert.equal(observed.some((entry) => /\/ff-[a-f0-9]{32}\.part$/.test(entry.target) && entry.flags === safeReadFlags), true);
  assert.equal(observed.some((entry) => entry.target.endsWith("x.txt") && !entry.target.endsWith(".part") && entry.flags === safeReadFlags), true);
});

test("CLI receiver rejects unexpected channel close before transfer completion", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("channel-close");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-close-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "manifest", files: [{ id: 0, name: "x.txt", size: 1 }], totalBytes: 1 }));
  await control.emit(await seal(senderKeys, { t: "file-begin", id: 0, name: "x.txt", size: 1 }));
  bulk.emitClose();

  await assert.rejects(receive, /closed before completion/);
  assert.equal(bulk.closed, true);
  assert.equal(control.closed, true);
  assert.equal(control.onmessage, null);
  assert.equal(bulk.onmessage, null);
});

test("CLI receiver rejects sender-invalid control messages instead of ignoring them", async () => {
  const { senderKeys, receiverKeys } = await makeKeys("receiver-unexpected-control");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-recv-unexpected-control-"));
  const control = fakeChannel();
  const bulk = fakeChannel();
  const receive = receiveFiles(control, bulk, receiverKeys, outDir, false, true);

  await control.emit(await seal(senderKeys, { t: "ready", id: 0 }));

  await assert.rejects(receive, /Unexpected receiver control message/);
  assert.equal(bulk.closed, true);
  assert.equal(control.closed, true);
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

function seal(keys: SessionKeys, message: ControlMessage): Promise<string> {
  return sealControl(keys, message);
}

async function hasSealedControl(control: FakeChannel, keys: SessionKeys, type: ControlMessage["t"]): Promise<boolean> {
  for (const sent of control.sent) {
    try {
      const message = await openControl<ControlMessage>(keys, String(sent));
      if (message.t === type) return true;
    } catch {
      // Ignore non-control or peer-key messages in the fake channel log.
    }
  }
  return false;
}

async function firstSealedControl(control: FakeChannel, keys: SessionKeys, type: ControlMessage["t"]): Promise<ControlMessage> {
  for (const sent of control.sent) {
    try {
      const message = await openControl<ControlMessage>(keys, String(sent));
      if (message.t === type) return message;
    } catch {
      // Ignore non-control or peer-key messages in the fake channel log.
    }
  }
  throw new Error(`Missing sealed ${type} control message.`);
}

async function firstSealedControlAfter(control: FakeChannel, keys: SessionKeys, type: ControlMessage["t"], startIndex: number): Promise<ControlMessage> {
  for (const sent of control.sent.slice(startIndex)) {
    try {
      const message = await openControl<ControlMessage>(keys, String(sent));
      if (message.t === type) return message;
    } catch {
      // Ignore non-control or peer-key messages in the fake channel log.
    }
  }
  throw new Error(`Missing sealed ${type} control message after index ${startIndex}.`);
}

async function findSingleCliPartPath(dir: string, finalName: string): Promise<string> {
  const matches = await findCliPartPaths(dir, finalName);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

async function findCliPartPaths(dir: string, _finalName: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((entry) => /^ff(?:-resume)?-[a-f0-9]{32,64}\.part$/.test(entry)).map((entry) => path.join(dir, entry));
}

function fakeChannel(): FakeChannel {
  const channel = {
    sent: [] as unknown[],
    closed: false,
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
    close() {
      this.closed = true;
    },
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

function sha256Hex(bytes: Uint8Array): string {
  const hash = createSha256();
  hash.update(bytes);
  return digestHex(hash);
}

function readDistWebBundle(): string {
  const distDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleName = fsSync.readdirSync(distDir).find((entry) => /^index-.*\.js$/.test(entry));
  assert.ok(bundleName);
  return fsSync.readFileSync(new URL(bundleName, distDir), "utf8");
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
