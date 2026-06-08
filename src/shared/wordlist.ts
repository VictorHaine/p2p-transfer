import { wordlist } from "@scure/bip39/wordlists/english.js";

// Legacy supplied-code floor; new clients generate GENERATED_RENDEZVOUS_DIGITS.
export const RENDEZVOUS_DIGITS = 8;
export const GENERATED_RENDEZVOUS_DIGITS = 12;
export const MAX_CODE_INPUT_BYTES = 256;
export const MAX_CODE_INPUT_CHARS = MAX_CODE_INPUT_BYTES;
const GENERATED_RENDEZVOUS_CHUNK_DIGITS = 6;
const RENDEZVOUS_CHUNK_SPACE = 10 ** GENERATED_RENDEZVOUS_CHUNK_DIGITS;
const RENDEZVOUS_PATTERN = new RegExp(`^(?:[0-9]{${RENDEZVOUS_DIGITS}}|[0-9]{${GENERATED_RENDEZVOUS_DIGITS}})$`);
const CODE_PATTERN = new RegExp(`^(?<rendezvous>(?:[0-9]{${RENDEZVOUS_DIGITS}}|[0-9]{${GENERATED_RENDEZVOUS_DIGITS}}))-(?<wordA>[a-z]+)-(?<wordB>[a-z]+)$`);

export function generateCode(): string {
  const wordA = wordlist[randomIndex(wordlist.length)]!;
  const wordB = randomWordExcept(wordA);
  return `${randomNameplate()}-${wordA}-${wordB}`;
}

export function normalizeCode(code: unknown): string {
  if (typeof code !== "string") return "";
  if (codeInputUtf8ByteLengthExceeds(code)) return "";
  return code.trim().toLowerCase();
}

export function codeInputUtf8ByteLengthExceeds(value: string): boolean {
  return utf8ByteLengthExceeds(value, MAX_CODE_INPUT_BYTES);
}

export function isValidCode(code: unknown): boolean {
  return parseCode(code) !== null;
}

export type ParsedCode = {
  handle: string;
  rendezvous: string;
  secret: string;
};

export function parseCode(code: unknown): ParsedCode | null {
  const normalized = normalizeCode(code);
  const match = CODE_PATTERN.exec(normalized);
  if (!match?.groups) return null;
  const { rendezvous, wordA, wordB } = match.groups;
  if (!rendezvous || !wordA || !wordB) return null;
  if (wordA === wordB) return null;
  if (!wordlist.includes(wordA) || !wordlist.includes(wordB)) return null;
  const secret = `${wordA}-${wordB}`;
  return { handle: normalized, rendezvous, secret };
}

export function isValidRendezvous(value: unknown): boolean {
  return typeof value === "string" && RENDEZVOUS_PATTERN.test(value);
}

function randomIndex(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error("Random index bound must be a positive integer.");
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const array = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(array);
    const value = array[0]!;
    if (value < limit) return value % maxExclusive;
  }
}

function randomNameplate(): string {
  return `${randomNameplateChunk()}${randomNameplateChunk()}`;
}

function randomNameplateChunk(): string {
  return String(randomIndex(RENDEZVOUS_CHUNK_SPACE)).padStart(GENERATED_RENDEZVOUS_CHUNK_DIGITS, "0");
}

function randomWordExcept(disallowed: string): string {
  for (;;) {
    const word = wordlist[randomIndex(wordlist.length)]!;
    if (word !== disallowed) return word;
  }
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
