import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { requestBaseUrl, requestHostAuthority, requestMethod, requestOriginHeader, requestRemoteAddress, requestUrl } from "../src/server/request-headers.js";
import {
  requestBaseUrl as distRequestBaseUrl,
  requestHostAuthority as distRequestHostAuthority,
  requestMethod as distRequestMethod,
  requestOriginHeader as distRequestOriginHeader,
  requestRemoteAddress as distRequestRemoteAddress,
  requestUrl as distRequestUrl
} from "../dist-node/server/request-headers.js";
import fs from "node:fs";

const requestHeaderSource = fs.readFileSync(new URL("../src/server/request-headers.ts", import.meta.url), "utf8");
const distRequestHeaderSource = fs.readFileSync(new URL("../dist-node/server/request-headers.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const distServerSource = fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("request header parsing rejects duplicate or malformed Origin headers", () => {
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" })), "https://files.example");
  assert.equal(requestOriginHeader(req({ origin: "http://localhost:5173" })), "http://localhost:5173");
  assert.equal(requestOriginHeader(req({ origin: "http://[::1]:5173" })), "http://[::1]:5173");
  assert.equal(requestOriginHeader(req({})), undefined);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["O".repeat(65), "x", "Origin", "https://files.example"])), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["Bad Origin", "x", "Origin", "https://files.example"])), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["Bad\nOrigin", "x", "Origin", "https://files.example"])), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["Bad\u200bOrigin", "x", "Origin", "https://files.example"])), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", new Array(130).fill("X"))), null);
  assert.equal(requestOriginHeader(req({ origin: ["https://files.example", "https://evil.example"] } as unknown as http.IncomingHttpHeaders)), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["Origin", "https://files.example", "Origin", "https://evil.example"])), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example" }, "/", ["Origin"])), null);
  assert.equal(requestOriginHeader(req({ origin: "" })), null);
  assert.equal(requestOriginHeader(req({ origin: "null" })), null);
  assert.equal(requestOriginHeader(req({ origin: "wss://files.example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://bad_host" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://-files.example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files..example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example." })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example/path" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example:0" })), null);
  assert.equal(requestOriginHeader(req({ origin: "http://[::1]:0" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://user@files.example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example, https://evil.example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example\nhttps://evil.example" })), null);
  assert.equal(requestOriginHeader(req({ origin: "https://files.example\u200b" })), null);
});

test("request base URL requires one syntactically valid Host authority", () => {
  assert.equal(requestHostAuthority(req({ host: "files.example" })), "files.example");
  assert.equal(requestHostAuthority(req({ host: "files.example:8787" })), "files.example:8787");
  assert.equal(requestHostAuthority(req({ host: "[::1]:8787" })), "[::1]:8787");
  assert.equal(requestBaseUrl(req({ host: "files.example" })), "http://files.example");
  assert.equal(requestBaseUrl(req({ host: "files.example:8787" })), "http://files.example:8787");
  assert.equal(requestBaseUrl(req({ host: "FILES.example:80" })), "http://FILES.example:80");
  assert.equal(requestBaseUrl(req({ host: "[::1]:8787" })), "http://[::1]:8787");
  assert.equal(requestBaseUrl(req({ host: "127.0.0.1:8787" })), "http://127.0.0.1:8787");
  assert.equal(requestBaseUrl(req({})), null);
  assert.equal(requestBaseUrl(req({ host: ["files.example", "evil.example"] } as unknown as http.IncomingHttpHeaders)), null);
  assert.equal(requestHostAuthority(req({ host: ["files.example", "evil.example"] } as unknown as http.IncomingHttpHeaders)), null);
  assert.equal(requestBaseUrl(req({ host: "files.example" }, "/", ["Host", "files.example", "Host", "evil.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", ["Host", "files.example", "Host", "evil.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", ["H".repeat(65), "files.example", "Host", "files.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", ["Bad Host", "evil.example", "Host", "files.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", ["Bad\nHost", "evil.example", "Host", "files.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", ["Bad\u200bHost", "evil.example", "Host", "files.example"])), null);
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", new Array(130).fill("X"))), null);
  assert.equal(requestBaseUrl(req({ host: "files.example" }, "/", ["Host"])), null);
  assert.equal(requestBaseUrl(req({ host: "." })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example." })), null);
  assert.equal(requestBaseUrl(req({ host: "-files.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.-example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files..example" })), null);
  assert.equal(requestBaseUrl(req({ host: "bad_host.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example/path" })), null);
  assert.equal(requestBaseUrl(req({ host: "user@files.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "http://files.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example:abc" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example:0" })), null);
  assert.equal(requestBaseUrl(req({ host: "[::1]:0" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example:65536" })), null);
  assert.equal(requestBaseUrl(req({ host: "1.2.3" })), null);
  assert.equal(requestBaseUrl(req({ host: "0177.0.0.1" })), null);
  assert.equal(requestBaseUrl(req({ host: "2130706433" })), null);
  assert.equal(requestBaseUrl(req({ host: "0x7f000001" })), null);
  assert.equal(requestBaseUrl(req({ host: "::1" })), null);
  assert.equal(requestBaseUrl(req({ host: "[::1" })), null);
  assert.equal(requestBaseUrl(req({ host: "[not-ip]:8787" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example, evil.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example\nHost: evil.example" })), null);
  assert.equal(requestBaseUrl(req({ host: "files.example\u200b" })), null);
});

test("request URL parsing accepts only origin-form request targets", () => {
  assert.equal(requestUrl(req({ host: "files.example" }, "/healthz"))?.pathname, "/healthz");
  assert.equal(requestUrl(req({ host: "files.example" }, "/v1/version?x=1"))?.search, "?x=1");
  assert.equal(requestUrl(req({ host: "files.example" }, "http://evil.example/healthz")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "//evil.example/healthz")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "/\\evil.example/healthz")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "/foo\\bar")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "*")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "/bad\npath")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "/bad path")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "/bad\u200bpath")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, "")), null);
  assert.equal(requestUrl(req({ host: "files.example" }, `/${"😀".repeat(2048)}`)), null);
  assert.equal(distRequestUrl(req({ host: "files.example" }, `/${"😀".repeat(2048)}`)), null);
});

test("request method and remote address helpers reject accessors before routing or rate limits", () => {
  assert.equal(requestMethod(req({ host: "files.example" }, "/healthz", undefined, "GET")), "GET");
  assert.equal(distRequestMethod(req({ host: "files.example" }, "/healthz", undefined, "POST")), "POST");
  assert.equal(requestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", "203.0.113.1")), "203.0.113.1");
  assert.equal(distRequestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", "203.0.113.2")), "203.0.113.2");
  assert.equal(requestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", "::ffff:203.0.113.3")), "203.0.113.3");
  assert.equal(distRequestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", "::ffff:203.0.113.4")), "203.0.113.4");
  assert.equal(requestRemoteAddress(req({ host: "files.example" })), "unknown");
  assert.equal(distRequestRemoteAddress(req({ host: "files.example" })), "unknown");
  for (const badAddress of ["files.example", "203.0.113.5\n198.51.100.1", "203.0.113.5\u200b", " 203.0.113.5", "1".repeat(46), ""]) {
    assert.equal(requestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", badAddress)), "unknown");
    assert.equal(distRequestRemoteAddress(req({ host: "files.example" }, "/", undefined, "GET", badAddress)), "unknown");
  }

  let getterCalled = false;
  const methodAccessorRequest = req({ host: "files.example" }, "/");
  Object.defineProperty(methodAccessorRequest, "method", {
    get() {
      getterCalled = true;
      return "GET";
    }
  });
  assert.equal(requestMethod(methodAccessorRequest), null);
  assert.equal(distRequestMethod(methodAccessorRequest), null);

  const socketAccessorRequest = req({ host: "files.example" }, "/");
  Object.defineProperty(socketAccessorRequest, "socket", {
    get() {
      getterCalled = true;
      return { remoteAddress: "203.0.113.3" };
    }
  });
  assert.equal(requestRemoteAddress(socketAccessorRequest), "unknown");
  assert.equal(distRequestRemoteAddress(socketAccessorRequest), "unknown");

  const remoteAddressAccessorRequest = req({ host: "files.example" }, "/", undefined, "GET", "203.0.113.4");
  Object.defineProperty((remoteAddressAccessorRequest as { socket: object }).socket, "remoteAddress", {
    get() {
      getterCalled = true;
      return "203.0.113.5";
    }
  });
  assert.equal(requestRemoteAddress(remoteAddressAccessorRequest), "unknown");
  assert.equal(distRequestRemoteAddress(remoteAddressAccessorRequest), "unknown");
  assert.equal(getterCalled, false);
});

test("trusted proxy client IP parsing is explicit, bounded, and fail-closed", () => {
  const proxied = req({ host: "files.example", "x-forwarded-for": "198.51.100.9" }, "/", undefined, "GET", "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied), "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied, 1), "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied, 1, ["10.0.0.10"]), "198.51.100.9");
  assert.equal(distRequestRemoteAddress(proxied, 1, ["10.0.0.10"]), "198.51.100.9");
  assert.equal(requestRemoteAddress(proxied, 1, ["10.0.0.11"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied, 1, ["10.0.0.0/24"]), "198.51.100.9");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9" }, "/", undefined, "GET", "::ffff:10.0.0.10"), 1, ["10.0.0.10"]), "198.51.100.9");

  const chain = req({ host: "files.example", "x-forwarded-for": "198.51.100.9, 203.0.113.7" }, "/", undefined, "GET", "10.0.0.10");
  assert.equal(requestRemoteAddress(chain, 1, ["10.0.0.10"]), "203.0.113.7");
  assert.equal(requestRemoteAddress(chain, 2, ["10.0.0.10"]), "198.51.100.9");

  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "2001:db8::1" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "2001:db8::1");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "::ffff:198.51.100.9" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "198.51.100.9");
  assert.equal(distRequestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "::ffff:198.51.100.10" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "198.51.100.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9, bad-host" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9" }, "/", ["X-Forwarded-For", "198.51.100.9", "X-Forwarded-For", "203.0.113.7"], "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9\n203.0.113.7" }, "/", undefined, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9" }, "/", undefined, "GET", "10.0.0.10"), 4, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(requestRemoteAddress(req({ host: "files.example", "x-forwarded-for": "198.51.100.9" }, "/", undefined, "GET", "files.example"), 1, ["files.example"]), "unknown");

  const ipv6Proxy = req({ host: "files.example", "x-forwarded-for": "2001:db8::99" }, "/", undefined, "GET", "2001:db8:abcd::1");
  assert.equal(requestRemoteAddress(ipv6Proxy, 1, ["2001:db8:abcd::/48"]), "2001:db8::99");

  let getterCalled = false;
  const rawHeaders = ["X-Forwarded-For", "198.51.100.9"];
  Object.defineProperty(rawHeaders, "1", {
    get() {
      getterCalled = true;
      return "203.0.113.7";
    }
  });
  assert.equal(requestRemoteAddress(req({ host: "files.example" }, "/", rawHeaders, "GET", "10.0.0.10"), 1, ["10.0.0.10"]), "10.0.0.10");
  assert.equal(getterCalled, false);

  const trustedProxyIps = ["10.0.0.10"];
  Object.defineProperty(trustedProxyIps, "0", {
    get() {
      getterCalled = true;
      return "10.0.0.10";
    }
  });
  assert.equal(requestRemoteAddress(proxied, 1, trustedProxyIps), "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied, 1, ["10.0.0.10/33"]), "10.0.0.10");
  const hostileTrustedProxyIps = {};
  Object.defineProperty(hostileTrustedProxyIps, "length", {
    get() {
      getterCalled = true;
      return 1;
    }
  });
  assert.equal(requestRemoteAddress(proxied, 1, hostileTrustedProxyIps), "10.0.0.10");
  assert.equal(requestRemoteAddress(proxied, 1, new Array(33).fill("10.0.0.10")), "10.0.0.10");
  assert.equal(getterCalled, false);
});

test("request parsing rejects malformed rawHeaders and url fields before invoking methods", () => {
  let getterCalled = false;
  const hostileRawHeaderName = {
    toLowerCase() {
      getterCalled = true;
      return "host";
    }
  };
  const malformedRawHeaders = req({ host: "files.example" }, "/", [hostileRawHeaderName as never, "files.example"]);
  assert.equal(requestHostAuthority(malformedRawHeaders), null);
  assert.equal(requestBaseUrl(malformedRawHeaders), null);
  assert.equal(getterCalled, false);

  const rawHeadersAccessorRequest = { headers: { host: "files.example" }, url: "/" };
  Object.defineProperty(rawHeadersAccessorRequest, "rawHeaders", {
    get() {
      getterCalled = true;
      return ["Host", "files.example"];
    }
  });
  assert.equal(requestHostAuthority(rawHeadersAccessorRequest as http.IncomingMessage), null);

  const rawHeadersAccessorArray = ["Host", "files.example"];
  Object.defineProperty(rawHeadersAccessorArray, "0", {
    get() {
      getterCalled = true;
      return "Host";
    }
  });
  assert.equal(requestHostAuthority(req({ host: "files.example" }, "/", rawHeadersAccessorArray)), null);

  const headersAccessorRequest = { rawHeaders: ["Host", "files.example"], url: "/" };
  Object.defineProperty(headersAccessorRequest, "headers", {
    get() {
      getterCalled = true;
      return { host: "files.example" };
    }
  });
  assert.equal(requestHostAuthority(headersAccessorRequest as http.IncomingMessage), "files.example");

  const accessorHeaderMap = {};
  Object.defineProperty(accessorHeaderMap, "host", {
    get() {
      getterCalled = true;
      return "files.example";
    }
  });
  Object.defineProperty(accessorHeaderMap, "origin", {
    get() {
      getterCalled = true;
      return "https://files.example";
    }
  });
  const accessorHeadersRequest = { headers: accessorHeaderMap, rawHeaders: ["Host", "files.example", "Origin", "https://files.example"], url: "/" };
  assert.equal(requestHostAuthority(accessorHeadersRequest as http.IncomingMessage), "files.example");
  assert.equal(requestOriginHeader(accessorHeadersRequest as http.IncomingMessage), "https://files.example");

  assert.equal(requestHostAuthority({ headers: { host: "files.example" }, url: "/" } as http.IncomingMessage), null);
  assert.equal(requestOriginHeader({ headers: { origin: "https://files.example" }, url: "/" } as http.IncomingMessage), null);

  let startsWithCalled = false;
  const hostileUrl = {
    length: 8,
    startsWith() {
      startsWithCalled = true;
      return true;
    }
  };
  assert.equal(requestUrl(req({ host: "files.example" }, hostileUrl as never)), null);
  const urlAccessorRequest = { headers: { host: "files.example" }, rawHeaders: ["Host", "files.example"] };
  Object.defineProperty(urlAccessorRequest, "url", {
    get() {
      getterCalled = true;
      return "/healthz";
    }
  });
  assert.equal(requestUrl(urlAccessorRequest as http.IncomingMessage), null);
  assert.equal(startsWithCalled, false);
  assert.equal(getterCalled, false);
});

test("published server request parser rejects ambiguous authority and origin headers", () => {
  assert.equal(distRequestOriginHeader(req({ origin: "https://files.example" })), "https://files.example");
  assert.equal(distRequestOriginHeader(req({ origin: "https://files.example" }, "/", ["Origin", "https://files.example", "Origin", "https://evil.example"])), null);
  assert.equal(distRequestOriginHeader(req({ origin: ["https://files.example", "https://evil.example"] } as unknown as http.IncomingHttpHeaders)), null);
  assert.equal(distRequestOriginHeader(req({ origin: "https://files.example\u200b" })), null);

  assert.equal(distRequestHostAuthority(req({ host: "files.example:8787" })), "files.example:8787");
  assert.equal(distRequestBaseUrl(req({ host: "files.example" }, "/", ["Host", "files.example", "Host", "evil.example"])), null);
  assert.equal(distRequestBaseUrl(req({ host: "files.example:0" })), null);
  assert.equal(distRequestHostAuthority({ headers: { host: "files.example" }, url: "/" } as http.IncomingMessage), null);
  assert.equal(distRequestOriginHeader({ headers: { origin: "https://files.example" }, url: "/" } as http.IncomingMessage), null);
  assert.equal(distRequestUrl(req({ host: "files.example" }, "http://evil.example/healthz")), null);
  assert.equal(distRequestUrl(req({ host: "files.example" }, "/\\evil.example/healthz")), null);
  assert.equal(distRequestUrl(req({ host: "files.example" }, "/bad\u200bpath")), null);
  assert.equal(distRequestUrl(req({ host: "files.example" }, { startsWith: () => true } as never)), null);
});

test("request parser source keeps raw header and request target type guards", () => {
  assert.match(securityPolicy, /HTTP request parsers must reject missing or malformed `rawHeaders`, non-string request targets, and over-byte-budget origin\/request-target strings before duplicate-header or URL parsing/);
  assert.match(securityPolicy, /HTTP request parsers and server call sites must read request objects, raw header arrays, URL targets, methods, sockets, and remote addresses through own data descriptors and derive trusted header values from validated `rawHeaders`/);
  assert.match(securityPolicy, /HTTP request parsers must cap raw header count and raw header-name length, reject malformed raw header names before trusting raw header values, and only then lowercase names/);
  for (const source of [requestHeaderSource, distRequestHeaderSource]) {
    assert.match(source, /HTTP_MAX_HEADERS_COUNT \* 2/);
    assert.match(source, /MAX_RAW_HEADER_NAME_CHARS/);
    assert.match(source, /RAW_HEADER_NAME/);
    assert.match(source, /function isRawHeaderName/);
    assert.match(source, /if \(!isRawHeaderName\(rawName\)\)[\s\S]*return null/);
    assert.match(source, /MAX_HOST_HEADER_CHARS/);
    assert.match(source, /MAX_REMOTE_ADDRESS_CHARS/);
    assert.match(source, /MAX_REQUEST_TARGET_BYTES/);
    assert.match(source, /MAX_ORIGIN_HEADER_BYTES/);
    assert.match(source, /function utf8ByteLengthExceeds/);
    assert.match(source, /typeof target !== "string"/);
    assert.match(source, /ownDataValue\(req, "rawHeaders"\)/);
    assert.match(source, /ownArrayValue\(rawHeaders, index\)/);
    assert.match(source, /function rawHeaderValue/);
    assert.match(source, /function rawHeaderPairs/);
    assert.match(source, /optionalOwnDataValue\(req, "url"\)/);
    assert.match(source, /ownDataValue\(req, "method"\)/);
    assert.match(source, /ownDataValue\(req, "socket"\)/);
    assert.match(source, /ownDataValue\(socket, "remoteAddress"\)/);
    assert.match(source, /function normalizeRemoteAddress/);
    assert.match(source, /normalizeRemoteAddress\(remoteAddress\) \?\? "unknown"/);
    assert.match(source, /rawHeaderValue\(req, "x-forwarded-for"\)/);
    assert.match(source, /function trustedProxyHopsInput/);
    assert.match(source, /function isValidForwardedForHeader/);
    assert.match(source, /function forwardedIp/);
    assert.match(source, /return isIP\(normalized\) === 0 \? undefined : normalized/);
    assert.doesNotMatch(source, /ownDataValue\(headers, "host"\)/);
    assert.doesNotMatch(source, /ownDataValue\(headers, "origin"\)/);
    assert.match(source, /typeof rawName !== "string" \|\| typeof rawValue !== "string"/);
  }
  for (const source of [serverSource, distServerSource]) {
    assert.doesNotMatch(source, /req\.method/);
    assert.doesNotMatch(source, /req\.socket\.remoteAddress/);
    assert.match(source, /requestMethod\(req\) !== "GET"/);
    assert.match(source, /requestRemoteAddress\(req, trustedProxyHops, trustedProxyIps\)/);
  }
});

function req(headers: http.IncomingHttpHeaders, url = "/", rawHeaders?: string[], method = "GET", remoteAddress?: string): http.IncomingMessage {
  const request = { headers, rawHeaders: rawHeaders ?? headersToRawHeaders(headers), url, method } as http.IncomingMessage;
  if (remoteAddress !== undefined) {
    Object.defineProperty(request, "socket", {
      value: { remoteAddress },
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return request;
}

function headersToRawHeaders(headers: http.IncomingHttpHeaders): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.push(name, String(item));
    } else if (value !== undefined) {
      out.push(name, String(value));
    }
  }
  return out;
}
