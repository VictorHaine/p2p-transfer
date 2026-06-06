import { CHUNK_SIZE } from "./constants.js";

const AES_GCM_TAG_BYTES = 16;
const SEALED_CHUNK_SIZE = CHUNK_SIZE + AES_GCM_TAG_BYTES;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

export type ChunkFrame = {
  fileId: number;
  chunkSeq: number;
  payload: Uint8Array;
};

export function encodeChunk(fileId: number, chunkSeq: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 255) throw new Error("fileId must fit in uint8");
  if (!Number.isInteger(chunkSeq) || chunkSeq < 0 || chunkSeq > 0xffffffff) throw new Error("chunkSeq must fit in uint32");
  const payloadByteLength = assertUint8Array(payload, "payload");
  if (payloadByteLength > SEALED_CHUNK_SIZE) throw new Error("payload exceeds chunk frame size");
  const frame = new Uint8Array(9 + payloadByteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, fileId);
  view.setUint32(1, chunkSeq, false);
  view.setUint32(5, payloadByteLength, false);
  frame.set(payload, 9);
  return frame.buffer;
}

export function decodeChunk(input: ArrayBuffer | Uint8Array): ChunkFrame {
  const bytes = chunkFrameBytes(input);
  const byteLength = bytes.byteLength;
  if (byteLength < 9) throw new Error("chunk frame is too small");
  const view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
  const fileId = view.getUint8(0);
  const chunkSeq = view.getUint32(1, false);
  const payloadLen = view.getUint32(5, false);
  if (payloadLen !== byteLength - 9) throw new Error("chunk payload length mismatch");
  if (payloadLen > SEALED_CHUNK_SIZE) throw new Error("chunk payload exceeds maximum size");
  return { fileId, chunkSeq, payload: bytes.subarray(9) };
}

function chunkFrameBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) {
    assertUint8Array(input, "chunk frame");
    return input;
  }
  if (input instanceof ArrayBuffer && Object.getPrototypeOf(input) === ArrayBuffer.prototype) {
    return new Uint8Array(input);
  }
  return invalidChunkInput();
}

function assertUint8Array(value: unknown, label: string): number {
  if (!(value instanceof Uint8Array) || !isCanonicalBinaryPrototype(value) || !TYPED_ARRAY_BYTE_LENGTH_GETTER) {
    throw new Error(`${label} must be a Uint8Array`);
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error(`${label} must be a Uint8Array`);
  return byteLength;
}

function isCanonicalBinaryPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Uint8Array.prototype) return true;
  return typeof Buffer !== "undefined" && prototype === Buffer.prototype;
}

function invalidChunkInput(): never {
  throw new Error("chunk frame must be an ArrayBuffer or Uint8Array");
}
