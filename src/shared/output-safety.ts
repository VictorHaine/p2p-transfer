const UNSAFE_DISPLAY_CHARS = /[\p{Cc}\p{Cf}]/gu;
const MAX_DISPLAY_TEXT_CHARS = 4096;
const MAX_STRUCTURED_OUTPUT_DEPTH = 32;
const MAX_STRUCTURED_OUTPUT_NODES = 10_000;
const TRUNCATED_OUTPUT_VALUE = "[Truncated]";
const CIRCULAR_OUTPUT_VALUE = "[Circular]";

type StructuredSanitizeContext = {
  seen: WeakSet<object>;
  remainingNodes: number;
};

export function sanitizeDisplayText(value: unknown): string {
  if (typeof value !== "string") return TRUNCATED_OUTPUT_VALUE;
  const bounded = value.length > MAX_DISPLAY_TEXT_CHARS ? `${value.slice(0, MAX_DISPLAY_TEXT_CHARS)}${TRUNCATED_OUTPUT_VALUE}` : value;
  return bounded.replace(UNSAFE_DISPLAY_CHARS, " ").replace(/[ \t]{2,}/g, " ").trim();
}

export function sanitizeStructuredOutput<T>(value: T): T {
  return sanitizeStructuredValue(value, { seen: new WeakSet<object>(), remainingNodes: MAX_STRUCTURED_OUTPUT_NODES }, 0) as T;
}

function sanitizeStructuredValue(value: unknown, context: StructuredSanitizeContext, depth: number): unknown {
  if (depth >= MAX_STRUCTURED_OUTPUT_DEPTH || context.remainingNodes <= 0) return TRUNCATED_OUTPUT_VALUE;
  context.remainingNodes -= 1;
  if (typeof value === "string") return sanitizeDisplayText(value);
  if (typeof value === "number" && !Number.isFinite(value)) return TRUNCATED_OUTPUT_VALUE;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return TRUNCATED_OUTPUT_VALUE;
  if (typeof value !== "object" || value === null) return value;
  const recurse = Array.isArray(value) || isPlainObject(value);
  if (!recurse) return TRUNCATED_OUTPUT_VALUE;
  if (context.seen.has(value)) return CIRCULAR_OUTPUT_VALUE;
  context.seen.add(value);
  try {
    if (Array.isArray(value)) return sanitizeStructuredArray(value, context, depth);
    if (isPlainObject(value)) return sanitizeStructuredRecord(value, context, depth);
    return value;
  } finally {
    context.seen.delete(value);
  }
}

function sanitizeStructuredArray(value: unknown[], context: StructuredSanitizeContext, depth: number): unknown[] {
  const out: unknown[] = [];
  shadowJsonStringifyHook(out);
  for (let index = 0; index < value.length; index += 1) {
    if (context.remainingNodes <= 0) {
      out.push(TRUNCATED_OUTPUT_VALUE);
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      out.push(sanitizeStructuredValue(undefined, context, depth + 1));
      continue;
    }
    out.push("value" in descriptor ? sanitizeStructuredValue(descriptor.value, context, depth + 1) : sanitizeStructuredValue(TRUNCATED_OUTPUT_VALUE, context, depth + 1));
  }
  return out;
}

function sanitizeStructuredRecord(value: Record<string, unknown>, context: StructuredSanitizeContext, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keyCounts = new Map<string, number>();
  let hasOwnToJson = false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (key === "toJSON") hasOwnToJson = true;
    if (context.remainingNodes <= 0) {
      Object.defineProperty(out, safeOutputKey(out, "truncated", keyCounts), {
        value: TRUNCATED_OUTPUT_VALUE,
        enumerable: true,
        configurable: true,
        writable: true
      });
      break;
    }
    Object.defineProperty(out, safeOutputKey(out, key, keyCounts), {
      value: "value" in descriptor ? sanitizeStructuredValue(descriptor.value, context, depth + 1) : sanitizeStructuredValue(TRUNCATED_OUTPUT_VALUE, context, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  if (!hasOwnToJson) shadowJsonStringifyHook(out);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shadowJsonStringifyHook(value: object): void {
  Object.defineProperty(value, "toJSON", {
    value: TRUNCATED_OUTPUT_VALUE,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function safeOutputKey(out: Record<string, unknown>, key: string, keyCounts: Map<string, number>): string {
  const base = sanitizeDisplayText(key) || "_";
  let index = keyCounts.get(base) ?? 0;
  let candidate = index === 0 ? base : `${base}_${index}`;
  while (Object.prototype.hasOwnProperty.call(out, candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  keyCounts.set(base, index + 1);
  return candidate;
}
