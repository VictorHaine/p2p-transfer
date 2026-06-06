import { wordlist } from "@scure/bip39/wordlists/english.js";

export const RENDEZVOUS_DIGITS = 8;
export const MAX_CODE_INPUT_CHARS = 256;
const RENDEZVOUS_SPACE = 10 ** RENDEZVOUS_DIGITS;
const RENDEZVOUS_PATTERN = new RegExp(`^[0-9]{${RENDEZVOUS_DIGITS}}$`);
const CODE_PATTERN = new RegExp(`^(?<rendezvous>[0-9]{${RENDEZVOUS_DIGITS}})-(?<wordA>[a-z]+)-(?<wordB>[a-z]+)$`);

export function generateCode(): string {
  const wordA = wordlist[randomIndex(wordlist.length)]!;
  const wordB = randomWordExcept(wordA);
  return `${randomNameplate()}-${wordA}-${wordB}`;
}

export function normalizeCode(code: unknown): string {
  if (typeof code !== "string") return "";
  if (code.length > MAX_CODE_INPUT_CHARS) return "";
  return code.trim().toLowerCase();
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
  return String(randomIndex(RENDEZVOUS_SPACE)).padStart(RENDEZVOUS_DIGITS, "0");
}

function randomWordExcept(disallowed: string): string {
  for (;;) {
    const word = wordlist[randomIndex(wordlist.length)]!;
    if (word !== disallowed) return word;
  }
}
