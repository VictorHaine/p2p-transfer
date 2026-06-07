import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assertReviewedNativeWebRtcDependencies, nativeWebRtc } from "../src/cli/native-webrtc.js";

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

test("native WebRTC attestation rejects local build output precedence", () => {
  assert.match(nativeWebrtcSource, /assertNoLocalNativeBuildOutputs\(wrtc\.root\)/);
  assert.match(nativeWebrtcSource, /readdirSync\(packageRoot, \{ withFileTypes: true \}\)/);
  assert.match(nativeWebrtcSource, /\^build-\[a-z0-9_-\]\+\$/);
  assert.match(nativeWebrtcSource, /Native WebRTC package contains unreviewed local build outputs\./);
});
