const MAX_CLOSE_REASON_BYTES = 123;

export function websocketCloseReason(reason: string): string {
  if (typeof reason !== "string") throw new Error("WebSocket close reason must be a string.");
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  for (const char of reason) {
    const clean = closeReasonChar(char);
    const length = encoder.encode(clean).byteLength;
    if (bytes + length > MAX_CLOSE_REASON_BYTES) break;
    out += clean;
    bytes += length;
  }
  return out;
}

function closeReasonChar(char: string): string {
  const code = char.codePointAt(0);
  return code === undefined || code <= 0x1f || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? " " : char;
}
