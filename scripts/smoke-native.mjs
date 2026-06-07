#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NATIVE_SMOKE_TIMEOUT_MS = 10_000;

if (isMain()) {
  try {
    await smokeNativeWebRtc();
  } catch {
    console.error("Native WebRTC smoke failed.");
    process.exitCode = 1;
  }
}

export async function smokeNativeWebRtc() {
  const wrtc = await importNativeWebRtc();
  const RTCPeerConnection = requiredConstructor(wrtc.RTCPeerConnection, "RTCPeerConnection");
  const RTCDataChannel = requiredConstructor(wrtc.RTCDataChannel, "RTCDataChannel");
  requiredConstructor(wrtc.RTCIceCandidate, "RTCIceCandidate");

  const left = new RTCPeerConnection({ iceServers: [] });
  const right = new RTCPeerConnection({ iceServers: [] });
  let timeout;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Native WebRTC smoke timed out.")), NATIVE_SMOKE_TIMEOUT_MS);
    });
    const channel = left.createDataChannel("native-smoke", { ordered: true });
    if (!(channel instanceof RTCDataChannel)) throw new Error("Native WebRTC DataChannel constructor mismatch.");
    await Promise.race([negotiate(left, right), timeoutPromise]);
    assertDescription(left.localDescription, "offer", "left local description");
    assertDescription(left.remoteDescription, "answer", "left remote description");
    assertDescription(right.localDescription, "answer", "right local description");
    assertDescription(right.remoteDescription, "offer", "right remote description");
    channel.close();
  } finally {
    if (timeout) clearTimeout(timeout);
    left.close();
    right.close();
  }
}

async function importNativeWebRtc() {
  try {
    const mod = await import("../dist-node/cli/native-webrtc.js");
    return mod.nativeWebRtc();
  } catch {
    throw new Error("Native WebRTC package could not be loaded.");
  }
}

async function negotiate(left, right) {
  await left.setLocalDescription(await left.createOffer());
  await right.setRemoteDescription(left.localDescription);
  await right.setLocalDescription(await right.createAnswer());
  await left.setRemoteDescription(right.localDescription);
}

function requiredConstructor(value, label) {
  if (typeof value !== "function") throw new Error(`Native WebRTC ${label} is missing.`);
  return value;
}

function assertDescription(description, expectedType, label) {
  if (!description || description.type !== expectedType || typeof description.sdp !== "string" || !description.sdp.includes("m=application")) {
    throw new Error(`Native WebRTC ${label} is invalid.`);
  }
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
