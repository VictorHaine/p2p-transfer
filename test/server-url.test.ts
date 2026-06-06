import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeSignalingServerUrl } from "../src/shared/server-url.js";
import { normalizeSignalingServerUrl as distNormalizeSignalingServerUrl } from "../dist-node/shared/server-url.js";

const source = fs.readFileSync(new URL("../src/shared/server-url.ts", import.meta.url), "utf8");
const distSource = fs.readFileSync(new URL("../dist-node/shared/server-url.js", import.meta.url), "utf8");
const webBundle = readDistWebBundle();

test("signaling server URL accepts only explicit websocket URLs", () => {
  assert.equal(normalizeSignalingServerUrl(" ws://127.0.0.1:8787/v1/ws "), "ws://127.0.0.1:8787/v1/ws");
  assert.equal(normalizeSignalingServerUrl("ws://localhost:8787/v1/ws"), "ws://localhost:8787/v1/ws");
  assert.equal(normalizeSignalingServerUrl("ws://[::1]:8787/v1/ws"), "ws://[::1]:8787/v1/ws");
  assert.equal(normalizeSignalingServerUrl("ws://127.255.255.255:8787/v1/ws"), "ws://127.255.255.255:8787/v1/ws");
  assert.equal(normalizeSignalingServerUrl("wss://[2001:db8::1]/v1/ws"), "wss://[2001:db8::1]/v1/ws");
  assert.throws(() => normalizeSignalingServerUrl(" ".repeat(2049)), /at most 2048 bytes/);
  assert.throws(() => normalizeSignalingServerUrl("😀".repeat(513)), /at most 2048 bytes/);
  assert.throws(() => distNormalizeSignalingServerUrl(" ".repeat(2049)), /at most 2048 bytes/);
  assert.throws(() => distNormalizeSignalingServerUrl("😀".repeat(513)), /at most 2048 bytes/);
  assert.throws(() => normalizeSignalingServerUrl(""), /required/);
  assert.throws(() => normalizeSignalingServerUrl("https://files.example/v1/ws"), /ws:\/\/ or wss:\/\//);
  assert.throws(() => normalizeSignalingServerUrl("javascript:alert(1)"), /ws:\/\/ or wss:\/\//);
  assert.throws(() => normalizeSignalingServerUrl("wss://bad_host/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example./v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files..example/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("wss://-files.example/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example"), /path must be \/v1\/ws/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/"), /path must be \/v1\/ws/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/ws"), /path must be \/v1\/ws/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/v1/ws/"), /path must be \/v1\/ws/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/v1/%77s"), /path must be \/v1\/ws/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/v1/\nws"), /control or format/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example\u200b/v1/ws"), /control or format/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example:abc/v1/ws"), /valid/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example:0/v1/ws"), /valid/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example:65536/v1/ws"), /valid/);
  assert.throws(() => normalizeSignalingServerUrl("wss://[not-ip]:8787/v1/ws"), /valid/);
  assert.throws(() => normalizeSignalingServerUrl("ws://files.example/v1/ws"), /only allowed for localhost/);
  assert.throws(() => normalizeSignalingServerUrl("ws://192.168.1.10:8787/v1/ws"), /only allowed for localhost/);
  assert.throws(() => normalizeSignalingServerUrl("ws://127.1:8787/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("ws://0177.0.0.1:8787/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("ws://2130706433:8787/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("ws://0x7f000001:8787/v1/ws"), /valid hostname/);
  assert.throws(() => normalizeSignalingServerUrl("ws://127.0.0.256.test:8787/v1/ws"), /only allowed for localhost/);
  assert.throws(() => normalizeSignalingServerUrl("ws://127.0.0.1.example:8787/v1/ws"), /only allowed for localhost/);
  assert.throws(() => normalizeSignalingServerUrl("ws://user:pass@files.example/v1/ws"), /credentials/);
  assert.throws(() => normalizeSignalingServerUrl("wss://files.example/v1/ws?region=iad"), /query string/);
  assert.throws(() => distNormalizeSignalingServerUrl("wss://files.example/v1/ws?token=secret"), /query string/);
  assert.throws(() => normalizeSignalingServerUrl("ws://files.example/v1/ws#frag"), /fragment/);
});

test("signaling server URL cap does not allocate an encoded copy before rejecting", () => {
  assert.match(source, /function utf8ByteLengthExceeds/);
  assert.match(distSource, /function utf8ByteLengthExceeds/);
  assert.match(webBundle, /Signaling server URL must be at most/);
  assert.match(source, /url\.search/);
  assert.match(distSource, /url\.search/);
  assert.match(webBundle, /Signaling server URL must not include a query string/);
  assert.doesNotMatch(source, /TextEncoder/);
  assert.doesNotMatch(distSource, /TextEncoder/);
  assert.doesNotMatch(webBundle, /URLTextEncoder\.encode/);
});

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.equal(bundleNames.length, 1);
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
