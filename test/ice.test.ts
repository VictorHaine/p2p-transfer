import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cloneIceServers } from "../src/shared/ice.js";

const iceSource = fs.readFileSync(new URL("../src/shared/ice.ts", import.meta.url), "utf8");
const distIceSource = fs.readFileSync(new URL("../dist-node/shared/ice.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("ICE server cloning returns independent snapshots", () => {
  const source = [{ urls: ["stun:one.example", "stun:two.example"], username: "u", credential: "p" }];
  const cloned = cloneIceServers(source);
  (cloned[0]!.urls as string[]).push("stun:mutated.example");
  assert.deepEqual(source, [{ urls: ["stun:one.example", "stun:two.example"], username: "u", credential: "p" }]);
});

test("ICE server cloning is bounded and rejects hostile property accessors", () => {
  assert.throws(() => cloneIceServers(Array.from({ length: 17 }, () => ({ urls: "stun:example.test" }))), /ICE server list/);
  assert.throws(() => cloneIceServers([{ urls: Array.from({ length: 9 }, (_, index) => `stun:${index}.example.test`) }]), /ICE server URL list/);
  assert.throws(() => cloneIceServers([{ urls: ["stun:stun.example.test", "stun:bad\nhost"] }]), /ICE server URL/);
  assert.throws(() => cloneIceServers([{ urls: "turn:turn.example.test" }]), /TURN ICE servers require credentials/);
  assert.throws(() => cloneIceServers([{ urls: "stun:stun.example.test", username: "u" }]), /ICE server credentials/);
  assert.throws(() => cloneIceServers([{ urls: "stun:stun.example.test", username: "u", credential: "p", credentialType: "oauth" } as never]), /credential type/);
  assert.throws(() => cloneIceServers([{ urls: "stun:stun.example.test", username: "u\n", credential: "p" }]), /credentials/);

  let iteratorInvoked = false;
  const iterableServers = [{ urls: "stun:stun.example.test" }];
  Object.defineProperty(iterableServers, Symbol.iterator, {
    get() {
      iteratorInvoked = true;
      throw new Error("iterator should not run");
    }
  });
  assert.deepEqual(cloneIceServers(iterableServers), [{ urls: "stun:stun.example.test" }]);
  assert.equal(iteratorInvoked, false);

  const accessorServer = {};
  Object.defineProperty(accessorServer, "urls", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => cloneIceServers([accessorServer as never]), /data properties/);

  const accessorUrls: string[] = [];
  Object.defineProperty(accessorUrls, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => cloneIceServers([{ urls: accessorUrls } as never]), /data properties/);

  assert.match(securityPolicy, /ICE server cloning must bound server and URL counts/);
  for (const source of [iceSource, distIceSource]) {
    assert.match(source, /MAX_CLONED_ICE_SERVERS = 16/);
    assert.match(source, /MAX_CLONED_ICE_URLS_PER_SERVER = 8/);
    assert.match(source, /MAX_CLONED_ICE_URL_CHARS = 512/);
    assert.match(source, /isValidAuthority/);
    assert.match(source, /TURN ICE servers require credentials/);
    assert.match(source, /credentialType !== undefined && \(credentialType !== "password"/);
    assert.match(source, /Object\.getOwnPropertyDescriptor/);
    assert.match(source, /for \(let index = 0; index < servers\.length; index \+= 1\)/);
    assert.doesNotMatch(source, /servers\.map\(cloneIceServer\)/);
    assert.doesNotMatch(source, /for \(const server of servers\)/);
    assert.doesNotMatch(source, /\[\.\.\.server\.urls\]/);
  }
  assert.match(distWebBundle, /ICE server list/);
  assert.match(distWebBundle, /ICE server URL/);
  assert.match(distWebBundle, /TURN ICE servers require credentials/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
