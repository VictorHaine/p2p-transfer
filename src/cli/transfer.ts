import fs from "node:fs";
import path from "node:path";
import { CHUNK_SIZE, DATA_CHANNEL_BUFFER_HIGH, MAX_FILE_BYTES, MAX_FILES_PER_SESSION, TRANSFER_CONTROL_TIMEOUT_MS } from "../shared/constants.js";
import { ControlAckWaiter } from "../shared/control-waiter.js";
import { decodeChunk, encodeChunk } from "../shared/chunks.js";
import { formatBytes, formatRate } from "../shared/format.js";
import { createSha256, digestHex, type Sha256 } from "../shared/hash.js";
import { assertFileWithinLimits, assertManifestWithinLimits, assertTransferManifestWithinLimits } from "../shared/limits.js";
import { sanitizeDisplayText, sanitizeStructuredOutput } from "../shared/output-safety.js";
import { openBulk, openControl, sealBulk, sealControl, type SessionKeys } from "../shared/security.js";
import { abortControlMessage, assertControlMessage, assertSenderControlMessage, assertTransferManifestMatchesAccepted, remoteAbortError, type TransferManifest, type ControlMessage } from "../shared/transfer.js";
import { closeSendFiles, reserveOutputFile } from "./files.js";
import type { SendFile } from "./files.js";
import type { FileManifest } from "../shared/messages.js";
import { safeErrorMessage } from "./exit-codes.js";
import { waitForBackpressure } from "./rtc.js";
import { unrefTimer } from "./timers.js";

type Progress = {
  totalBytes: number;
  transferredBytes: number;
  startedAt: number;
  json: boolean;
  quiet: boolean;
  redactOutput: boolean;
};

type SendPlanFile = {
  id: number;
  name: string;
  size: number;
  mime?: string;
  handle: SendFile["handle"];
  createReadStream: SendFile["handle"]["createReadStream"];
  read: SendFile["handle"]["read"];
  sha256: string;
  chunkSha256: string[];
};

type SendFileRead = (this: SendFile["handle"], buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_CHUNK_HASHES_PER_FILE = Math.ceil(MAX_FILE_BYTES / CHUNK_SIZE);

export async function sendFiles(
  control: RTCDataChannel,
  bulk: RTCDataChannel,
  keys: SessionKeys,
  files: SendFile[],
  json = false,
  quiet = false,
  redactOutput = false
): Promise<void> {
  const acks = new ControlAckWaiter(TRANSFER_CONTROL_TIMEOUT_MS);
  let failed: Error | undefined;
  let completed = false;
  let senderControlQueue: Promise<void> = Promise.resolve();
  const readyOffsets = new Map<number, number>();
  const cleanupSenderChannels = () => {
    control.onmessage = null;
    control.onclose = null;
    control.onerror = null;
    bulk.onclose = null;
    bulk.onerror = null;
  };
  const enqueueSenderControl = (task: () => Promise<void>): void => {
    senderControlQueue = senderControlQueue.then(task, task);
    senderControlQueue.catch(() => {});
  };
  const failSender = (message: string) => {
    enqueueSenderControl(async () => {
      if (completed) return;
      failed = new Error(message);
      acks.fail(failed);
    });
  };
  const throwIfSenderFailed = async () => {
    await senderControlQueue;
    if (failed) throw failed;
  };
  const handleSenderControl = async (data: unknown) => {
    if (completed) return;
    try {
      const message = assertSenderControlMessage(assertControlMessage(await openControl<unknown>(keys, data)));
      if (message.t === "ready") {
        readyOffsets.set(message.id, resumeOffsetInput(message.offset ?? 0, message.id));
        if (!acks.mark("ready", message.id)) throw new Error(`Unexpected ready acknowledgement for file ${message.id}.`);
      } else if (message.t === "file-ok") {
        if (!acks.mark("file-ok", message.id)) throw new Error(`Unexpected file-ok acknowledgement for file ${message.id}.`);
      } else if (message.t === "all-done-ok") {
        if (!acks.mark("all-done-ok")) throw new Error("Unexpected all-done-ok acknowledgement.");
        completed = true;
      } else if (message.t === "abort") {
        failed = remoteAbortError();
        acks.fail(failed);
      }
    } catch (error) {
      if (completed) return;
      failed = error instanceof Error ? error : new Error(safeErrorMessage(error));
      acks.fail(failed);
    }
  };
  control.onclose = () => failSender("Control channel closed before transfer completed.");
  bulk.onclose = () => failSender("Bulk channel closed before transfer completed.");
  control.onerror = () => failSender("Control channel errored before transfer completed.");
  bulk.onerror = () => failSender("Bulk channel errored before transfer completed.");
  control.onmessage = async (event) => {
    enqueueSenderControl(() => handleSenderControl(event.data));
  };

  try {
    const sendPlan = buildSendPlan(files);
    const totalBytes = sendPlan.reduce((sum, file) => sum + file.size, 0);
    const transferFiles: TransferManifest["files"] = sendPlan.map(({ id, name, size, mime }) => (mime === undefined ? { id, name, size } : { id, name, size, mime }));
    const transferManifest: FileManifest = {
      files: transferFiles,
      fileCount: sendPlan.length,
      totalBytes
    };
    assertTransferManifestWithinLimits(transferManifest);
    const progress: Progress = { totalBytes, transferredBytes: 0, startedAt: Date.now(), json, quiet, redactOutput };
    await sendControl(control, keys, {
      t: "manifest",
      files: transferFiles,
      totalBytes
    });

    for (const file of sendPlan) {
      await throwIfSenderFailed();
      await sendControl(control, keys, { t: "file-begin", id: file.id, name: file.name, size: file.size });
      await acks.wait("ready", file.id);
      const resumeOffset = readyOffsets.get(file.id) ?? 0;
      if (resumeOffset > file.size || (resumeOffset < file.size && resumeOffset % CHUNK_SIZE !== 0)) throw new Error(`Invalid resume offset for ${file.name}.`);

      const hash = await hashSendPrefix(file, resumeOffset);
      let seq = resumeOffset === file.size ? file.chunkSha256.length : resumeOffset / CHUNK_SIZE;
      let fileBytes = resumeOffset;
      progress.transferredBytes += resumeOffset;
      for await (const chunk of file.createReadStream.call(file.handle, { start: resumeOffset, highWaterMark: CHUNK_SIZE, autoClose: false })) {
        if (failed) throw failed;
        const payload = toBytes(chunk);
        try {
          if (fileBytes + payload.byteLength > file.size) throw new Error(`${file.name} changed while sending.`);
          const expectedChunkSha256 = file.chunkSha256[seq];
          if (expectedChunkSha256 === undefined) throw new Error(`${file.name} changed while sending.`);
          const chunkHash = createSha256();
          chunkHash.update(payload);
          if (digestHex(chunkHash) !== expectedChunkSha256) throw new Error(`${file.name} changed before chunk ${seq} could be sent.`);
          hash.update(payload);
          const sealed = await sealBulk(keys, file.id, seq, payload);
          try {
            bulk.send(encodeChunk(file.id, seq, sealed));
          } finally {
            sealed.fill(0);
          }
          seq += 1;
          fileBytes += payload.byteLength;
          progress.transferredBytes += payload.byteLength;
          printProgress("sent", file.name, progress);
          await waitForBackpressure(bulk, DATA_CHANNEL_BUFFER_HIGH);
        } finally {
          payload.fill(0);
        }
      }
      if (seq !== file.chunkSha256.length) throw new Error(`${file.name} changed while sending.`);
      if (fileBytes !== file.size) throw new Error(`${file.name} changed while sending.`);
      const actualSha256 = digestHex(hash);
      if (actualSha256 !== file.sha256) throw new Error(`${file.name} changed while sending.`);
      await throwIfSenderFailed();
      await sendControl(control, keys, { t: "file-end", id: file.id, sha256: file.sha256 });
      await acks.wait("file-ok", file.id);
    }

    await throwIfSenderFailed();
    await sendControl(control, keys, { t: "all-done" });
    await acks.wait("all-done-ok");
    printProgress("sent", "complete", progress, true);
  } catch (error) {
    try {
      await sendControl(control, keys, abortControlMessage(error));
    } catch {
      // The control channel may already be closed; preserve the original transfer error.
    }
    throw error;
  } finally {
    cleanupSenderChannels();
    await closeSendFiles(files);
  }
}

function resumeOffsetInput(value: unknown, id: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > MAX_FILE_BYTES) throw new Error(`Invalid ready acknowledgement for file ${id}.`);
  return value;
}

async function hashSendPrefix(file: SendPlanFile, resumeOffset: number): Promise<Sha256> {
  const hash = createSha256();
  if (resumeOffset === 0) return hash;
  for (let offset = 0, seq = 0; offset < resumeOffset; offset += CHUNK_SIZE, seq += 1) {
    const length = Math.min(CHUNK_SIZE, resumeOffset - offset);
    const payload = Buffer.alloc(length);
    try {
      const read = file.read as unknown as SendFileRead;
      const { bytesRead } = await read.call(file.handle, payload, 0, length, offset);
      if (bytesRead !== length) throw new Error(`${file.name} changed while resuming.`);
      const expectedChunkSha256 = file.chunkSha256[seq];
      if (expectedChunkSha256 === undefined) throw new Error(`${file.name} changed while resuming.`);
      const chunkHash = createSha256();
      chunkHash.update(payload);
      if (digestHex(chunkHash) !== expectedChunkSha256) throw new Error(`${file.name} changed before resumed chunk ${seq} could be trusted.`);
      hash.update(payload);
    } finally {
      payload.fill(0);
    }
  }
  return hash;
}

function buildSendPlan(files: SendFile[]): SendPlanFile[] {
  if (!Array.isArray(files)) throw new Error("Send file list is invalid.");
  if (files.length === 0 || files.length > MAX_FILES_PER_SESSION) throw new Error("Send file list is invalid.");
  const sendPlan: SendPlanFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Send file entry is invalid.");
    sendPlan.push(sendPlanFileInput(descriptor.value, index));
  }
  return sendPlan;
}

function sendPlanFileInput(value: unknown, index: number): SendPlanFile {
  if (!value || typeof value !== "object") throw new Error("Send file entry is invalid.");
  const id = ownDataValue(value, "id");
  const name = ownDataValue(value, "name");
  const size = ownDataValue(value, "size");
  const mime = ownDataValue(value, "mime");
  const handle = ownDataValue(value, "handle");
  const sha256 = ownDataValue(value, "sha256");
  const chunkSha256 = ownDataValue(value, "chunkSha256");
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id !== index ||
    typeof name !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_FILE_BYTES ||
    (mime !== undefined && typeof mime !== "string")
  ) {
    throw new Error("Send file entry is invalid.");
  }
  assertFileWithinLimits(name, size);
  if (!handle || typeof handle !== "object") throw new Error("Send file handle is invalid.");
  const createReadStream = ownDataMethod(handle, "createReadStream");
  const read = ownDataMethod(handle, "read");
  if (typeof createReadStream !== "function" || typeof read !== "function") throw new Error("Send file handle is invalid.");
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) throw new Error("Send file hash is invalid.");
  const chunkHashes = sendChunkHashesInput(chunkSha256, size);
  const plan: SendPlanFile = {
    id,
    name,
    size,
    ...(mime === undefined ? {} : { mime }),
    handle: handle as SendFile["handle"],
    createReadStream: createReadStream as SendFile["handle"]["createReadStream"],
    read: read as SendFile["handle"]["read"],
    sha256,
    chunkSha256: chunkHashes
  };
  return plan;
}

function sendChunkHashesInput(value: unknown, size: number): string[] {
  if (!Array.isArray(value)) throw new Error("Send file chunk hashes are invalid.");
  const expectedChunks = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
  if (value.length !== expectedChunks || value.length > MAX_CHUNK_HASHES_PER_FILE) throw new Error("Send file chunk hashes are invalid.");
  const hashes: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !SHA256_HEX.test(descriptor.value)) {
      throw new Error("Send file chunk hashes are invalid.");
    }
    hashes.push(descriptor.value);
  }
  return hashes;
}

function ownDataMethod(value: object, key: string): unknown {
  let cursor: object | null = value;
  let depth = 0;
  while (cursor && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    cursor = Object.getPrototypeOf(cursor);
    depth += 1;
  }
  return undefined;
}

type ReceiveState = {
  id: number;
  name: string;
  size: number;
  finalPath: string;
  partPath: string;
  partDev: number;
  partIno: number;
  stream: fs.WriteStream;
  hash: Sha256;
  bytes: number;
  expectedSha256?: string;
  expectedSeq: number;
  done: boolean;
  finalizing: boolean;
};

export async function receiveFiles(
  control: RTCDataChannel,
  bulk: RTCDataChannel,
  keys: SessionKeys,
  outDir: string,
  json = false,
  quiet = false,
  idleTimeoutMs = TRANSFER_CONTROL_TIMEOUT_MS,
  acceptedManifest?: FileManifest,
  resume = false,
  redactOutput = false
): Promise<void> {
  const files = new Map<number, ReceiveState>();
  let manifest: TransferManifest | undefined;
  const expectedFiles = new Map<number, TransferManifest["files"][number]>();
  let totalBytes = 0;
  const progress: Progress = { totalBytes: 0, transferredBytes: 0, startedAt: Date.now(), json, quiet, redactOutput };
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  let failed = false;
  let completed = false;
  let allDoneSeen = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const maybeResolveDone = async () => {
    if (!allDoneSeen) return;
    for (const state of files.values()) {
      if (!state.done) return;
    }
    clearReceiveTimeout();
    await sendControl(control, keys, { t: "all-done-ok" });
    completed = true;
    resolveDone();
  };

  const clearReceiveTimeout = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const detachChannels = () => {
    control.onmessage = null;
    control.onclose = null;
    control.onerror = null;
    bulk.onmessage = null;
    bulk.onclose = null;
    bulk.onerror = null;
  };

  const closeChannels = () => {
    try {
      control.close();
    } catch {
      // The channel may already be closed.
    }
    try {
      bulk.close();
    } catch {
      // The channel may already be closed.
    }
  };

  const failTransfer = async (error: unknown) => {
    if (failed || completed) return;
    failed = true;
    clearReceiveTimeout();
    detachChannels();
    try {
      await sendControl(control, keys, abortControlMessage(error));
    } catch {
      // Best-effort peer notification; the local cleanup below is still authoritative.
    }
    closeChannels();
    rejectDone(error instanceof Error ? error : new Error(safeErrorMessage(error)));
  };

  const resetReceiveTimeout = () => {
    clearReceiveTimeout();
    if (failed || completed) return;
    idleTimer = setTimeout(() => {
      void failTransfer(new Error("Transfer timed out waiting for peer data."));
    }, idleTimeoutMs);
    unrefTimer(idleTimer);
  };

  let receiveQueue: Promise<void> = Promise.resolve();
  const enqueueReceiveTask = (task: () => Promise<void>): Promise<void> => {
    receiveQueue = receiveQueue.then(task, task);
    receiveQueue.catch(() => {});
    return receiveQueue;
  };

  const failOnChannelClose = () => {
    void failTransfer(new Error("Transfer channel closed before completion."));
  };
  const failOnChannelError = () => {
    void failTransfer(new Error("Transfer channel errored before completion."));
  };
  control.onclose = failOnChannelClose;
  bulk.onclose = failOnChannelClose;
  control.onerror = failOnChannelError;
  bulk.onerror = failOnChannelError;
  resetReceiveTimeout();

  const handleControlMessage = async (data: unknown) => {
    if (failed || completed) return;
    resetReceiveTimeout();
    try {
      const message = assertControlMessage(await openControl<unknown>(keys, data));
      if (message.t === "manifest") {
        if (manifest) throw new Error("Duplicate transfer manifest.");
        manifest = message;
        for (const file of message.files) expectedFiles.set(file.id, file);
        assertManifestWithinLimits({ files: message.files, fileCount: message.files.length, totalBytes: message.totalBytes });
        if (acceptedManifest) assertTransferManifestMatchesAccepted(acceptedManifest, message);
        totalBytes = message.totalBytes;
        progress.totalBytes = totalBytes;
      } else if (message.t === "file-begin") {
        if (!manifest) throw new Error("file-begin arrived before manifest.");
        const expected = expectedFiles.get(message.id);
        if (!expected) throw new Error(`file-begin for unexpected file ${message.id}`);
        if (files.has(message.id)) throw new Error(`Duplicate file-begin for file ${message.id}`);
        if (expected.name !== message.name || expected.size !== message.size) throw new Error(`file-begin does not match manifest for file ${message.id}`);
        assertFileWithinLimits(message.name, message.size);
        const { finalPath, partPath, handle, dev, ino, resumeBytes = 0, resumeHash } = await reserveOutputFile(outDir, message.name, { resume, size: message.size });
        const state: ReceiveState = {
          id: message.id,
          name: path.basename(finalPath),
          size: message.size,
          finalPath,
          partPath,
          partDev: dev,
          partIno: ino,
          stream: handle.createWriteStream({ start: resumeBytes, autoClose: false }),
          hash: resumeHash ?? createSha256(),
          bytes: resumeBytes,
          expectedSeq: resumeBytes === message.size ? Math.ceil(message.size / CHUNK_SIZE) : resumeBytes / CHUNK_SIZE,
          done: false,
          finalizing: false
        };
        state.stream.on("error", (error) => {
          void failTransfer(error);
        });
        files.set(message.id, state);
        await sendControl(control, keys, resumeBytes > 0 ? { t: "ready", id: message.id, offset: resumeBytes } : { t: "ready", id: message.id });
      } else if (message.t === "file-end") {
        const state = files.get(message.id);
        if (!state) throw new Error(`file-end for unknown file ${message.id}`);
        if (state.expectedSha256) throw new Error(`Duplicate file-end for file ${message.id}`);
        state.expectedSha256 = message.sha256;
        await maybeFinalize(state, control, keys);
        await maybeResolveDone();
      } else if (message.t === "all-done") {
        if (!manifest) throw new Error("all-done arrived before manifest.");
        if (allDoneSeen) throw new Error("Duplicate all-done control message.");
        if (files.size !== expectedFiles.size) throw new Error("Not all manifest files were transferred.");
        allDoneSeen = true;
        await maybeResolveDone();
      } else if (message.t === "abort") {
        throw remoteAbortError();
      } else {
        throw new Error(`Unexpected receiver control message: ${message.t}.`);
      }
    } catch (error) {
      await failTransfer(error);
    }
  };

  control.onmessage = (event) => enqueueReceiveTask(() => handleControlMessage(event.data));

  const handleBulkMessage = async (data: unknown) => {
    if (failed || completed) return;
    resetReceiveTimeout();
    try {
      const frame = decodeChunk(toBytes(data));
      const state = files.get(frame.fileId);
      if (!state) throw new Error(`chunk for unknown file ${frame.fileId}`);
      if (state.done || (state.expectedSha256 && state.bytes >= state.size)) throw new Error(`chunk for completed file ${frame.fileId}`);
      if (frame.chunkSeq !== state.expectedSeq) throw new Error(`Unexpected chunk sequence for ${state.name}.`);
      const payload = await openBulk(keys, frame.fileId, frame.chunkSeq, frame.payload);
      try {
        if (payload.byteLength === 0) throw new Error(`Empty chunk for ${state.name}.`);
        if (state.bytes + payload.byteLength > state.size) throw new Error(`Received more bytes than declared for ${state.name}.`);
        state.expectedSeq += 1;
        state.hash.update(payload);
        state.bytes += payload.byteLength;
        progress.transferredBytes += payload.byteLength;
        await writeStreamChunk(state.stream, payload);
        printProgress("received", state.name, progress);
        await maybeFinalize(state, control, keys);
        await maybeResolveDone();
      } finally {
        payload.fill(0);
        frame.payload.fill(0);
      }
    } catch (error) {
      await failTransfer(error);
    }
  };

  bulk.onmessage = (event) => enqueueReceiveTask(() => handleBulkMessage(event.data));

  let doneError: unknown;
  try {
    await done;
  } catch (error) {
    doneError = error;
    throw error;
  } finally {
    clearReceiveTimeout();
    detachChannels();
    if (!failed) printProgress("received", "complete", progress, true);
    let cleanupError: unknown;
    for (const state of files.values()) {
      if (!state.done) {
        try {
          await discardPartialFile(state, resume);
        } catch (error) {
          cleanupError ??= error;
        }
      }
    }
    if (!doneError && cleanupError) throw cleanupError;
  }
}

async function sendControl(channel: RTCDataChannel, keys: SessionKeys, message: ControlMessage): Promise<void> {
  channel.send(await sealControl(keys, message));
}

async function maybeFinalize(state: ReceiveState, control: RTCDataChannel, keys: SessionKeys): Promise<void> {
  if (state.done || state.finalizing || !state.expectedSha256 || state.bytes < state.size) return;
  state.finalizing = true;
  try {
    await new Promise<void>((resolve, reject) => state.stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
    const actual = digestHex(state.hash);
    if (actual !== state.expectedSha256) {
      await removePathIfIdentity(state.partPath, { dev: state.partDev, ino: state.partIno });
      throw new Error(`Hash mismatch for ${state.name}.`);
    }
    const onDisk = await digestFilePath(state.partPath, undefined, state.size);
    if (onDisk !== state.expectedSha256) {
      await removePathIfIdentity(state.partPath, { dev: state.partDev, ino: state.partIno });
      throw new Error(`On-disk hash mismatch for ${state.name}.`);
    }
    const publishedIdentity = await publishPartFile(state.partPath, state.finalPath, { dev: state.partDev, ino: state.partIno }, state.size);
    const published = await digestFilePath(state.finalPath, publishedIdentity, state.size);
    if (published !== state.expectedSha256) {
      await removePathIfIdentity(state.finalPath, publishedIdentity);
      throw new Error(`Published file hash mismatch for ${state.name}.`);
    }
    state.done = true;
    await sendControl(control, keys, { t: "file-ok", id: state.id });
  } catch (error) {
    state.finalizing = false;
    throw error;
  }
}

async function discardPartialFile(state: ReceiveState, keepPartial = false): Promise<void> {
  const close = onceStreamClose(state.stream);
  state.stream.destroy();
  await close;
  if (keepPartial) return;
  await removePathIfIdentity(state.partPath, { dev: state.partDev, ino: state.partIno });
}

function onceStreamClose(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", resolve);
  });
}

function writeStreamChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

async function digestFilePath(filePath: string, expectedIdentity?: FileIdentity, expectedSize?: number): Promise<string> {
  const pathIdentity = await fileIdentity(filePath);
  if (expectedIdentity && !sameIdentity(pathIdentity, expectedIdentity)) throw new Error("File path changed before verification.");
  const handle = await fs.promises.open(filePath, NOFOLLOW_READ_FLAGS);
  const hash = createSha256();
  let bytesRead = 0;
  try {
    const stat = await handle.stat();
    if (!sameFileIdentity(stat, pathIdentity)) throw new Error("File path changed before verification.");
    if (expectedSize !== undefined && stat.size !== expectedSize) throw new Error("File size changed before verification.");
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      const payload = toBytes(chunk);
      try {
        if (expectedSize !== undefined && bytesRead + payload.byteLength > expectedSize) throw new Error("File size changed before verification.");
        hash.update(payload);
        bytesRead += payload.byteLength;
      } finally {
        payload.fill(0);
      }
    }
    if (expectedSize !== undefined && bytesRead !== expectedSize) throw new Error("File size changed before verification.");
    return digestHex(hash);
  } finally {
    await handle.close();
  }
}

type FileIdentity = {
  dev: number;
  ino: number;
};

type PathIdentity = FileIdentity & {
  mode: number;
};

export async function publishPartFile(partPath: string, finalPath: string, expectedPart?: FileIdentity, expectedSize?: number): Promise<FileIdentity> {
  const safePartPath = publishPathInput(partPath, "Partial");
  const safeFinalPath = publishPathInput(finalPath, "Final");
  const safeExpectedPart = expectedPart === undefined ? undefined : fileIdentityInput(expectedPart);
  const safeExpectedSize = expectedSize === undefined ? undefined : publishExpectedSizeInput(expectedSize);
  const partIdentity = safeExpectedPart ?? (await fileIdentity(safePartPath));
  let finalIdentity: FileIdentity | undefined;
  try {
    await assertPartFileIdentity(safePartPath, partIdentity, safeExpectedSize);
    try {
      finalIdentity = await linkPartFileExclusive(safePartPath, safeFinalPath, partIdentity, safeExpectedSize);
    } catch (error) {
      if (!shouldFallbackToExclusiveCopy(error)) throw error;
      finalIdentity = await copyPartFileExclusive(safePartPath, safeFinalPath, partIdentity, safeExpectedSize);
    }
    await assertPublishedFileIdentity(safeFinalPath, finalIdentity, safeExpectedSize);
    await removePathIfIdentity(safePartPath, partIdentity);
    return finalIdentity;
  } catch (error) {
    if (finalIdentity) {
      try {
        await removePathIfIdentity(safeFinalPath, finalIdentity);
      } catch {
        // Preserve the original publish failure.
      }
    }
    throw error;
  }
}

function publishPathInput(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} path is invalid.`);
  if (value.trim().length === 0) throw new Error(`${label} path is required.`);
  if (utf8ByteLengthExceeds(value, MAX_PUBLISH_PATH_BYTES)) throw new Error(`${label} path is too long.`);
  if (UNSAFE_PUBLISH_PATH_CHARS.test(value)) throw new Error(`${label} path must not contain control or format characters.`);
  return value;
}

function utf8ByteLengthExceeds(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

function fileIdentityInput(value: unknown): FileIdentity {
  if (!value || typeof value !== "object") throw new Error("Expected partial identity is invalid.");
  const dev = ownDataValue(value, "dev");
  const ino = ownDataValue(value, "ino");
  if (!Number.isSafeInteger(dev) || typeof dev !== "number" || dev < 0 || !Number.isSafeInteger(ino) || typeof ino !== "number" || ino < 0) {
    throw new Error("Expected partial identity is invalid.");
  }
  return { dev, ino };
}

function publishExpectedSizeInput(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) throw new Error("Expected publish size is invalid.");
  return value;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function linkPartFileExclusive(partPath: string, finalPath: string, expected: FileIdentity, expectedSize?: number): Promise<FileIdentity> {
  await fs.promises.link(partPath, finalPath);
  const finalStat = await fs.promises.lstat(finalPath);
  const finalPathIdentity = pathIdentity(finalStat);
  if (!sameFileIdentity(finalStat, expected) || (expectedSize !== undefined && finalStat.size !== expectedSize)) {
    try {
      await removePathIfPathIdentity(finalPath, finalPathIdentity);
    } catch {
      // Preserve the original publish failure.
    }
    throw new Error("Partial file changed before publish.");
  }
  return { dev: finalStat.dev, ino: finalStat.ino };
}

const NOFOLLOW_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const MAX_PUBLISH_PATH_BYTES = 4096;
const UNSAFE_PUBLISH_PATH_CHARS = /[\p{Cc}\p{Cf}]/u;

async function copyPartFileExclusive(partPath: string, finalPath: string, expected: FileIdentity, expectedSize?: number): Promise<FileIdentity> {
  const source = await openPartFileNoFollow(partPath);
  let target: fs.promises.FileHandle | undefined;
  let targetIdentity: FileIdentity | undefined;
  let targetClosed = false;
  try {
    const sourceStat = await source.stat();
    if (!sameFileIdentity(sourceStat, expected)) throw new Error("Partial file changed before publish.");
    if (expectedSize !== undefined && sourceStat.size !== expectedSize) throw new Error("Partial file changed before publish.");
    target = await fs.promises.open(finalPath, "wx", 0o600);
    const targetStat = await target.stat();
    targetIdentity = { dev: targetStat.dev, ino: targetStat.ino };
    await copyOpenFile(source, target, expectedSize);
    const afterCopySourceStat = await source.stat();
    if (!sameFileIdentity(afterCopySourceStat, expected)) throw new Error("Partial file changed before publish.");
    if (expectedSize !== undefined && afterCopySourceStat.size !== expectedSize) throw new Error("Partial file changed before publish.");
    const afterCopyTargetStat = await target.stat();
    if (expectedSize !== undefined && afterCopyTargetStat.size !== expectedSize) throw new Error("Partial file changed before publish.");
    await target.close();
    targetClosed = true;
    return targetIdentity;
  } catch (error) {
    if (target && !targetClosed) {
      try {
        await target.close();
        targetClosed = true;
      } catch {
        // Preserve the original copy failure.
      }
    }
    if (targetIdentity) {
      try {
        await removePathIfIdentity(finalPath, targetIdentity);
      } catch {
        // Preserve the original copy failure.
      }
    }
    throw error;
  } finally {
    await source.close();
    if (target && !targetClosed) {
      try {
        await target.close();
      } catch {
        // The handle may already be closed after a failed copy.
      }
    }
  }
}

async function assertPublishedFileIdentity(finalPath: string, expected: FileIdentity, expectedSize?: number): Promise<void> {
  const stat = await fs.promises.lstat(finalPath);
  if (!sameFileIdentity(stat, expected) || (expectedSize !== undefined && stat.size !== expectedSize)) {
    throw new Error("Published path changed before verification.");
  }
}

async function openPartFileNoFollow(partPath: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(partPath, NOFOLLOW_READ_FLAGS);
  } catch (error) {
    if (nodeErrorCode(error) === "ELOOP") {
      throw new Error("Partial file changed before publish.");
    }
    throw error;
  }
}

async function copyOpenFile(source: fs.promises.FileHandle, target: fs.promises.FileHandle, expectedSize?: number): Promise<void> {
  const scratch = Buffer.alloc(64 * 1024);
  try {
    let position = 0;
    while (true) {
      const readLength = expectedSize === undefined ? scratch.length : Math.min(scratch.length, expectedSize - position);
      if (readLength <= 0) break;
      const { bytesRead } = await source.read(scratch, 0, readLength, position);
      if (bytesRead === 0) break;
      await writeAll(target, scratch, bytesRead);
      scratch.subarray(0, bytesRead).fill(0);
      position += bytesRead;
    }
    if (expectedSize !== undefined) {
      if (position !== expectedSize) throw new Error("Partial file changed before publish.");
      const { bytesRead } = await source.read(scratch, 0, 1, expectedSize);
      if (bytesRead !== 0) throw new Error("Partial file changed before publish.");
    }
  } finally {
    scratch.fill(0);
  }
}

async function writeAll(target: fs.promises.FileHandle, buffer: Buffer, length: number): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await target.write(buffer, written, length - written);
    if (result.bytesWritten <= 0) throw new Error("Could not write copied partial file.");
    written += result.bytesWritten;
  }
}

async function assertPartFileIdentity(partPath: string, expected: FileIdentity, expectedSize?: number): Promise<void> {
  const stat = await fs.promises.lstat(partPath);
  if (!sameFileIdentity(stat, expected) || (expectedSize !== undefined && stat.size !== expectedSize)) {
    throw new Error("Partial file changed before publish.");
  }
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile()) throw new Error("Published path is not a file.");
  return { dev: stat.dev, ino: stat.ino };
}

function pathIdentity(stat: fs.Stats): PathIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

async function removePathIfIdentity(filePath: string, expected: FileIdentity): Promise<void> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (sameFileIdentity(stat, expected)) await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

async function removePathIfPathIdentity(filePath: string, expected: PathIdentity): Promise<void> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (samePathIdentity(stat, expected)) await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

function sameFileIdentity(stat: fs.Stats, expected: FileIdentity): boolean {
  return stat.isFile() && sameIdentity(stat, expected);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePathIdentity(stat: fs.Stats, expected: PathIdentity): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.mode === expected.mode;
}

export function shouldFallbackToExclusiveCopy(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code !== undefined && LINK_FALLBACK_ERROR_CODES.has(code);
}

const LINK_FALLBACK_ERROR_CODES = new Set([
  "EACCES",
  "EINVAL",
  "EMLINK",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EXDEV"
]);

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer && Object.getPrototypeOf(data) === ArrayBuffer.prototype) return new Uint8Array(data);
  if (data instanceof Uint8Array && isCanonicalDataChannelBytes(data)) return data;
  throw new Error("Unsupported binary chunk type");
}

function isCanonicalDataChannelBytes(data: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return false;
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(data);
  return Number.isSafeInteger(byteLength) && byteLength >= 0;
}

function printProgress(action: string, label: string, progress: Progress, force = false): void {
  const elapsed = Math.max((Date.now() - progress.startedAt) / 1000, 0.1);
  const rate = progress.transferredBytes / elapsed;
  const safeLabel = progress.redactOutput && label !== "complete" ? "[redacted]" : sanitizeDisplayText(label);
  if (progress.json) {
    if (force) {
      const event = progress.redactOutput ? { event: action, label: safeLabel } : { event: action, label: safeLabel, bytes: progress.transferredBytes, totalBytes: progress.totalBytes };
      console.log(JSON.stringify(sanitizeStructuredOutput(event)));
    }
    return;
  }
  if (progress.quiet) return;
  if (progress.redactOutput) {
    if (force) process.stdout.write(`\n${action} ${safeLabel}\n`);
    return;
  }
  if (!force && process.stdout.isTTY) {
    process.stdout.write(
      `\r${action} ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)} (${formatRate(rate)})`
    );
  } else if (force) {
    process.stdout.write(`\n${action} ${safeLabel}: ${formatBytes(progress.transferredBytes)} total\n`);
  }
}
