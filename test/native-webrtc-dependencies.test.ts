import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoNativeFallbackSurfaces, assertReviewedNativeWebRtcDependencies, nativeWebRtc } from "../src/cli/native-webrtc.js";

const nativeWebrtcSource = fs.readFileSync(new URL("../src/cli/native-webrtc.ts", import.meta.url), "utf8");

test("CLI runtime native WebRTC dependency attestation accepts the reviewed install graph", () => {
  assert.doesNotThrow(() => assertReviewedNativeWebRtcDependencies());
});

test("native WebRTC loader exposes required constructors after attestation", () => {
  const wrtc = nativeWebRtc();
  assert.equal(typeof wrtc.RTCPeerConnection, "function");
  assert.equal(typeof wrtc.RTCDataChannel, "function");
  assert.equal(typeof wrtc.RTCIceCandidate, "function");
});

test("native WebRTC attestation rejects local build output precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-wrtc-build-output-"));
  try {
    await mkdir(path.join(root, "build-darwin-arm64"));
    assert.throws(() => assertNoNativeFallbackSurfaces(root, "darwin-arm64"), /Native WebRTC package contains unreviewed local build outputs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(nativeWebrtcSource, /assertNoNativeFallbackSurfaces\(wrtc\.root, reviewedPlatformTriple\(\)\)/);
  assert.match(nativeWebrtcSource, /readdirSync\(packageRoot, \{ withFileTypes: true \}\)/);
  assert.match(nativeWebrtcSource, /\^build-\[a-z0-9_-\]\+\$/);
  assert.match(nativeWebrtcSource, /Native WebRTC package contains unreviewed local build outputs\./);
});

test("native WebRTC attestation rejects nested prebuilt fallback precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-wrtc-nested-prebuilt-"));
  try {
    await mkdir(path.join(root, "node_modules", "@roamhq", "wrtc-darwin-arm64"), { recursive: true });
    assert.throws(() => assertNoNativeFallbackSurfaces(root, "darwin-arm64"), /Native WebRTC package contains unreviewed nested prebuilt outputs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(nativeWebrtcSource, /requireFromWrtc\.resolve\(`\$\{prebuiltName\}\/wrtc\.node`\)/);
  assert.match(nativeWebrtcSource, /assertResolvedFileWithinPackageRoot\(prebuiltBinary, prebuilt\.root, "Reviewed native WebRTC prebuilt binary"\)/);
  assert.match(nativeWebrtcSource, /assertLoadReviewedNativePrebuilt\(prebuiltBinary\)/);
});
