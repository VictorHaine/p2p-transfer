import test from "node:test";
import assert from "node:assert/strict";
import { assertReviewedNativeWebRtcDependencies, nativeWebRtc } from "../src/cli/native-webrtc.js";

test("CLI runtime native WebRTC dependency attestation accepts the reviewed install graph", () => {
  assert.doesNotThrow(() => assertReviewedNativeWebRtcDependencies());
});

test("native WebRTC loader exposes required constructors after attestation", () => {
  const wrtc = nativeWebRtc();
  assert.equal(typeof wrtc.RTCPeerConnection, "function");
  assert.equal(typeof wrtc.RTCDataChannel, "function");
  assert.equal(typeof wrtc.RTCIceCandidate, "function");
});
