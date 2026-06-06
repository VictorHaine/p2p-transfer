import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSha256, digestHex } from "../src/shared/hash.js";
import { digestHex as distDigestHex } from "../dist-node/shared/hash.js";

const source = fs.readFileSync(new URL("../src/shared/hash.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/shared/hash.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("SHA-256 digest helper returns canonical hex for real hash state", () => {
  const hash = createSha256();
  hash.update(new TextEncoder().encode("abc"));
  assert.equal(digestHex(hash), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("SHA-256 digest helper rejects malformed hash-like runtime values", () => {
  assert.match(securityPolicy, /exported hash helpers must read digest methods through data descriptors and require canonical 32-byte SHA-256 output/);

  for (const helper of [digestHex, distDigestHex]) {
    let invoked = false;
    const accessorHash = {};
    Object.defineProperty(accessorHash, "digest", {
      get() {
        invoked = true;
        return () => new Uint8Array(32);
      }
    });
    assert.throws(() => helper(accessorHash as never), /SHA-256 hash is invalid/);

    class HostileDigest extends Uint8Array {
      override get byteLength() {
        invoked = true;
        return 32;
      }
    }
    assert.throws(() => helper({ digest: () => new HostileDigest(32) } as never), /SHA-256 digest is invalid/);
    assert.throws(() => helper({ digest: () => new Uint8Array(31) } as never), /SHA-256 digest is invalid/);
    assert.throws(() => helper({ digest: () => ({ length: 32 }) } as never), /SHA-256 digest is invalid/);
    assert.equal(invoked, false);
  }

  for (const text of [source, distSource]) {
    assert.match(text, /function hashDigestMethod/);
    assert.match(text, /Object\.getOwnPropertyDescriptor\(current, key\)/);
    assert.match(text, /function assertCanonicalDigest/);
    assert.match(text, /byteLength !== 32/);
    assert.doesNotMatch(text, /\.digest\(\)/);
  }
  assert.match(distWebBundle, /SHA-256 hash is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+,t\)/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(n,t\)/);
  assert.match(distWebBundle, /byteLength`\)\?\.get/);
  assert.match(distWebBundle, /SHA-256 digest is invalid/);
  assert.doesNotMatch(distWebBundle, /function fe\(e\)\{return E\(e\.digest\(\)\)\}/);
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.equal(bundleNames.length, 1);
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
