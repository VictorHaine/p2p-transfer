import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canServeIndexFallback, isMissingStaticPathError, isPathInsideRoot, staticUrlPathToRelative } from "../src/server/static-path.js";
import {
  canServeIndexFallback as distCanServeIndexFallback,
  isMissingStaticPathError as distIsMissingStaticPathError,
  isPathInsideRoot as distIsPathInsideRoot,
  staticUrlPathToRelative as distStaticUrlPathToRelative
} from "../dist-node/server/static-path.js";
import { STATIC_MAX_IN_FLIGHT_BYTES } from "../src/shared/constants.js";

test("static path containment rejects sibling prefix tricks and parent escapes", () => {
  const root = path.resolve("/srv/app/dist-web");
  assert.equal(isPathInsideRoot(root, path.resolve("/srv/app/dist-web/index.html")), true);
  assert.equal(isPathInsideRoot(root, path.resolve("/srv/app/dist-web/assets/app.js")), true);
  assert.equal(isPathInsideRoot(root, path.resolve("/srv/app/dist-web-evil/secret.txt")), false);
  assert.equal(isPathInsideRoot(root, path.resolve("/srv/app/secret.txt")), false);
});

test("static path containment rejects resolved symlink targets outside the root", () => {
  const root = path.resolve("/srv/app/dist-web");
  const symlinkTarget = path.resolve("/etc/passwd");
  assert.equal(isPathInsideRoot(root, symlinkTarget), false);
});

test("static path helpers reject non-string and accessor-backed runtime inputs before coercion", () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 1;
    },
    get startsWith() {
      coerced = true;
      return () => false;
    },
    toString() {
      coerced = true;
      return "/index.html";
    }
  };
  assert.equal(isPathInsideRoot(hostile as never, "/srv/app/dist-web/index.html"), false);
  assert.equal(isPathInsideRoot("/srv/app/dist-web", hostile as never), false);
  assert.throws(() => staticUrlPathToRelative(hostile as never), /invalid static URL path/);
  assert.equal(canServeIndexFallback(hostile as never), false);
  assert.equal(coerced, false);

  let codeGetterCalled = false;
  const accessorError = {};
  Object.defineProperty(accessorError, "code", {
    enumerable: true,
    get() {
      codeGetterCalled = true;
      return "ENOENT";
    }
  });
  assert.equal(isMissingStaticPathError(accessorError), false);
  assert.equal(codeGetterCalled, false);
});

test("static URL paths reject encoded platform separators and control paths", () => {
  assert.equal(staticUrlPathToRelative("/"), "index.html");
  assert.equal(staticUrlPathToRelative("/assets/app.js"), "assets/app.js");
  assert.equal(staticUrlPathToRelative("/a/../index.html"), "index.html");
  assert.throws(() => staticUrlPathToRelative(""), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative(`/${"a".repeat(8192)}`), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative(`/${"😀".repeat(2048)}`), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/assets%2fapp.js"), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/%5c..%5csecret.txt"), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/%00secret.txt"), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/%0asecret.txt"), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/zero%E2%80%8Bwidth"), /invalid static URL path/);
  assert.throws(() => staticUrlPathToRelative("/%E0%A4%A"), /invalid static URL path/);
});

test("published server static path helpers reject traversal and reserved routes", () => {
  const root = path.resolve("/srv/app/dist-web");
  assert.equal(distIsPathInsideRoot(root, path.resolve("/srv/app/dist-web/index.html")), true);
  assert.equal(distIsPathInsideRoot(root, path.resolve("/srv/app/dist-web-evil/secret.txt")), false);
  assert.equal(distStaticUrlPathToRelative("/"), "index.html");
  assert.equal(distStaticUrlPathToRelative("/a/../index.html"), "index.html");
  assert.throws(() => distStaticUrlPathToRelative(`/${"a".repeat(8192)}`), /invalid static URL path/);
  assert.throws(() => distStaticUrlPathToRelative(`/${"😀".repeat(2048)}`), /invalid static URL path/);
  assert.throws(() => distStaticUrlPathToRelative("/assets%2fapp.js"), /invalid static URL path/);
  assert.throws(() => distStaticUrlPathToRelative("/zero%E2%80%8Bwidth"), /invalid static URL path/);
  assert.equal(distCanServeIndexFallback("send"), true);
  assert.equal(distCanServeIndexFallback("v1/ws"), false);
  assert.equal(distCanServeIndexFallback("assets/index.js"), false);
  assert.equal(distCanServeIndexFallback("v1\\ws"), false);
  assert.equal(distCanServeIndexFallback("/send"), false);
  assert.equal(distCanServeIndexFallback("nested//route"), false);
  assert.equal(distCanServeIndexFallback("nested/../route"), false);
  assert.equal(distIsMissingStaticPathError({ code: "ENOENT" }), true);
  assert.equal(distIsMissingStaticPathError({ code: "EACCES" }), false);
  assert.equal(distIsPathInsideRoot({ toString: () => "/srv/app/dist-web" } as never, path.resolve("/srv/app/dist-web/index.html")), false);
  assert.throws(() => distStaticUrlPathToRelative({ toString: () => "/" } as never), /invalid static URL path/);
  assert.equal(distCanServeIndexFallback({ startsWith: () => true } as never), false);
});

test("static SPA fallback is limited to missing paths", () => {
  assert.equal(canServeIndexFallback("index.html"), true);
  assert.equal(canServeIndexFallback("send"), true);
  assert.equal(canServeIndexFallback("nested/route"), true);
  assert.equal(canServeIndexFallback("nested//route"), false);
  assert.equal(canServeIndexFallback("nested/../route"), false);
  assert.equal(canServeIndexFallback("/send"), false);
  assert.equal(canServeIndexFallback("send\nroute"), false);
  assert.equal(canServeIndexFallback("send\u200broute"), false);
  assert.equal(canServeIndexFallback("v1\\ws"), false);
  assert.equal(canServeIndexFallback(`${"😀".repeat(2049)}`), false);
  assert.equal(canServeIndexFallback("v1"), false);
  assert.equal(canServeIndexFallback("v1/ws"), false);
  assert.equal(canServeIndexFallback("v1/unknown"), false);
  assert.equal(canServeIndexFallback("assets/index.js"), false);
  assert.equal(canServeIndexFallback("favicon.ico"), false);

  assert.equal(isMissingStaticPathError({ code: "ENOENT" }), true);
  assert.equal(isMissingStaticPathError({ code: "ENOTDIR" }), true);
  assert.equal(isMissingStaticPathError({ code: "EACCES" }), false);
  assert.equal(isMissingStaticPathError({ code: "EPERM" }), false);
  assert.equal(isMissingStaticPathError(new Error("boom")), false);
});

test("static file serving opens assets with no-follow nonblocking flags", () => {
  const source = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const distSource = fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8");
  const staticPathSource = fs.readFileSync(new URL("../src/server/static-path.ts", import.meta.url), "utf8");
  const distStaticPathSource = fs.readFileSync(new URL("../dist-node/server/static-path.js", import.meta.url), "utf8");
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.equal(STATIC_MAX_IN_FLIGHT_BYTES, 64 * 1024 * 1024);
  assert.match(securityPolicy, /static path helpers must reject non-string, over-budget, traversal-shaped, absolute, backslash, control-character, and format-character runtime values/);
  for (const candidate of [staticPathSource, distStaticPathSource]) {
    assert.match(candidate, /typeof root !== "string" \|\| typeof candidate !== "string"/);
    assert.match(candidate, /typeof urlPath !== "string"/);
    assert.match(candidate, /MAX_STATIC_URL_PATH_BYTES = 8192/);
    assert.match(candidate, /utf8ByteLengthExceeds\(urlPath, MAX_STATIC_URL_PATH_BYTES\)/);
    assert.match(candidate, /function utf8ByteLengthExceeds/);
    assert.match(candidate, /typeof relative !== "string"/);
    assert.match(candidate, /function isSafeStaticRelativePath/);
    assert.match(candidate, /utf8ByteLengthExceeds\(relative, MAX_STATIC_URL_PATH_BYTES\)/);
    assert.match(candidate, /relative\.split\("\/"\)\.some/);
    assert.match(candidate, /Object\.getOwnPropertyDescriptor\(error, "code"\)/);
  }
  for (const candidate of [source, distSource]) {
    assert.match(securityPolicy, /static serving must distinguish attacker-shaped not-found or path-rejection responses from operational filesystem failures/);
    assert.match(securityPolicy, /static asset reads must use no-follow regular-file opens with pre-open and post-read identity and mutation-metadata checks plus bounded handle reads/);
    assert.match(securityPolicy, /static responses must reserve against a global in-flight byte budget until the HTTP response finishes or closes/);
    assert.match(candidate, /serveStatic\(url\.pathname, res\)\.catch\(\(error\) => staticFailure\(res, cors, error\)\)/);
    assert.match(candidate, /let staticInFlightBytes = 0/);
    assert.match(candidate, /function staticRelativePath/);
    assert.match(candidate, /function staticFailure/);
    assert.match(candidate, /function staticHttpStatus/);
    assert.match(candidate, /Object\.getOwnPropertyDescriptor\(error, "staticHttpStatus"\)/);
    assert.match(candidate, /status === 404 \? "not_found" : "internal_error"/);
    assert.match(candidate, /if \(!isMissingStaticPathError\(error\)\)[\s\S]*throw staticHttpError\(500\)/);
    assert.doesNotMatch(candidate, /serveStatic\(url\.pathname, res\)\.catch\(\(\) => json\(res, 404/);
    assert.match(candidate, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW \| fsConstants\.O_NONBLOCK/);
    assert.match(candidate, /const info = await fs\.lstat\(filePath\)/);
    assert.match(candidate, /fs\.open\(filePath, flags\)/);
    assert.match(candidate, /if \(!sameFile\(info, stat\)\)[\s\S]*throw new Error\("static asset changed before verification"\)/);
    assert.match(candidate, /releaseStaticBytes = reserveStaticResponseBytes\(stat\.size\)/);
    assert.match(candidate, /const afterRead = await handle\.stat\(\);[\s\S]*if \(!sameFile\(stat, afterRead\)\)[\s\S]*throw new Error\("static asset changed while being read"\)/);
    assert.match(candidate, /res\.once\("finish", staticFile\.release\)/);
    assert.match(candidate, /res\.once\("close", staticFile\.release\)/);
    assert.match(candidate, /function reserveStaticResponseBytes/);
    assert.match(candidate, /staticFileWithinLimit\(staticInFlightBytes \+ size, STATIC_MAX_IN_FLIGHT_BYTES\)/);
    assert.match(candidate, /staticInFlightBytes \+= size/);
    assert.match(candidate, /staticInFlightBytes = Math\.max\(0, staticInFlightBytes - size\)/);
    assert.match(candidate, /mtimeMs/);
    assert.match(candidate, /ctimeMs/);
    assert.doesNotMatch(candidate, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW;/);
    assert.match(candidate, /Buffer\.alloc\(64 \* 1024\)/);
    assert.doesNotMatch(candidate, /Buffer\.allocUnsafe/);
  }
});
