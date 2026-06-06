import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isLoopbackAuthority, isValidAuthority, isValidHostNameOrIp, isValidOriginHostname, splitAuthority } from "../src/shared/authority.js";
import {
  isLoopbackAuthority as distIsLoopbackAuthority,
  isValidAuthority as distIsValidAuthority,
  isValidHostNameOrIp as distIsValidHostNameOrIp,
  isValidOriginHostname as distIsValidOriginHostname,
  splitAuthority as distSplitAuthority
} from "../dist-node/shared/authority.js";

const source = fs.readFileSync(new URL("../src/shared/authority.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/shared/authority.js", import.meta.url), "utf8");
const webBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("shared authority validation accepts strict hostnames and IP literals", () => {
  for (const host of ["files.example", "1.example", "localhost", "127.0.0.1", "0.0.0.0", "::", "::1", "2001:db8::1"]) {
    assert.equal(isValidHostNameOrIp(host), true, host);
  }
  for (const authority of ["files.example", "files.example:8787", "127.0.0.1:8787", "[::1]:8787", "[2001:db8::1]"]) {
    assert.equal(isValidAuthority(authority), true, authority);
  }
  for (const originHostname of ["files.example", "127.0.0.1", "[::1]", "[2001:db8::1]"]) {
    assert.equal(isValidOriginHostname(originHostname), true, originHostname);
  }
});

test("shared authority validation rejects malformed and ambiguous hosts", () => {
  for (const host of ["", ".", "files.example.", "-files.example", "files..example", "bad_host", "bad\u200bhost", "1.2.3", "0177.0.0.1", "2130706433", "0x7f000001", "files:abc"]) {
    assert.equal(isValidHostNameOrIp(host), false, host);
  }
  for (const authority of ["files.example:0", "[::1]:0", "files.example:abc", "files.example:65536", "files.example/path", "user@files.example", "::1", "[not-ip]:8787", "bad\u200bhost:8787", "2130706433:8787"]) {
    assert.equal(isValidAuthority(authority), false, authority);
  }
  for (const originHostname of ["bad_host", "bad\u200bhost", "-files.example", "files..example", "files.example.", "2130706433", "[not-ip]"]) {
    assert.equal(isValidOriginHostname(originHostname), false, originHostname);
  }
});

test("shared authority splitting is bounded before parsing", () => {
  const oversized = `${"a".repeat(256)}.example`;
  for (const candidate of [oversized, "bad\u200bhost:8787", "user@files.example"]) {
    assert.equal(splitAuthority(candidate), null, candidate);
    assert.equal(isLoopbackAuthority(candidate), false, candidate);
    assert.equal(isValidAuthority(candidate), false, candidate);
    assert.equal(distSplitAuthority(candidate), null, candidate);
    assert.equal(distIsLoopbackAuthority(candidate), false, candidate);
    assert.equal(distIsValidAuthority(candidate), false, candidate);
  }
  assert.match(source, /function authorityInputAllowed/);
  assert.match(distSource, /function authorityInputAllowed/);
  assert.match(webBundle, /typeof e==`string`&&e\.length>0&&e\.length<=\w+&&!/);
});

test("shared authority helpers reject non-string values before coercion", () => {
  let coercionCalled = false;
  const hostile = {
    length: 5,
    toString() {
      coercionCalled = true;
      return "localhost";
    },
    split() {
      coercionCalled = true;
      return ["localhost"];
    },
    includes() {
      coercionCalled = true;
      return false;
    },
    startsWith() {
      coercionCalled = true;
      return false;
    },
    endsWith() {
      coercionCalled = true;
      return false;
    }
  };

  assert.equal(isValidHostNameOrIp(hostile as never), false);
  assert.equal(isValidOriginHostname(hostile as never), false);
  assert.equal(isValidAuthority(hostile as never), false);
  assert.equal(splitAuthority(hostile as never), null);
  assert.equal(isLoopbackAuthority(hostile as never), false);
  assert.equal(distIsValidHostNameOrIp(hostile as never), false);
  assert.equal(distIsValidOriginHostname(hostile as never), false);
  assert.equal(distIsValidAuthority(hostile as never), false);
  assert.equal(distSplitAuthority(hostile as never), null);
  assert.equal(distIsLoopbackAuthority(hostile as never), false);
  assert.equal(coercionCalled, false);

  assert.match(securityPolicy, /shared authority helpers must reject non-string runtime values before string, regex, or URL parsing/);
  assert.match(securityPolicy, /origin hostname helpers must cap raw hostnames before bracketed-IPv6 regular-expression matching or URL construction/);
  assert.equal(isValidOriginHostname(`[${"1".repeat(256)}]`), false);
  assert.equal(distIsValidOriginHostname(`[${"1".repeat(256)}]`), false);
  for (const document of [source, distSource]) {
    assert.match(document, /typeof host !== "string"/);
    assert.match(document, /typeof hostname !== "string"/);
    assert.match(document, /hostname\.length === 0 \|\| hostname\.length > MAX_AUTHORITY_CHARS/);
    assert.match(document, /typeof authority === "string"/);
  }
  assert.match(webBundle, /typeof e!=`string`\|\|!e\|\|e\.length>253/);
  assert.match(webBundle, /typeof e==`string`\?\/\^\\d\+\$/);
  assert.match(webBundle, /typeof e==`string`&&e\.length>0&&e\.length<=\w+&&!/);
});

test("shared loopback authority detection is strict", () => {
  for (const authority of ["localhost", "localhost:8787", "127.0.0.1:8787", "127.255.255.255", "[::1]:8787"]) {
    assert.equal(isLoopbackAuthority(authority), true, authority);
  }
  for (const authority of ["files.example", "127.0.0.1.example", "127.0.0.256", "127.1", "0177.0.0.1", "2130706433", "192.168.1.10", "[2001:db8::1]"]) {
    assert.equal(isLoopbackAuthority(authority), false, authority);
  }
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.equal(bundleNames.length, 1);
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
