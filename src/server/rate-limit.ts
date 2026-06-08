import { ICE_CONFIG_MAX_REQUESTS_PER_MINUTE, TURN_REST_CREDENTIALS_MAX_ISSUES_PER_MINUTE } from "../shared/constants.js";

const MAX_RATE_LIMIT_RETAINED_HITS = 100_000;

export function hitFixedWindowRateLimit(hits: Map<string, number[]>, key: string, now: number, windowMs: number, maxHits: number): boolean {
  const result = recordFixedWindowHit(hits.get(key) ?? [], now, windowMs, maxHits);
  hits.set(key, result.hits);
  return result.allowed;
}

export function recordFixedWindowHit(values: readonly number[], now: number, windowMs: number, maxHits: number): { allowed: boolean; hits: number[] } {
  if (!rateLimitInputsAllowed(values, now, windowMs, maxHits)) return { allowed: false, hits: [] };
  const maxRetained = maxHits + 1;
  const recent: number[] = [];
  for (let index = values.length - 1; index >= 0 && recent.length < maxRetained; index -= 1) {
    const time = ownNumberArrayValue(values, index);
    if (time === undefined) return { allowed: false, hits: [now] };
    if (now - time >= windowMs) break;
    recent.push(time);
  }
  recent.reverse();
  recent.push(now);
  if (recent.length > maxRetained) recent.splice(0, recent.length - maxRetained);
  return { allowed: recent.length <= maxHits, hits: recent };
}

export function hitIceConfigRateLimit(hits: Map<string, number[]>, key: string, now = Date.now()): boolean {
  return hitFixedWindowRateLimit(hits, key, now, 60_000, ICE_CONFIG_MAX_REQUESTS_PER_MINUTE);
}

export function hitTurnCredentialIssueRateLimit(hits: Map<string, number[]>, key: string, now = Date.now()): boolean {
  return hitFixedWindowRateLimit(hits, key, now, 60_000, TURN_REST_CREDENTIALS_MAX_ISSUES_PER_MINUTE);
}

export function pruneFixedWindowRateLimits(hits: Map<string, number[]>, now: number, windowMs: number): void {
  if (!isSafeNonNegativeInteger(now) || !isSafePositiveInteger(windowMs)) return;
  for (const [key, values] of hits) {
    const recent = retainRecentSortedHits(values, now, windowMs);
    recent.length > 0 ? hits.set(key, recent) : hits.delete(key);
  }
}

function retainRecentSortedHits(values: readonly number[], now: number, windowMs: number): number[] {
  if (!Array.isArray(values)) return [];
  let start = values.length;
  while (start > 0) {
    const time = ownNumberArrayValue(values, start - 1);
    if (time === undefined || now - time >= windowMs) break;
    start -= 1;
  }
  const recent: number[] = [];
  for (let index = start; index < values.length; index += 1) {
    const time = ownNumberArrayValue(values, index);
    if (time === undefined) return [];
    recent.push(time);
  }
  return recent;
}

function rateLimitInputsAllowed(values: readonly number[], now: number, windowMs: number, maxHits: number): boolean {
  return Array.isArray(values) && isSafeNonNegativeInteger(now) && isSafePositiveInteger(windowMs) && isSafeBoundedHitCount(maxHits);
}

function isSafeBoundedHitCount(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value < MAX_RATE_LIMIT_RETAINED_HITS;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ownNumberArrayValue(value: readonly number[], index: number): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor && "value" in descriptor && isSafeNonNegativeInteger(descriptor.value) ? descriptor.value : undefined;
}
