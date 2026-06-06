export type SecurityHeaderOptions = {
  allowAnyWss?: boolean;
  allowLoopbackWs?: boolean;
};

const LOOPBACK_WS_SOURCES = ["ws://localhost:*", "ws://127.0.0.1:*", "ws://[::1]:*"];

export function securityHeaders(html: boolean, options: SecurityHeaderOptions = {}): Record<string, string> {
  const safeOptions = securityHeaderOptions(options);
  const connectSrc = ["'self'", ...(safeOptions.allowAnyWss ? ["wss:"] : []), ...(safeOptions.allowLoopbackWs ? LOOPBACK_WS_SOURCES : [])].join(" ");
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ...(html === true
      ? {
          "content-security-policy":
            `default-src 'self'; script-src 'self'; script-src-elem 'self'; script-src-attr 'none'; style-src 'self'; style-src-elem 'self'; style-src-attr 'none'; connect-src ${connectSrc}; img-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; prefetch-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'none'; require-trusted-types-for 'script'; trusted-types ff-static`
        }
      : {})
  };
}

function securityHeaderOptions(options: SecurityHeaderOptions): Required<SecurityHeaderOptions> {
  if (!options || typeof options !== "object" || Array.isArray(options)) return { allowAnyWss: false, allowLoopbackWs: false };
  return {
    allowAnyWss: ownBooleanOption(options, "allowAnyWss"),
    allowLoopbackWs: ownBooleanOption(options, "allowLoopbackWs")
  };
}

function ownBooleanOption(options: object, key: keyof SecurityHeaderOptions): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
}
