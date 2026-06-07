import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { WebRtcSignalReplayGuard } from "../src/shared/signal-replay.js";
import { WebRtcSignalReplayGuard as DistWebRtcSignalReplayGuard } from "../dist-node/shared/signal-replay.js";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const distWebAssetsDir = new URL("../dist-web/assets", import.meta.url);
const distWebBundleName = fs.readdirSync(distWebAssetsDir).find((entry) => /^index-.*\.js$/.test(entry));
assert.ok(distWebBundleName);
const distWebBundle = fs.readFileSync(path.join(distWebAssetsDir.pathname, distWebBundleName), "utf8");
const validAuthTag = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("WebRTC signal replay guard enforces role SDP phase", () => {
  for (const Guard of [WebRtcSignalReplayGuard, DistWebRtcSignalReplayGuard]) {
    const receiver = new Guard(true);
    receiver.accept({ kind: "offer", sdp: "v=0\r\n", auth: validAuthTag });
    assert.throws(() => receiver.accept({ kind: "offer", sdp: "v=0\r\n", auth: validAuthTag }), /Duplicate WebRTC offer signal/);
    assert.throws(() => receiver.accept({ kind: "answer", sdp: "v=0\r\n", auth: validAuthTag }), /Unexpected WebRTC answer signal/);

    const sender = new Guard(false);
    sender.accept({ kind: "answer", sdp: "v=0\r\n", auth: validAuthTag });
    assert.throws(() => sender.accept({ kind: "answer", sdp: "v=0\r\n", auth: validAuthTag }), /Duplicate WebRTC answer signal/);
    assert.throws(() => sender.accept({ kind: "offer", sdp: "v=0\r\n", auth: validAuthTag }), /Unexpected WebRTC offer signal/);
  }
});

test("WebRTC signal replay guard rejects repeated ICE candidates", () => {
  for (const Guard of [WebRtcSignalReplayGuard, DistWebRtcSignalReplayGuard]) {
    const guard = new Guard(false);
    const candidate = {
      kind: "candidate" as const,
      candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ufrag" },
      auth: validAuthTag
    };
    guard.accept(candidate);
    assert.throws(() => guard.accept(candidate), /Duplicate WebRTC ICE candidate signal/);
    guard.accept({
      kind: "candidate",
      candidate: { candidate: "candidate:2 1 udp 1 127.0.0.1 2 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ufrag" },
      auth: validAuthTag
    });
  }
});

test("WebRTC signal replay guard uses own data without invoking accessors", () => {
  for (const Guard of [WebRtcSignalReplayGuard, DistWebRtcSignalReplayGuard]) {
    let getterInvoked = false;
    const signal = { kind: "candidate", auth: validAuthTag };
    Object.defineProperty(signal, "candidate", {
      get() {
        getterInvoked = true;
        return { candidate: "candidate:1 1 udp 1 127.0.0.1 1 typ host" };
      }
    });

    assert.throws(() => new Guard(false).accept(signal as never), /WebRTC signal replay payload is invalid/);
    assert.equal(getterInvoked, false);
  }
});

test("CLI and browser enforce signal replay before native handling", () => {
  assert.match(securityPolicy, /clients must enforce a local authenticated WebRTC signaling replay guard/);
  for (const source of [cliSource, webSource]) {
    const replay = source.indexOf("const replayGuard = new WebRtcSignalReplayGuard(answerOffers)");
    const accept = source.indexOf("replayGuard.accept(signal)", replay);
    const native = Math.min(
      ...["runtime.rtc.handleSignal(pc, signal)", "pc.addIceCandidate(signal.candidate)", "pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp })"]
        .map((needle) => source.indexOf(needle, accept))
        .filter((index) => index >= 0)
    );
    assert.notEqual(replay, -1);
    assert.notEqual(accept, -1);
    assert.notEqual(native, Number.POSITIVE_INFINITY);
    assert.equal(accept < native, true);
  }
  assert.match(distCliSource, /new WebRtcSignalReplayGuard\(answerOffers\)/);
  assert.match(distCliSource, /replayGuard\.accept\(signal\)/);
  assert.match(distWebBundle, /WebRTC signal replay policy is invalid/);
  assert.match(distWebBundle, /Duplicate WebRTC ICE candidate signal/);
});
