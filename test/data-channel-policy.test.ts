import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import wrtc from "@roamhq/wrtc";
import { createPeer, handleSignal, waitForBackpressure, waitForDataChannelOpen } from "../src/cli/rtc.js";
import { createPeer as distCreatePeer } from "../dist-node/cli/rtc.js";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const cliRtcSource = fs.readFileSync(new URL("../src/cli/rtc.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const distCliRtcSource = fs.readFileSync(new URL("../dist-node/cli/rtc.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("CLI handleSignal rejects malformed direct signal inputs before accessors or native calls", async () => {
  assert.match(securityPolicy, /exported CLI WebRTC helpers must reject malformed createPeer construction inputs, PeerConnection, DataChannel, signal, and backpressure-limit inputs/);
  const pc = new wrtc.RTCPeerConnection();
  let kindRead = false;
  const hostileSignal = Object.create(null);
  Object.defineProperty(hostileSignal, "kind", {
    enumerable: true,
    get() {
      kindRead = true;
      return "candidate";
    }
  });

  try {
    await assert.rejects(() => handleSignal(pc, hostileSignal as never), /WebRTC signal is invalid/);
    assert.equal(kindRead, false);
  } finally {
    pc.close();
  }
});

test("CLI DataChannel wait helpers reject non-native channels before accessors", async () => {
  let readyStateRead = false;
  const hostileChannel = Object.create(null);
  Object.defineProperty(hostileChannel, "readyState", {
    enumerable: true,
    get() {
      readyStateRead = true;
      return "open";
    }
  });

  await assert.rejects(() => waitForDataChannelOpen(hostileChannel as never), /DataChannel is invalid/);
  await assert.rejects(() => waitForBackpressure(hostileChannel as never, 1), /DataChannel is invalid/);
  assert.equal(readyStateRead, false);
});

test("CLI DataChannel backpressure rejects malformed high-water marks without numeric coercion", async () => {
  const pc = new wrtc.RTCPeerConnection();
  const channel = pc.createDataChannel("bulk", { ordered: true });
  let coerced = false;
  const highWater = {
    valueOf() {
      coerced = true;
      return 1;
    }
  };

  try {
    await assert.rejects(() => waitForBackpressure(channel, highWater as never), /high-water mark is invalid/);
    assert.equal(coerced, false);
  } finally {
    channel.close();
    pc.close();
  }
});

test("CLI createPeer rejects malformed construction inputs before accessors or native calls", () => {
  assert.match(securityPolicy, /exported CLI WebRTC helpers must reject malformed createPeer construction inputs/);
  for (const factory of [createPeer, distCreatePeer]) {
    const validSignaling = { send() {} };

    let iceServerRead = false;
    const hostileIceServers = [{ urls: "stun:stun.example.test" }];
    Object.defineProperty(hostileIceServers, "0", {
      enumerable: true,
      get() {
        iceServerRead = true;
        return { urls: "stun:stun.example.test" };
      }
    });
    assert.throws(() => factory("abc123", hostileIceServers as never, validSignaling as never, new Uint8Array(32), "sender"), /ICE server/);
    assert.equal(iceServerRead, false);

    let sendRead = false;
    const hostileSignaling = Object.create(null);
    Object.defineProperty(hostileSignaling, "send", {
      enumerable: true,
      get() {
        sendRead = true;
        return () => {};
      }
    });
    assert.throws(() => factory("abc123", [], hostileSignaling as never, new Uint8Array(32), "sender"), /Signaling client is invalid/);
    assert.equal(sendRead, false);

    let keyLengthRead = false;
    class HostileKey extends Uint8Array {
      override get byteLength() {
        keyLengthRead = true;
        return 32;
      }
    }
    assert.throws(() => factory("abc123", [], validSignaling as never, new HostileKey(32), "sender"), /Signal authentication key is invalid/);
    assert.equal(keyLengthRead, false);

    let relayCoerced = false;
    const relay = {
      valueOf() {
        relayCoerced = true;
        return true;
      }
    };
    assert.throws(() => factory("abc123", [], validSignaling as never, new Uint8Array(32), "sender", relay as never), /Peer relay option is invalid/);
    assert.equal(relayCoerced, false);
  }
});

test("CLI createPeer snapshots construction inputs before native PeerConnection and ICE callbacks", () => {
  assert.match(securityPolicy, /exported CLI WebRTC helpers must reject malformed createPeer construction inputs/);
  for (const source of [cliRtcSource, distCliRtcSource]) {
    const body = extractFunctionBody(source, "createPeer");
    assert.match(body, /const safeSid = peerSidInput\(sid\)/);
    assert.match(body, /const safeIceServers = cloneIceServers\(iceServers\)/);
    assert.match(body, /const \{ target: signalingTarget, send: signalingSend \} = signalingClientInput\(signaling\)/);
    assert.match(body, /const safeRole = peerRoleInput\(role\)/);
    assert.match(body, /const safeForceRelay = forceRelayInput\(forceRelay\)/);
    assert.match(body, /let authKey = signalAuthKeyInput\(signalAuthKey\)/);
    assert.match(body, /new wrtc\.RTCPeerConnection\(\{ iceServers: safeIceServers, iceTransportPolicy: safeForceRelay \? "relay" : "all" \}\)/);
    assert.doesNotMatch(body, /new wrtc\.RTCPeerConnection\(\{ iceServers,/);
    assert.match(body, /authKey\.fill\(0\)/);
    assert.match(body, /signalingSend\.call\(signalingTarget/);
    assert.match(body, /signalAuthTag\(authKey, safeSid, safeRole/);
    assert.doesNotMatch(body, /signaling\.send|signalAuthKey, sid, role/);
  }
  assert.match(cliRtcSource, /function signalAuthKeyInput\(value: unknown\): Uint8Array \{/);
  assert.match(cliRtcSource, /function signalingClientInput\(value: unknown\): \{ target: SignalingClient; send: SignalingSend \} \{/);
  assert.match(cliRtcSource, /function dataMethod\(value: object, key: string\): unknown \{/);
  assert.match(distCliRtcSource, /function signalAuthKeyInput\(value\) \{/);
  assert.match(distCliRtcSource, /function signalingClientInput\(value\) \{/);
  assert.match(distCliRtcSource, /function dataMethod\(value, key\) \{/);
});

test("receivers fail closed on duplicate incoming WebRTC DataChannel labels", () => {
  for (const source of [cliSource, webSource]) {
    const duplicateCheck = source.indexOf("channels.has(label)");
    const channelSet = source.indexOf("channels.set(label, channel)");
    assert.notEqual(duplicateCheck, -1);
    assert.notEqual(channelSet, -1);
    assert.equal(duplicateCheck < channelSet, true);
    assert.match(source.slice(duplicateCheck, channelSet), /(?:closeDataChannel|closeBrowserDataChannel)\(channel\)[\s\S]*Duplicate DataChannel/);
  }
});

test("incoming DataChannel setup validates event channels before labels, close, or error text", () => {
  assert.match(securityPolicy, /incoming DataChannel setup must snapshot and validate the accepted event channel and channel object before reading labels, channel parameters, closing unexpected channels, or interpolating duplicate-label errors/);
  assert.match(cliSource, /import \{ closeDataChannel, createPeer, dataChannelLabel, handleSignal, isSafeIncomingDataChannel, waitForDataChannelOpen \} from "\.\/rtc\.js";/);
  assert.match(cliRtcSource, /export function isSafeDataChannel\(channel: unknown\): channel is RTCDataChannel/);
  assert.match(cliRtcSource, /export function isSafeIncomingDataChannel\(channel: unknown\): channel is RTCDataChannel/);
  assert.match(cliRtcSource, /\["readyState", "bufferedAmount", "bufferedAmountLowThreshold", "onopen", "onclose", "onerror", "onbufferedamountlow"\]/);
  assert.match(cliRtcSource, /\["label", "ordered", "maxPacketLifeTime", "maxRetransmits"\]/);
  assert.match(cliRtcSource, /export function dataChannelLabel\(channel: RTCDataChannel\): string \| undefined/);
  assert.match(cliRtcSource, /export function closeDataChannel\(channel: RTCDataChannel\): void/);
  assert.match(distCliRtcSource, /export function isSafeDataChannel\(channel\) \{/);
  assert.match(distCliRtcSource, /export function isSafeIncomingDataChannel\(channel\) \{/);
  assert.match(distCliRtcSource, /export function dataChannelLabel\(channel\) \{/);
  assert.match(distCliRtcSource, /export function closeDataChannel\(channel\) \{/);

  for (const source of [cliSource, webSource]) {
    const functionName = source === cliSource ? "waitForIncomingChannels" : "waitIncomingChannels";
    const body = extractFunctionBody(source, functionName);
    assert.match(body, /const channel = incoming(?:Browser)?DataChannel\(event\);/);
    assert.match(body, /if \(!channel\) \{[\s\S]*Unexpected DataChannel parameters\.[\s\S]*return;[\s\S]*\}/);
    assert.match(body, /const label = (?:dataChannelLabel|browserDataChannelLabel)\(channel\);/);
    assert.match(body, /if \(!isExpectedDataChannel\(channel, label\)\) \{[\s\S]*(?:closeDataChannel|closeBrowserDataChannel)\(channel\);[\s\S]*Unexpected DataChannel parameters\./);
    assert.match(body, /channels\.has\(label\)[\s\S]*(?:closeDataChannel|closeBrowserDataChannel)\(channel\)[\s\S]*Duplicate DataChannel \$\{label\}/);
    assert.match(body, /channels\.set\(label, channel\)/);
    assert.doesNotMatch(body, /event\.channel\.label|event\.channel\.close\(\)|channels\.set\(event\.channel\.label/);
  }

  assert.match(cliSource, /function incomingDataChannel\(event: RTCDataChannelEvent\): RTCDataChannel \| undefined \{[\s\S]*const channel = ownDataValue\(event, "channel"\);[\s\S]*return isSafeIncomingDataChannel\(channel\) \? channel : undefined;[\s\S]*\}/);
  assert.match(webSource, /function isSafeBrowserDataChannel\(channel: unknown\): channel is RTCDataChannel \{/);
  assert.match(webSource, /function incomingBrowserDataChannel\(event: RTCDataChannelEvent\): RTCDataChannel \| undefined \{[\s\S]*typeof RTCDataChannelEvent !== "undefined" && event instanceof RTCDataChannelEvent \? event\.channel : ownDataValue\(event, "channel"\)/);
  assert.match(webSource, /channel instanceof RTCDataChannel/);
  assert.match(webSource, /function browserDataChannelLabel\(channel: RTCDataChannel\): string \| undefined/);
  assert.match(webSource, /function closeBrowserDataChannel\(channel: RTCDataChannel\): void/);
  assert.match(distCliSource, /function incomingDataChannel\(event\) \{[\s\S]*const channel = ownDataValue\(event, "channel"\);[\s\S]*return isSafeIncomingDataChannel\(channel\) \? channel : undefined;/);
  assert.match(distWebBundle, /typeof RTCDataChannelEvent<`u`&&\w+ instanceof RTCDataChannelEvent\?\w+\.channel/);
  assert.match(distWebBundle, /typeof RTCDataChannel<`u`&&\w+ instanceof RTCDataChannel/);
  assert.match(distWebBundle, /typeof \w+==`string`\?\w+:void 0/);
  assert.match(distWebBundle, /\.close\(\)/);
  assert.match(distWebBundle, /`control`\|\|\w+===`bulk`/);
  assert.match(cliSource, /function isUnsetRetransmissionLimit\(value: unknown\): boolean \{[\s\S]*return value === null \|\| value === 65535;/);
  assert.match(distCliSource, /function isUnsetRetransmissionLimit\(value\) \{[\s\S]*return value === null \|\| value === 65535;/);
  assert.match(distWebBundle, /maxPacketLifeTime===null&&\w+\.maxRetransmits===null/);
  assert.doesNotMatch(distWebBundle, /Unexpected DataChannel parameters for \$\{e\.channel\.label\}|Duplicate DataChannel \$\{e\.channel\.label\}|t\.set\(e\.channel\.label,e\.channel\)/);
});

test("incoming DataChannel setup closes partial channels on setup failure", () => {
  for (const source of [cliSource, webSource]) {
    const functionName = source === cliSource ? "waitForIncomingChannels" : "waitIncomingChannels";
    const body = extractFunctionBody(source, functionName);
    assert.match(body, /const closeCollectedChannels = \(\) => \{[\s\S]*for \(const channel of channels\.values\(\)\)[\s\S]*channel\.close\(\)[\s\S]*channels\.clear\(\);[\s\S]*\};/);
    assert.match(body, /const fail = \(error: Error\) => \{[\s\S]*cleanup\(\);[\s\S]*closeCollectedChannels\(\);[\s\S]*reject\(error\);[\s\S]*\};/);
  }
  const distIncomingBody = extractFunctionBody(distCliSource, "waitForIncomingChannels");
  assert.match(distIncomingBody, /const closeCollectedChannels = \(\) => \{[\s\S]*for \(const channel of channels\.values\(\)\)[\s\S]*channel\.close\(\)[\s\S]*channels\.clear\(\);[\s\S]*\};/);
  assert.match(distIncomingBody, /const fail = \(error\) => \{[\s\S]*cleanup\(\);[\s\S]*closeCollectedChannels\(\);[\s\S]*reject\(error\);[\s\S]*\};/);
  assert.match(distWebBundle, /new Map;return new Promise/);
  assert.match(distWebBundle, /for\(let \w of \w\.values\(\)\)try\{\w\.close\(\)\}catch\{\}\w\.clear\(\)/);
});

test("incoming DataChannel setup fails on terminal peer-connection states while waiting", () => {
  for (const source of [cliSource, webSource]) {
    const functionName = source === cliSource ? "waitForIncomingChannels" : "waitIncomingChannels";
    const body = extractFunctionBody(source, functionName);
    assert.match(body, /pc\.removeEventListener\("connectionstatechange", failOnTerminalConnectionState\)/);
    assert.match(body, /const failOnTerminalConnectionState = \(\) => \{[\s\S]*pc\.connectionState === "failed" \|\| pc\.connectionState === "closed" \|\| pc\.connectionState === "disconnected"[\s\S]*fail\(new Error\(`WebRTC connection \$\{pc\.connectionState\}\.`\)\);[\s\S]*\};/);
    assert.match(body, /pc\.addEventListener\("connectionstatechange", failOnTerminalConnectionState\);[\s\S]*failOnTerminalConnectionState\(\);/);
  }
  const distIncomingBody = extractFunctionBody(distCliSource, "waitForIncomingChannels");
  assert.match(distIncomingBody, /pc\.removeEventListener\("connectionstatechange", failOnTerminalConnectionState\)/);
  assert.match(distIncomingBody, /const failOnTerminalConnectionState = \(\) => \{[\s\S]*pc\.connectionState === "failed" \|\| pc\.connectionState === "closed" \|\| pc\.connectionState === "disconnected"[\s\S]*fail\(new Error\(`WebRTC connection \$\{pc\.connectionState\}\.`\)\);[\s\S]*\};/);
  assert.match(distIncomingBody, /pc\.addEventListener\("connectionstatechange", failOnTerminalConnectionState\);[\s\S]*failOnTerminalConnectionState\(\);/);
  assert.match(distWebBundle, /\.addEventListener\(`connectionstatechange`/);
  assert.match(distWebBundle, /connectionState===`failed`\|\|\w+\.connectionState===`closed`\|\|\w+\.connectionState===`disconnected`/);
  assert.match(distWebBundle, /WebRTC connection \$\{\w+\.connectionState\}\./);
});

test("WebRTC signaling listeners are disposed before session key wipe", () => {
  for (const source of [cliSource, webSource]) {
    assert.match(source, /let unwireSignals: \(\(\) => void\) \| undefined/);
    assert.match(source, /const signalWire = wireSignals\(signaling, [\s\S]*unwireSignals = signalWire\.dispose/);
    const cleanup = source.indexOf("unwireSignals?.()");
    const wipe = source.indexOf("wipeSessionKeys(keys)", cleanup);
    assert.notEqual(cleanup, -1);
    assert.notEqual(wipe, -1);
    assert.equal(cleanup < wipe, true);
    assert.match(source, /const dispose = \(\) => \{[\s\S]*disposed = true;[\s\S]*queuedCandidates\.length = 0;[\s\S]*signaling\.off\("signal", onSignal\);[\s\S]*\};/);
    assert.match(source, /return \{ dispose, failure \}/);
  }
});

test("in-flight WebRTC signal handlers stop after disposal", () => {
  for (const source of [cliSource, webSource]) {
    const wireSignals = extractFunctionBody(source, "wireSignals");
    assert.match(wireSignals, /let disposed = false/);
    assert.match(wireSignals, /const dispose = \(\) => \{[\s\S]*disposed = true;[\s\S]*queuedCandidates\.length = 0;[\s\S]*signaling\.off\("signal", onSignal\);[\s\S]*\};/);
    assert.match(wireSignals, /if \(disposed\) return;[\s\S]*verifySignalAuthTag/);
    assert.match(wireSignals, /await [\s\S]*(?:handleSignal|setRemoteDescription)[\s\S]*if \(disposed\) return;/);
    assert.match(wireSignals, /while \(!disposed && queuedCandidates\.length > 0\)/);
  }
});

test("WebRTC signal listeners revalidate emitted records before field reads", () => {
  assert.match(securityPolicy, /client event listeners for ICE config, pair decisions, and WebRTC signaling must revalidate emitted signaling records before any field reads/);
  for (const source of [cliSource, webSource]) {
    const wireSignals = extractFunctionBody(source, "wireSignals");
    assert.match(wireSignals, /const onSignal = async \(message: (?:unknown|BrowserSignalingEvent)\) => \{[\s\S]*if \(!isServerMessage\(message\)\) return;[\s\S]*message\.type !== "signal"/);
    assert.equal(wireSignals.indexOf("if (!isServerMessage(message)) return;") < wireSignals.indexOf('message.type !== "signal"'), true);
    assert.equal(wireSignals.indexOf("if (!isServerMessage(message)) return;") < wireSignals.indexOf("verifySignalAuthTag"), true);
  }
  assert.match(distCliSource, /const onSignal = async \(message\) => \{[\s\S]*if \(!isServerMessage\(message\)\)[\s\S]*return;[\s\S]*message\.type !== "signal"/);
  assert.match(distWebBundle, /if\(\w+\|\|!\w+\(\w+\)\|\|\w+\.type!==`signal`\|\|\w+\.sid!==\w+\)return/);
});

test("WebRTC candidates are copied after authentication before native or delayed handling", () => {
  assert.match(securityPolicy, /authenticated WebRTC ICE candidates must be converted to defensive own-data copies before both immediate native handling and queued delayed handling/);
  for (const source of [cliSource, webSource]) {
    const wireSignals = extractFunctionBody(source, "wireSignals");
    assert.match(wireSignals, /const queuedCandidates: Extract<SignalPayload, \{ kind: "candidate" \}>\[\] = \[\];/);
    assert.match(wireSignals, /const signal = message\.signal\.kind === "candidate" \? copyCandidateSignal\(message\.signal\) : message\.signal;/);
    assert.match(wireSignals, /queuedCandidates\.push\(signal\);/);
    assert.doesNotMatch(wireSignals, /queuedCandidates\.push\(message\.signal\);/);
    assert.doesNotMatch(wireSignals, /handleSignal\(pc, message\.signal\)|addIceCandidate\(message\.signal\.candidate\)/);
    assert.match(source, /function copyCandidateSignal\(signal: Extract<SignalPayload, \{ kind: "candidate" \}>\): Extract<SignalPayload, \{ kind: "candidate" \}> \{/);
    assert.match(source, /const source = ownDataValue\(signal, "candidate"\)/);
    assert.match(source, /const auth = ownDataValue\(signal, "auth"\)/);
    assert.match(source, /const candidateText = ownDataValue\(source, "candidate"\)/);
    assert.match(source, /const candidate: RTCIceCandidateInit = \{\};/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.doesNotMatch(source, /signal\.candidate\.candidate|signal\.candidate\.sdpMid|signal\.candidate\.sdpMLineIndex|signal\.candidate\.usernameFragment|auth: signal\.auth/);
    assert.match(source, /if \(typeof usernameFragment === "string"\) candidate\.usernameFragment = usernameFragment;/);
    assert.match(source, /return \{ kind: "candidate", candidate, auth \};/);
  }
  assert.match(distCliSource, /const signal = message\.signal\.kind === "candidate" \? copyCandidateSignal\(message\.signal\) : message\.signal;/);
  assert.match(distCliSource, /queuedCandidates\.push\(signal\);/);
  assert.doesNotMatch(distCliSource, /queuedCandidates\.push\(message\.signal\);/);
  assert.doesNotMatch(distCliSource, /handleSignal\(pc, message\.signal\)/);
  assert.match(distCliSource, /function copyCandidateSignal\(signal\) \{/);
  assert.match(distCliSource, /const source = ownDataValue\(signal, "candidate"\)/);
  assert.match(distCliSource, /const auth = ownDataValue\(signal, "auth"\)/);
  assert.match(distCliSource, /const candidateText = ownDataValue\(source, "candidate"\)/);
  assert.match(distCliSource, /const candidate = \{\};/);
  assert.match(distCliSource, /Object\.getOwnPropertyDescriptor\(value, key\)/);
  assert.doesNotMatch(distCliSource, /signal\.candidate\.candidate|signal\.candidate\.sdpMid|signal\.candidate\.sdpMLineIndex|signal\.candidate\.usernameFragment|auth: signal\.auth/);
  assert.match(distWebBundle, /\.signal\.kind===`candidate`\?/);
  assert.match(distWebBundle, /\.push\(\w+\)/);
  assert.doesNotMatch(distWebBundle, /\.push\(\w+\.signal\)/);
  assert.doesNotMatch(distWebBundle, /addIceCandidate\(\w+\.signal\.candidate\)/);
  assert.match(distWebBundle, /WebRTC candidate signal is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+,\w+\)/);
  assert.doesNotMatch(distWebBundle, /\w+\.candidate\.candidate|\w+\.candidate\.sdpMid|\w+\.candidate\.sdpMLineIndex|\w+\.candidate\.usernameFragment|auth:\w+\.auth/);
});

test("local ICE candidate callbacks snapshot native candidates before auth and signaling", () => {
  assert.match(securityPolicy, /local WebRTC ICE candidate callbacks must snapshot native event and candidate data into defensive plain records before signal authentication and signaling send, and browser candidate serialization must locate `toJSON` through data descriptors on the candidate\/prototype chain/);
  assert.match(securityPolicy, /browser WebRTC ICE candidate callbacks must copy the signal-authentication key, clear their handler, and wipe that callback-owned copy before session-key wipe/);

  for (const source of [cliRtcSource, distCliRtcSource]) {
    const createPeerBody = extractFunctionBody(source, "createPeer");
    assert.match(createPeerBody, /const localCandidate = localIceCandidateFromEvent\(event\);/);
    assert.match(createPeerBody, /const candidate = localIceCandidateInit\(localCandidate\);/);
    assert.match(createPeerBody, /signalAuthTag\(authKey, safeSid, safeRole, \{ kind: "candidate", candidate \}\)/);
    assert.doesNotMatch(createPeerBody, /event\.candidate|candidate\.toJSON\(\)/);
    assert.match(source, /const NATIVE_ICE_CANDIDATE = wrtc\.RTCIceCandidate/);
    assert.match(source, /function localIceCandidateFromEvent\(event(?:: unknown)?\)(?:: RTCIceCandidate \| undefined)? \{/);
    assert.match(source, /const candidate = ownDataValue\(event, "candidate"\);/);
    assert.match(source, /candidate instanceof NATIVE_ICE_CANDIDATE/);
    assert.match(source, /function localIceCandidateInit\(source(?:: RTCIceCandidate)?\)(?:: RTCIceCandidateInit \| undefined)? \{/);
    assert.match(source, /const candidateText = ownDataValue\(source, "candidate"\);/);
    assert.match(source, /const candidate(?:: RTCIceCandidateInit)? = \{ candidate: candidateText \};/);
    assert.match(source, /function ownDataValue\(value(?:: unknown)?, key(?:: string)?\)(?:: unknown)? \{/);
  }

  const browserSendBody = extractFunctionBody(webSource, "sendFromBrowser");
  const browserReceiveBody = extractFunctionBody(webSource, "receiveInBrowser");
  assert.match(browserSendBody, /let unwireIce: \(\(\) => void\) \| undefined;/);
  assert.match(browserSendBody, /unwireIce = wireBrowserIceCandidates\(signaling, pc, joined\.sid, keys\.signalAuthKey, "sender"\);/);
  assert.match(browserSendBody, /unwireIce\(\);[\s\S]*unwireIce = undefined;[\s\S]*signalWire\.dispose\(\);/);
  assert.match(browserSendBody, /unwireIce\?\.\(\);[\s\S]*unwireSignals\?\.\(\);[\s\S]*wipeSessionKeys\(keys\);/);
  assert.match(browserReceiveBody, /let unwireIce: \(\(\) => void\) \| undefined;/);
  assert.match(browserReceiveBody, /unwireIce = wireBrowserIceCandidates\(signaling, pc, joined\.sid, keys\.signalAuthKey, "receiver"\);/);
  assert.match(browserReceiveBody, /unwireIce\(\);[\s\S]*unwireIce = undefined;[\s\S]*signalWire\.dispose\(\);/);
  assert.match(browserReceiveBody, /unwireIce\?\.\(\);[\s\S]*unwireSignals\?\.\(\);[\s\S]*wipeSessionKeys\(keys\);/);
  assert.doesNotMatch(browserSendBody, /event\.candidate|candidate\.toJSON\(\)/);
  assert.doesNotMatch(browserReceiveBody, /event\.candidate|candidate\.toJSON\(\)/);
  assert.doesNotMatch(browserSendBody, /sessionKeys\.signalAuthKey|pc\.onicecandidate =/);
  assert.doesNotMatch(browserReceiveBody, /sessionKeys\.signalAuthKey|pc\.onicecandidate =/);
  assert.match(webSource, /function sendBrowserIceCandidate\(signaling: BrowserSignaling, sid: string, signalAuthKey: Uint8Array, role: PakeRole, event: RTCPeerConnectionIceEvent\): void \{/);
  assert.match(webSource, /function wireBrowserIceCandidates\(signaling: BrowserSignaling, pc: RTCPeerConnection, sid: string, signalAuthKey: Uint8Array, role: PakeRole\): \(\) => void \{/);
  const browserIceWireBody = extractFunctionBody(webSource, "wireBrowserIceCandidates");
  assert.match(browserIceWireBody, /const authKey = copySignalAuthKey\(signalAuthKey\);/);
  assert.match(browserIceWireBody, /try \{[\s\S]*sendBrowserIceCandidate\(signaling, sid, authKey, role, event\);[\s\S]*\} catch \{/);
  assert.match(browserIceWireBody, /safeBrowserSend\(signaling, \{ type: "bye", sid, reason: "signal_error" \}\);/);
  assert.match(browserIceWireBody, /pc\.close\(\);/);
  assert.match(browserIceWireBody, /authKey\.fill\(0\);/);
  assert.match(browserIceWireBody, /if \(pc\.onicecandidate === onIceCandidate\) pc\.onicecandidate = null;/);
  assert.match(browserIceWireBody, /pc\.onicecandidate = onIceCandidate;/);
  assert.match(webSource, /function copySignalAuthKey\(signalAuthKey: Uint8Array\): Uint8Array \{/);
  const copySignalAuthKeyBody = extractFunctionBody(webSource, "copySignalAuthKey");
  assert.match(copySignalAuthKeyBody, /Object\.getPrototypeOf\(signalAuthKey\) !== Uint8Array\.prototype/);
  assert.match(copySignalAuthKeyBody, /signalAuthKey\.byteLength !== 32/);
  assert.match(copySignalAuthKeyBody, /const copy = new Uint8Array\(signalAuthKey\.byteLength\);/);
  assert.match(copySignalAuthKeyBody, /copy\.set\(signalAuthKey\);/);
  assert.match(webSource, /function localBrowserIceCandidateFromEvent\(event: unknown\): RTCIceCandidate \| undefined \{/);
  assert.match(webSource, /typeof RTCPeerConnectionIceEvent !== "undefined" && event instanceof RTCPeerConnectionIceEvent \? event\.candidate : ownDataValue\(event, "candidate"\)/);
  assert.match(webSource, /function localBrowserIceCandidateInit\(candidate: RTCIceCandidate\): RTCIceCandidateInit \| undefined \{/);
  assert.match(webSource, /const toJSON = dataMethod\(candidate, "toJSON"\);/);
  assert.doesNotMatch(webSource, /dataMethod\(RTCIceCandidate\.prototype, "toJSON"\)/);
  assert.match(webSource, /function copyLocalIceCandidateInit\(source: unknown\): RTCIceCandidateInit \| undefined \{/);
  assert.match(webSource, /function dataMethod\(value: object, key: string\): unknown \{/);

  assert.match(distWebBundle, /`sender`\)/);
  assert.match(distWebBundle, /`receiver`\)/);
  assert.match(distWebBundle, /reason:`signal_error`/);
  assert.match(distWebBundle, /Signal auth key is invalid/);
  assert.doesNotMatch(distWebBundle, /onicecandidate=[^;]+signalAuthKey/);
  assert.doesNotMatch(distWebBundle, /onicecandidate=[\s\S]{0,120}\.candidate\.toJSON\(\)/);
  assert.match(distWebBundle, /kind:`candidate`,candidate:\w+,auth:/);
  assert.match(distWebBundle, /typeof RTCPeerConnectionIceEvent<`u`&&\w+ instanceof RTCPeerConnectionIceEvent\?\w+\.candidate/);
  assert.match(distWebBundle, /`toJSON`\)/);
  assert.doesNotMatch(distWebBundle, /RTCIceCandidate\.prototype,`toJSON`/);
});

test("DataChannel open waits fail immediately on terminal states", () => {
  assert.match(securityPolicy, /open waiters must re-check for already-open channels after installing handlers/);
  assert.match(cliRtcSource, /if \(channel\.readyState === "closing" \|\| channel\.readyState === "closed"\) throw new Error\(`DataChannel \$\{channel\.label\} is \$\{channel\.readyState\}\.`\);/);
  assert.match(webSource, /if \(channel\.readyState === "closing" \|\| channel\.readyState === "closed"\) return Promise\.reject\(new Error\(`\$\{channel\.label\} channel is \$\{channel\.readyState\}\.`\)\);/);
  for (const source of [cliRtcSource, webSource]) {
    const body = source === cliRtcSource ? extractFunctionBody(source, "waitForDataChannelOpen") : extractFunctionBody(source, "waitOpen");
    assert.match(body, /let settled = false/);
    assert.match(body, /const failIfTerminal = \(\) => \{[\s\S]*channel\.readyState === "closing" \|\| channel\.readyState === "closed"[\s\S]*\};/);
    assert.match(body, /const succeedIfOpen = \(\) => \{[\s\S]*channel\.readyState === "open"[\s\S]*succeed\(\)[\s\S]*\};/);
    assert.match(body, /channel\.onopen = succeed;[\s\S]*channel\.onclose = \(\) => fail[\s\S]*channel\.onerror = \(\) => fail[\s\S]*failIfTerminal\(\);[\s\S]*succeedIfOpen\(\);/);
  }
  const distOpenBody = extractFunctionBody(distCliRtcSource, "waitForDataChannelOpen");
  assert.match(distCliRtcSource, /if \(channel\.readyState === "closing" \|\| channel\.readyState === "closed"\)[\s\S]*throw new Error\(`DataChannel \$\{channel\.label\} is \$\{channel\.readyState\}\.`\);/);
  assert.match(distOpenBody, /let settled = false/);
  assert.match(distOpenBody, /const failIfTerminal = \(\) => \{[\s\S]*channel\.readyState === "closing" \|\| channel\.readyState === "closed"[\s\S]*\};/);
  assert.match(distOpenBody, /const succeedIfOpen = \(\) => \{[\s\S]*channel\.readyState === "open"[\s\S]*succeed\(\)[\s\S]*\};/);
  assert.match(distOpenBody, /channel\.onopen = succeed;[\s\S]*channel\.onclose = \(\) => fail[\s\S]*channel\.onerror = \(\) => fail[\s\S]*failIfTerminal\(\);[\s\S]*succeedIfOpen\(\);/);
  assert.match(distWebBundle, /readyState===`open`\?Promise\.resolve\(\):\w+\.readyState===`closing`\|\|\w+\.readyState===`closed`\?Promise\.reject/);
  assert.match(distWebBundle, /\$\{\w+\.label\} channel is \$\{\w+\.readyState\}\./);
  assert.match(distWebBundle, /channel closed before opening/);
});

test("DataChannel backpressure waits fail immediately on terminal states", () => {
  assert.match(cliRtcSource, /if \(channel\.readyState === "closing" \|\| channel\.readyState === "closed"\) throw new Error\(`DataChannel \$\{channel\.label\} is \$\{channel\.readyState\}\.`\);/);
  assert.match(webSource, /if \(channel\.readyState === "closing" \|\| channel\.readyState === "closed"\) return Promise\.reject\(new Error\(`\$\{channel\.label\} channel is \$\{channel\.readyState\}\.`\)\);/);
  for (const source of [cliRtcSource, webSource]) {
    const body = source === cliRtcSource ? extractFunctionBody(source, "waitForBackpressure") : extractFunctionBody(source, "waitBackpressure");
    const terminalCheck = body.indexOf('channel.readyState === "closing" || channel.readyState === "closed"');
    const lowBufferReturn = body.indexOf("channel.bufferedAmount <=");
    assert.notEqual(terminalCheck, -1);
    assert.notEqual(lowBufferReturn, -1);
    assert.equal(terminalCheck < lowBufferReturn, true);
    assert.match(body, /let settled = false/);
    assert.match(body, /const failIfTerminal = \(\) => \{[\s\S]*channel\.readyState === "closing" \|\| channel\.readyState === "closed"[\s\S]*\};/);
    assert.match(body, /channel\.onbufferedamountlow = finish;[\s\S]*channel\.onclose = \(event\) => \{[\s\S]*fail[\s\S]*channel\.onerror = \(event\) => \{[\s\S]*fail[\s\S]*failIfTerminal\(\);/);
  }
  const distBackpressureBody = extractFunctionBody(distCliRtcSource, "waitForBackpressure");
  const distTerminalCheck = distBackpressureBody.indexOf('channel.readyState === "closing" || channel.readyState === "closed"');
  const distLowBufferReturn = distBackpressureBody.indexOf("channel.bufferedAmount <=");
  assert.notEqual(distTerminalCheck, -1);
  assert.notEqual(distLowBufferReturn, -1);
  assert.equal(distTerminalCheck < distLowBufferReturn, true);
  assert.match(distBackpressureBody, /let settled = false/);
  assert.match(distBackpressureBody, /const failIfTerminal = \(\) => \{[\s\S]*channel\.readyState === "closing" \|\| channel\.readyState === "closed"[\s\S]*\};/);
  assert.match(distBackpressureBody, /channel\.onbufferedamountlow = finish;[\s\S]*channel\.onclose = \(event\) => \{[\s\S]*fail[\s\S]*channel\.onerror = \(event\) => \{[\s\S]*fail[\s\S]*failIfTerminal\(\);/);
  assert.match(
    distWebBundle,
    /readyState===`closing`\|\|\w+\.readyState===`closed`[\s\S]{0,120}bufferedAmount<=8388608/
  );
  assert.doesNotMatch(distWebBundle, /function \w+\(e\)\{e\.bufferedAmount<=8388608/);
  assert.match(distWebBundle, /\$\{\w+\.label\} channel is \$\{\w+\.readyState\}\./);
});

test("PeerConnection waiters evaluate the current connection state immediately", () => {
  for (const source of [cliRtcSource, webSource]) {
    const body = source === cliRtcSource ? extractCreatePeerConnectedBody(source) : extractFunctionBody(source, "waitPeerConnected");
    assert.match(body, /const handleConnectionState = \(\) => \{[\s\S]*pc\.connectionState === "connected"[\s\S]*pc\.connectionState === "failed" \|\| pc\.connectionState === "closed" \|\| pc\.connectionState === "disconnected"[\s\S]*\};/);
    assert.match(body, /pc\.onconnectionstatechange = handleConnectionState;\s*handleConnectionState\(\);/);
  }
  const distCreatePeerBody = extractFunctionBody(distCliRtcSource, "createPeer");
  assert.match(distCreatePeerBody, /const handleConnectionState = \(\) => \{[\s\S]*pc\.connectionState === "connected"[\s\S]*pc\.connectionState === "failed" \|\| pc\.connectionState === "closed" \|\| pc\.connectionState === "disconnected"[\s\S]*\};/);
  assert.match(distCreatePeerBody, /pc\.onconnectionstatechange = handleConnectionState;\s*handleConnectionState\(\);/);
  assert.match(distWebBundle, /connectionState===`connected`\?Promise\.resolve\(\):new Promise/);
  assert.match(distWebBundle, /onconnectionstatechange=\w+,\w+\(\)/);
});

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  const bodyStart =
    name === "wireSignals"
      ? source.indexOf("{\n  const queuedCandidates", start)
      : name === "waitForIncomingChannels" || name === "waitIncomingChannels"
        ? firstPresentIndex(source, start, ["{\n  const channels", "{\n    const channels"])
        : findFunctionBodyStart(source, start + signature.length - 1);
  assert.notEqual(bodyStart, -1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not extract ${name} body.`);
}

function extractCreatePeerConnectedBody(source: string): string {
  const start = source.indexOf("const connected = new Promise<void>");
  assert.notEqual(start, -1);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error("Could not extract createPeer connected body.");
}

function firstPresentIndex(source: string, start: number, needles: string[]): number {
  for (const needle of needles) {
    const index = source.indexOf(needle, start);
    if (index !== -1) return index;
  }
  return -1;
}

function findFunctionBodyStart(source: string, index: number): number {
  let parenDepth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (char === "{" && parenDepth === 0 && source.slice(cursor - 3, cursor) !== "=> ") return cursor;
  }
  throw new Error("Could not find function body.");
}

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
