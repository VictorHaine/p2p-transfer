import { isLoopbackAuthority, isValidAuthority } from "./authority.js";

const MAX_SIGNALING_SERVER_URL_BYTES = 2048;

export function normalizeSignalingServerUrl(raw: string): string {
  if (typeof raw !== "string" || utf8ByteLengthExceeds(raw, MAX_SIGNALING_SERVER_URL_BYTES)) {
    throw new Error(`Signaling server URL must be at most ${MAX_SIGNALING_SERVER_URL_BYTES} bytes.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Signaling server URL is required.");
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    throw new Error("Signaling server URL must not contain control or format characters.");
  }
  const authority = rawWebSocketAuthority(trimmed);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Signaling server URL must be a valid ws:// or wss:// URL.");
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Signaling server URL must use ws:// or wss://.");
  }
  if (url.username || url.password) {
    throw new Error("Signaling server URL must not include credentials.");
  }
  if (url.search) {
    throw new Error("Signaling server URL must not include a query string.");
  }
  if (url.hash) {
    throw new Error("Signaling server URL must not include a fragment.");
  }
  if (url.pathname !== "/v1/ws") {
    throw new Error("Signaling server URL path must be /v1/ws.");
  }
  if (!authority || !isValidAuthority(authority)) {
    throw new Error("Signaling server URL must include a valid hostname or IP address.");
  }
  if (url.protocol === "ws:" && !isLoopbackAuthority(authority)) {
    throw new Error("Plain ws:// signaling is only allowed for localhost. Use wss:// for remote signaling servers.");
  }

  return url.href;
}

function rawWebSocketAuthority(url: string): string | null {
  const match = /^(?:ws|wss):\/\/([^/?#]*)/i.exec(url);
  return match?.[1] ?? null;
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
