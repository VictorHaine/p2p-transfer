import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { securityHeaders } from "../src/server/security-headers.js";
import { securityHeaders as distSecurityHeaders } from "../dist-node/server/security-headers.js";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/server/security-headers.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/server/security-headers.js", import.meta.url), "utf8");

test("HTML CSP defaults to same-origin signaling only", () => {
  const csp = securityHeaders(true)["content-security-policy"] ?? "";
  const connectSrc = csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src "));
  assert.equal(connectSrc, "connect-src 'self'");
  assert.equal(connectSrc.split(/\s+/).includes("wss:"), false);
  assert.equal(connectSrc.split(/\s+/).includes("ws:"), false);
});

test("HTML CSP can explicitly opt in to loopback websocket development sockets", () => {
  const csp = securityHeaders(true, { allowLoopbackWs: true })["content-security-policy"] ?? "";
  const connectSrc = csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src "));
  assert.equal(connectSrc, "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*");
  assert.equal(connectSrc.split(/\s+/).includes("ws:"), false);
});

test("HTML CSP can explicitly opt in to arbitrary secure custom signaling servers", () => {
  const csp = securityHeaders(true, { allowAnyWss: true, allowLoopbackWs: true })["content-security-policy"] ?? "";
  const connectSrc = csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src "));
  assert.equal(connectSrc, "connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*");
  assert.equal(connectSrc.split(/\s+/).includes("ws:"), false);
});

test("non-HTML responses do not emit CSP meant for the browser app", () => {
  assert.equal(securityHeaders(false)["content-security-policy"], undefined);
});

test("static HTML detection applies CSP to every html response", () => {
  assert.match(securityPolicy, /every static `\.html` response must receive the browser CSP and no-store cache policy based on the resolved real file path/);
  for (const candidate of [
    fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8")
  ]) {
    assert.match(candidate, /const \[root, realFilePath\] = await Promise\.all\(\[realWebRoot, fs\.realpath\(filePath\)\]\)/);
    assert.match(candidate, /const body = await readStaticFile\(realFilePath\)/);
    assert.match(candidate, /const type = contentType\(realFilePath\)/);
    assert.match(candidate, /const isHtml = type\.startsWith\("text\/html;"\)/);
    assert.match(candidate, /"content-type": type/);
    assert.match(candidate, /"cache-control": isHtml \? "no-store" : "public, max-age=31536000, immutable"/);
    assert.doesNotMatch(candidate, /const isHtml = filePath\.endsWith\("index\.html"\)/);
    assert.doesNotMatch(candidate, /const type = contentType\(filePath\)/);
  }
});

test("security headers include transport and cross-origin isolation guardrails", () => {
  assert.match(securityPolicy, /browser security headers must keep no-referrer, HSTS, frame denial, MIME sniffing denial, COOP, COEP, CORP, Origin-Agent-Cluster, and a locked-down Permissions-Policy/);
  const headers = securityHeaders(true);
  assert.equal(headers["strict-transport-security"], "max-age=63072000; includeSubDomains; preload");
  assert.equal(headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(headers["origin-agent-cluster"], "?1");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["permissions-policy"], "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.deepEqual(distSecurityHeaders(true), headers);
});

test("HTML CSP explicitly closes unused browser execution and embedding surfaces", () => {
  const csp = securityHeaders(true)["content-security-policy"] ?? "";
  const directives = Object.fromEntries(csp.split(";").map((directive) => {
    const [name = "", ...value] = directive.trim().split(/\s+/);
    return [name, value.join(" ")];
  }));
  assert.equal(directives["script-src"], "'self'");
  assert.equal(directives["script-src-elem"], "'self'");
  assert.equal(directives["script-src-attr"], "'none'");
  assert.equal(directives["style-src"], "'self'");
  assert.equal(directives["style-src-elem"], "'self'");
  assert.equal(directives["style-src-attr"], "'none'");
  assert.equal(directives["img-src"], "'self'");
  assert.equal(directives["font-src"], "'none'");
  assert.equal(directives["media-src"], "'none'");
  assert.equal(directives["object-src"], "'none'");
  assert.equal(directives["worker-src"], "'none'");
  assert.equal(directives["child-src"], "'none'");
  assert.equal(directives["frame-src"], "'none'");
  assert.equal(directives["prefetch-src"], "'none'");
  assert.equal(directives["frame-ancestors"], "'none'");
  assert.equal(directives["form-action"], "'none'");
  assert.equal(directives["base-uri"], "'none'");
  assert.equal(directives["manifest-src"], "'none'");
  assert.equal(directives["require-trusted-types-for"], "'script'");
  assert.equal(directives["trusted-types"], "ff-static");
  assert.equal(Object.hasOwn(directives, "upgrade-insecure-requests"), false);
});

test("security header helper requires exact boolean options without invoking accessors", () => {
  assert.match(securityPolicy, /security header helpers must require exact boolean inputs and descriptor-read CSP options/);

  let invoked = false;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "allowAnyWss", {
    enumerable: true,
    get() {
      invoked = true;
      return true;
    }
  });
  Object.defineProperty(accessorOptions, "allowLoopbackWs", {
    enumerable: true,
    get() {
      invoked = true;
      return true;
    }
  });

  assert.equal(securityHeaders({ valueOf: () => true } as never)["content-security-policy"], undefined);
  assert.equal(distSecurityHeaders({ valueOf: () => true } as never)["content-security-policy"], undefined);
  assert.equal(securityHeaders(true, accessorOptions as never)["content-security-policy"]?.includes("wss:"), false);
  assert.equal(distSecurityHeaders(true, accessorOptions as never)["content-security-policy"]?.includes("wss:"), false);
  assert.equal(securityHeaders(true, { allowAnyWss: "true", allowLoopbackWs: 1 } as never)["content-security-policy"], securityHeaders(true)["content-security-policy"]);
  assert.equal(invoked, false);

  for (const text of [source, distSource]) {
    assert.match(text, /function securityHeaderOptions/);
    assert.match(text, /Object\.getOwnPropertyDescriptor\(options, key\)/);
    assert.match(text, /html === true/);
    assert.doesNotMatch(text, /options\.allowAnyWss/);
    assert.doesNotMatch(text, /options\.allowLoopbackWs/);
  }
});
