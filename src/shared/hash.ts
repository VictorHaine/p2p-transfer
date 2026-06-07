import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type Sha256 = ReturnType<typeof sha256.create>;

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

export function createSha256(): Sha256 {
  return sha256.create();
}

export function digestHex(hash: Sha256): string {
  const digest = hashDigestMethod(hash);
  const bytes = digest.call(hash);
  assertCanonicalDigest(bytes);
  return bytesToHex(bytes);
}

export function digestCloneHex(hash: Sha256): string {
  const clone = hashCloneMethod(hash).call(hash);
  return digestHex(clone);
}

function hashDigestMethod(hash: unknown): () => Uint8Array {
  const method = ownOrInheritedDataValue(hash, "digest");
  if (typeof method !== "function") throw new Error("SHA-256 hash is invalid.");
  return method as () => Uint8Array;
}

function hashCloneMethod(hash: unknown): () => Sha256 {
  const method = ownOrInheritedDataValue(hash, "clone");
  if (typeof method !== "function") throw new Error("SHA-256 hash is invalid.");
  return method as () => Sha256;
}

function ownOrInheritedDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  let current: object | null = value;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

function assertCanonicalDigest(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || !isCanonicalBinaryPrototype(value) || !TYPED_ARRAY_BYTE_LENGTH_GETTER) throw new Error("SHA-256 digest is invalid.");
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  if (!Number.isSafeInteger(byteLength) || byteLength !== 32) throw new Error("SHA-256 digest is invalid.");
}

function isCanonicalBinaryPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Uint8Array.prototype) return true;
  return typeof Buffer !== "undefined" && prototype === Buffer.prototype;
}
