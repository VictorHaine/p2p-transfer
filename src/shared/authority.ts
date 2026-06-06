const UNSAFE_AUTHORITY_CHARS = /[\p{Cc}\p{Cf}\s,\/\\@]/u;
const MAX_AUTHORITY_CHARS = 255;

export type ParsedAuthority = {
  name: string;
  port: string | undefined;
};

export function isValidHostname(host: string): boolean {
  if (typeof host !== "string") return false;
  if (host.length === 0 || host.length > 253 || host === "." || host.endsWith(".")) return false;
  return host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9-]+$/i.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

export function isAmbiguousNumericHost(host: string): boolean {
  if (typeof host !== "string") return false;
  return /^\d+$/.test(host) || /^\d+(?:\.\d+){1,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

export function isValidHostNameOrIp(host: string): boolean {
  if (typeof host !== "string" || !host || host.length > 253) return false;
  if (isStrictDottedIpv4(host) || isRawIpv6Address(host)) return true;
  if (host.includes(":") || host.includes("[") || host.includes("]")) return false;
  if (isAmbiguousNumericHost(host)) return false;
  return isValidHostname(host);
}

export function isValidOriginHostname(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  if (hostname.length === 0 || hostname.length > MAX_AUTHORITY_CHARS) return false;
  const bracketedIpv6 = /^\[(.*)\]$/.exec(hostname);
  if (bracketedIpv6) {
    const inner = bracketedIpv6[1];
    return typeof inner === "string" && isRawIpv6Address(inner);
  }
  return isValidHostNameOrIp(hostname);
}

export function isValidAuthority(authority: string): boolean {
  if (!authorityInputAllowed(authority)) return false;
  const parsed = splitAuthority(authority);
  if (!parsed) return false;
  if (parsed.name.startsWith("[") && parsed.name.endsWith("]")) return isValidBracketedIpv6(parsed.name);
  return isValidHostNameOrIp(parsed.name);
}

export function splitAuthority(authority: string): ParsedAuthority | null {
  if (!authorityInputAllowed(authority)) return null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close <= 1) return null;
    const name = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest === "") return { name, port: undefined };
    if (!rest.startsWith(":") || !isValidPort(rest.slice(1))) return null;
    return { name, port: rest.slice(1) };
  }
  const firstColon = authority.indexOf(":");
  if (firstColon === -1) return { name: authority, port: undefined };
  if (firstColon !== authority.lastIndexOf(":")) return null;
  const name = authority.slice(0, firstColon);
  const port = authority.slice(firstColon + 1);
  if (!isValidPort(port)) return null;
  return { name, port };
}

export function isLoopbackAuthority(authority: string): boolean {
  const parsed = splitAuthority(authority);
  if (!parsed) return false;
  const host = parsed.name.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function authorityInputAllowed(authority: string): boolean {
  return typeof authority === "string" && authority.length > 0 && authority.length <= MAX_AUTHORITY_CHARS && !UNSAFE_AUTHORITY_CHARS.test(authority);
}

function isStrictDottedIpv4(host: string): boolean {
  if (typeof host !== "string") return false;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isRawIpv6Address(host: string): boolean {
  if (typeof host !== "string") return false;
  if (!host.includes(":") || host.includes("[") || host.includes("]")) return false;
  try {
    const parsed = new URL(`http://[${host}]`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") && parsed.hostname.includes(":");
  } catch {
    return false;
  }
}

function isValidBracketedIpv6(host: string): boolean {
  if (typeof host !== "string") return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") && parsed.hostname.includes(":");
  } catch {
    return false;
  }
}
