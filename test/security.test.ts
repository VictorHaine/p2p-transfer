import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  base64ToBytes,
  bytesToBase64,
  finishPake,
  openBulk,
  openControl,
  openManifest,
  ownPakeShareB64,
  pairDecisionAuthTag,
  parsePakeShareMessage,
  sdpAuthTag,
  sealBulk,
  sealControl,
  sealManifest,
  sessionConfirmTag,
  signalAuthTag,
  startPake,
  verifySessionConfirmTag,
  verifyPairDecisionAuthTag,
  verifySdpAuthTag,
  verifySignalAuthTag,
  wipePakeState,
  wipeSessionKeys
} from "../src/shared/security.js";
import {
  bytesToBase64 as distBytesToBase64,
  openBulk as distOpenBulk,
  openControl as distOpenControl,
  openManifest as distOpenManifest,
  parsePakeShareMessage as distParsePakeShareMessage,
  pairDecisionAuthTag as distPairDecisionAuthTag,
  sealBulk as distSealBulk,
  sealControl as distSealControl,
  sessionConfirmTag as distSessionConfirmTag,
  signalAuthTag as distSignalAuthTag,
  verifySessionConfirmTag as distVerifySessionConfirmTag,
  verifyPairDecisionAuthTag as distVerifyPairDecisionAuthTag,
  verifySignalAuthTag as distVerifySignalAuthTag
} from "../dist-node/shared/security.js";
import { CHUNK_SIZE, ENCRYPTED_JSON_MAX_CHARS, MAX_FILE_NAME_CHARS, MAX_FILES_PER_SESSION, PROTOCOL_VERSION, SIGNALING_MAX_PAYLOAD_BYTES } from "../src/shared/constants.js";
import { isClientMessage, isIceServers, isManifest, isServerMessage, parseBrowserJsonMessage, parseJsonMessage, parseJsonTextFrame, serializeMessage } from "../src/shared/messages.js";
import {
  isClientMessage as distIsClientMessage,
  isIceServers as distIsIceServers,
  isManifest as distIsManifest,
  isServerMessage as distIsServerMessage,
  parseJsonMessage as distParseJsonMessage,
  serializeMessage as distSerializeMessage
} from "../dist-node/shared/messages.js";
import type { PakeRole, SessionKeys } from "../src/shared/security.js";

const vectors = JSON.parse(fs.readFileSync(new URL("../conformance/protocol-v8.json", import.meta.url), "utf8")) as {
  pairDecisionAuth: {
    keyHex: string;
    sid: string;
    fromRole: PakeRole;
    decision: "accept" | "reject";
    sealedManifest: string;
    reason?: string;
    tagBase64: string;
  }[];
  encryptedJsonAead: {
    name: string;
    keyHex: string;
    sid: string;
    kind: "manifest" | "control";
    sealedBase64: string;
    plaintext: unknown;
  }[];
  bulkAead: {
    name: string;
    keyHex: string;
    sid: string;
    fileId: number;
    chunkSeq: number;
    payloadHex: string;
    sealedPayloadHex: string;
  }[];
  signalAuth: {
    keyHex: string;
    sid: string;
    fromRole: PakeRole;
    signal:
      | { kind: "offer"; sdp: string }
      | { kind: "answer"; sdp: string }
      | { kind: "candidate"; candidate: RTCIceCandidateInit };
    tagBase64: string;
  }[];
  sessionConfirm: {
    keyHex: string;
    sid: string;
    fromRole: PakeRole;
    tagBase64: string;
  }[];
};

const validTag = "A".repeat(43) + "=";
const validSealed = "A".repeat(20);
const messagesSource = fs.readFileSync(new URL("../src/shared/messages.ts", import.meta.url), "utf8");
const distMessagesSource = fs.readFileSync(new URL("../dist-node/shared/messages.js", import.meta.url), "utf8");
const securitySource = fs.readFileSync(new URL("../src/shared/security.ts", import.meta.url), "utf8");
const distSecuritySource = fs.readFileSync(new URL("../dist-node/shared/security.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("CPace derives matching directional session keys for the same code", async () => {
  const sid = "unit-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);

  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  assert.equal(senderKeys.sas, receiverKeys.sas);
  assert.deepEqual(sender.share, new Uint8Array(sender.share.length));
  assert.deepEqual(receiver.share, new Uint8Array(receiver.share.length));

  const manifest = { fileCount: 1, totalBytes: 5, files: [{ id: 0, name: "secret.txt", size: 5 }] };
  const sealedManifest = await sealManifest(senderKeys, manifest);
  assert.deepEqual(await openManifest(receiverKeys, sealedManifest), manifest);

  const sealedControl = await sealControl(senderKeys, { t: "file-begin", id: 0, name: "secret.txt", size: 5 });
  assert.deepEqual(await openControl(receiverKeys, sealedControl), { t: "file-begin", id: 0, name: "secret.txt", size: 5 });

  const payload = new TextEncoder().encode("hello");
  const sealedPayload = await sealBulk(senderKeys, 0, 7, payload);
  assert.deepEqual(await openBulk(receiverKeys, 0, 7, sealedPayload), payload);
});

test("wrong code cannot decrypt PAKE-derived payloads", async () => {
  const sid = "wrong-code-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const wrongReceiver = startPake("receiver", "123456-apple-artist", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);

  const senderKeys = await finishPake(sender, receiverShare);
  const wrongKeys = await finishPake(wrongReceiver, senderShare);
  const sealedManifest = await sealManifest(senderKeys, { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] });

  await assert.rejects(() => openManifest(wrongKeys, sealedManifest));
});

test("PAKE ephemeral secret is wiped even when peer share is invalid", async () => {
  const state = startPake("sender", "123456-apple-anchor", "wipe-session");
  assert.notDeepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.notDeepEqual(state.share, new Uint8Array(state.share.length));
  await assert.rejects(() => finishPake(state, "not-base64"));
  assert.deepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.deepEqual(state.share, new Uint8Array(state.share.length));
});

test("finishPake rejects wrong-sized CPace shares directly", async () => {
  const state = startPake("sender", "123456-apple-anchor", "wrong-size-share-session");

  await assert.rejects(() => finishPake(state, "AAAA"), /invalid PAKE share/);
  assert.deepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.deepEqual(state.share, new Uint8Array(state.share.length));
});

test("low-level authentication base64 decoding is size bounded before allocation", async () => {
  assert.match(securityPolicy, /base64 encoding and decoding helpers must reject malformed or non-canonical runtime values/);
  assert.match(securityPolicy, /low-level PAKE share and HMAC tag handling must reject wrong-sized base64 values before decoding/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const CPACE_SHARE_BASE64_CHARS = 44/);
    assert.match(source, /const HMAC_SHA256_BASE64_CHARS = 44/);
    assert.match(source, /const BASE64_DECODE_MAX_CHARS = ENCRYPTED_JSON_MAX_CHARS/);
    assert.match(source, /value\.length > BASE64_DECODE_MAX_CHARS[\s\S]*Invalid base64 payload/);
    assert.match(source, /peerShareB64\.length !== CPACE_SHARE_BASE64_CHARS[\s\S]*base64ToBytes\(peerShareB64\)/);
    assert.match(source, /const shareValue = ownDataValue\(parsed, "share"\)/);
    assert.match(source, /shareValue\.length !== CPACE_SHARE_BASE64_CHARS[\s\S]*base64ToBytes\(shareValue\)/);
    assert.match(source, /tag\.length !== HMAC_SHA256_BASE64_CHARS[\s\S]*base64ToBytes\(tag\)/);
  }
  assert.match(distWebBundle, /Invalid base64 payload/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /`share`/);

  const oversizedCanonicalBase64 = "A".repeat(4096);
  assert.throws(() => base64ToBytes("A".repeat(ENCRYPTED_JSON_MAX_CHARS + 4)), /Invalid base64 payload/);
  const state = startPake("sender", "123456-apple-anchor", "bounded-direct-share-session");
  await assert.rejects(() => finishPake(state, oversizedCanonicalBase64), /invalid PAKE share/);
  assert.deepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.deepEqual(state.share, new Uint8Array(state.share.length));
  assert.throws(() => parsePakeShareMessage(JSON.stringify({ t: "cpace-share", share: "A".repeat(4000) })), /invalid PAKE share/);
  const key = new Uint8Array(32);
  assert.equal(verifySignalAuthTag(key, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: oversizedCanonicalBase64 }), false);
  assert.equal(verifySdpAuthTag(key, "sid", "sender", "offer", "v=0\r\n", oversizedCanonicalBase64), false);
  assert.equal(verifySessionConfirmTag(key, "sid", "sender", oversizedCanonicalBase64), false);
});

test("base64 encoder rejects non-binary values before Buffer coercion", () => {
  assert.match(securityPolicy, /base64 encoding and decoding helpers must reject malformed or non-canonical runtime values before Buffer, atob, btoa, byte-length, iterator, or string conversion/);
  let coerced = false;
  const hostile = {
    valueOf() {
      coerced = true;
      return [1, 2, 3];
    },
    toString() {
      coerced = true;
      return "abc";
    }
  };

  assert.throws(() => bytesToBase64(hostile as never), /Invalid binary payload/);
  assert.throws(() => distBytesToBase64(hostile as never), /Invalid binary payload/);
  assert.equal(coerced, false);

  let typedArrayGetterInvoked = false;
  class HostileBytes extends Uint8Array {
    override get byteLength() {
      typedArrayGetterInvoked = true;
      return 3;
    }
  }
  const hostileBytes = new HostileBytes([1, 2, 3]);
  assert.throws(() => bytesToBase64(hostileBytes), /Invalid binary payload/);
  assert.throws(() => distBytesToBase64(hostileBytes), /Invalid binary payload/);
  assert.equal(typedArrayGetterInvoked, false);

  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /function bytesToBase64/);
    assert.match(source, /canonicalUint8ArrayByteLength\(bytes, "Invalid binary payload\."\)/);
    assert.match(source, /Invalid binary payload/);
  }
  assert.match(distWebBundle, /Invalid binary payload/);
});

test("low-level PAKE context inputs are bounded before key derivation", async () => {
  assert.match(securityPolicy, /low-level PAKE and signal-auth helpers must validate role, session id, and code context bounds before key derivation or HMAC/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const MAX_PAKE_CONTEXT_CHARS = 256/);
    assert.match(source, /function assertPakeRole/);
    assert.match(source, /function assertPakeSid/);
    assert.match(source, /function assertPakeCode/);
    assert.match(source, /assertPakeRole\(role\);[\s\S]*assertPakeCode\(code\);[\s\S]*assertPakeSid\(sid\)/);
    assert.match(source, /const stateParts = readPakeState\(state\)/);
    assert.match(source, /assertPakeRole\(role\);[\s\S]*assertPakeSid\(sid\)/);
  }
  assert.match(distWebBundle, /PAKE role is invalid/);
  assert.match(distWebBundle, /PAKE session id is invalid/);
  assert.match(distWebBundle, /PAKE code is invalid/);

  assert.throws(() => startPake("sender", "x".repeat(257), "sid"), /PAKE code is invalid/);
  assert.throws(() => startPake("sender", "bad\u202ecode", "sid"), /PAKE code is invalid/);
  assert.throws(() => startPake("sender", "123456-apple-anchor", "bad\nsid"), /PAKE session id is invalid/);
  assert.throws(() => startPake("sender", "123456-apple-anchor", "bad.sid"), /PAKE session id is invalid/);
  assert.throws(() => startPake("intruder" as never, "123456-apple-anchor", "sid"), /PAKE role is invalid/);

  const state = startPake("sender", "123456-apple-anchor", "valid-sid");
  state.sid = "bad\nsid";
  await assert.rejects(() => finishPake(state, "A".repeat(44)), /PAKE session id is invalid/);
  assert.deepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.deepEqual(state.share, new Uint8Array(state.share.length));

  const key = new Uint8Array(32);
  assert.throws(() => sessionConfirmTag(key, "bad\nsid", "sender"), /PAKE session id is invalid/);
  assert.throws(() => sessionConfirmTag(key, "sid", "bogus" as never), /PAKE role is invalid/);
  assert.throws(() => signalAuthTag(key, "bad.sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /PAKE session id is invalid/);
  assert.equal(verifySignalAuthTag(key, "bad\nsid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
});

test("HMAC authentication helpers reject hostile keys before dependency calls", () => {
  assert.match(securityPolicy, /exported HMAC authentication helpers must reject non-canonical or non-32-byte binary keys and copy them before dependency calls/);

  let lengthRead = false;
  const hostileKey = {};
  Object.defineProperty(hostileKey, "length", {
    get() {
      lengthRead = true;
      return 32;
    }
  });

  assert.throws(() => signalAuthTag(hostileKey as never, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => sessionConfirmTag(hostileKey as never, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSignalAuthTag(hostileKey as never, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSessionConfirmTag(hostileKey as never, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.equal(verifySignalAuthTag(hostileKey as never, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(verifySessionConfirmTag(hostileKey as never, "sid", "sender", validTag), false);
  assert.equal(distVerifySignalAuthTag(hostileKey as never, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(distVerifySessionConfirmTag(hostileKey as never, "sid", "sender", validTag), false);
  assert.equal(lengthRead, false);

  let typedArrayGetterInvoked = false;
  class HostileAuthKey extends Uint8Array {
    override get byteLength() {
      typedArrayGetterInvoked = true;
      return 32;
    }
  }
  const hostileTypedArray = new HostileAuthKey(32);
  assert.throws(() => signalAuthTag(hostileTypedArray, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => sessionConfirmTag(hostileTypedArray, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSignalAuthTag(hostileTypedArray, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSessionConfirmTag(hostileTypedArray, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.equal(verifySignalAuthTag(hostileTypedArray, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(verifySessionConfirmTag(hostileTypedArray, "sid", "sender", validTag), false);
  assert.equal(distVerifySignalAuthTag(hostileTypedArray, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(distVerifySessionConfirmTag(hostileTypedArray, "sid", "sender", validTag), false);
  assert.equal(typedArrayGetterInvoked, false);

  const shortKey = new Uint8Array(31);
  const longKey = new Uint8Array(33);
  assert.throws(() => signalAuthTag(shortKey, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => sessionConfirmTag(longKey, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSignalAuthTag(shortKey, "sid", "sender", { kind: "offer", sdp: "v=0\r\n" }), /Authentication key must be 32-byte binary/);
  assert.throws(() => distSessionConfirmTag(longKey, "sid", "sender"), /Authentication key must be 32-byte binary/);
  assert.equal(verifySignalAuthTag(shortKey, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(verifySessionConfirmTag(longKey, "sid", "sender", validTag), false);
  assert.equal(distVerifySignalAuthTag(shortKey, "sid", "sender", { kind: "offer", sdp: "v=0\r\n", auth: validTag }), false);
  assert.equal(distVerifySessionConfirmTag(longKey, "sid", "sender", validTag), false);

  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const AUTHENTICATION_KEY_BYTES = 32/);
    assert.match(source, /function authenticationKeyCopy/);
    assert.match(source, /function canonicalUint8ArrayByteLength/);
    assert.match(source, /function isCanonicalBinaryPrototype/);
    assert.match(source, /prototype === Uint8Array\.prototype/);
    assert.match(source, /prototype === Buffer\.prototype/);
    assert.match(source, /Authentication key must be 32-byte binary/);
    assert.match(source, /const authKey = authenticationKeyCopy\(key\);[\s\S]*hmac\(sha256, authKey/);
    assert.doesNotMatch(source, /hmac\(sha256, key/);
  }
  assert.match(distWebBundle, /Authentication key must be 32-byte binary/);
  assert.match(distWebBundle, /WebRTC signal auth payload is invalid/);
  assert.match(distWebBundle, /PAKE confirmation failed/);
});

test("PAKE state can be explicitly wiped before finish", () => {
  const state = startPake("receiver", "123456-apple-anchor", "explicit-wipe-session");
  assert.notDeepEqual(state.share, new Uint8Array(state.share.length));
  wipePakeState(state);
  assert.deepEqual(state.ephemeralSecret, new Uint8Array(state.ephemeralSecret.length));
  assert.deepEqual(state.share, new Uint8Array(state.share.length));
});

test("PAKE cleanup helpers read own data properties without invoking accessors", async () => {
  assert.match(securityPolicy, /PAKE state and session cleanup helpers must read cleanup fields through own data descriptors, require canonical PAKE state byte arrays before finish/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /function readPakeState/);
    assert.match(source, /function fillOwnBytes/);
    assert.match(source, /canonicalUint8ArrayByteLength\(ephemeralSecret, "PAKE state is invalid\."\)/);
    assert.match(source, /canonicalUint8ArrayByteLength\(share, "PAKE state is invalid\."\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor/);
    assert.doesNotMatch(source, /state\.ephemeralSecret\.fill/);
    assert.doesNotMatch(source, /keys\.signalAuthKey\.fill/);
  }
  assert.match(distWebBundle, /PAKE state is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /\.fill\(0\)/);
  assert.doesNotMatch(distWebBundle, /e\.ephemeralSecret\.fill\(0\),e\.share\.fill\(0\)/);
  assert.doesNotMatch(distWebBundle, /e\.signalAuthKey\.fill\(0\),delete e\.manifestKey/);

  let shareGetterInvoked = false;
  const accessorShareState = { role: "sender", sid: "sid", ephemeralSecret: new Uint8Array(32) };
  Object.defineProperty(accessorShareState, "share", {
    get() {
      shareGetterInvoked = true;
      throw new Error("share getter executed");
    }
  });
  assert.throws(() => ownPakeShareB64(accessorShareState as never), /PAKE state is invalid/);
  assert.equal(shareGetterInvoked, false);

  let wipeGetterInvoked = false;
  const ephemeralSecret = new Uint8Array(32).fill(1);
  const share = new Uint8Array(32).fill(2);
  const wipeState = { role: "receiver" as const, sid: "sid", protocolVersion: PROTOCOL_VERSION, ephemeralSecret, share };
  Object.defineProperty(wipeState, "trap", {
    get() {
      wipeGetterInvoked = true;
      throw new Error("wipe getter executed");
    }
  });
  wipePakeState(wipeState);
  assert.deepEqual(ephemeralSecret, new Uint8Array(32));
  assert.deepEqual(share, new Uint8Array(32));
  assert.equal(wipeGetterInvoked, false);

  let finishGetterInvoked = false;
  const badEphemeralSecret = new Uint8Array(32).fill(3);
  const badShare = new Uint8Array(32).fill(4);
  const badState = { sid: "sid", ephemeralSecret: badEphemeralSecret, share: badShare };
  Object.defineProperty(badState, "role", {
    get() {
      finishGetterInvoked = true;
      throw new Error("role getter executed");
    }
  });
  await assert.rejects(() => finishPake(badState as never, "A".repeat(44)), /PAKE (role|state) is invalid/);
  assert.deepEqual(badEphemeralSecret, new Uint8Array(32));
  assert.deepEqual(badShare, new Uint8Array(32));
  assert.equal(finishGetterInvoked, false);

  let byteLengthGetterInvoked = false;
  class HostilePakeBytes extends Uint8Array {
    override get byteLength() {
      byteLengthGetterInvoked = true;
      return 32;
    }
  }
  const subclassState = {
    role: "sender",
    sid: "sid",
    protocolVersion: PROTOCOL_VERSION,
    ephemeralSecret: new HostilePakeBytes(32),
    share: new Uint8Array(32)
  };
  await assert.rejects(() => finishPake(subclassState as never, "A".repeat(44)), /PAKE state is invalid/);
  assert.equal(byteLengthGetterInvoked, false);

  let keyGetterInvoked = false;
  const accessorKeys = {};
  Object.defineProperty(accessorKeys, "destroyed", {
    get() {
      keyGetterInvoked = true;
      throw new Error("destroyed getter executed");
    }
  });
  Object.defineProperty(accessorKeys, "signalAuthKey", {
    get() {
      keyGetterInvoked = true;
      throw new Error("signalAuthKey getter executed");
    }
  });
  assert.doesNotThrow(() => wipeSessionKeys(accessorKeys as never));
  assert.equal(keyGetterInvoked, false);
});

test("PAKE share message parser rejects malformed peer blobs", () => {
  const share = ownPakeShareB64(startPake("sender", "123456-apple-anchor", "parse-share-session"));
  assert.equal(parsePakeShareMessage(JSON.stringify({ t: "cpace-share", share })), share);
  assert.equal(distParsePakeShareMessage(JSON.stringify({ t: "cpace-share", share })), share);
  assert.throws(() => parsePakeShareMessage(""), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage(" ".repeat(4097)), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage("{"), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage("[]"), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage('{"t":"other","share":"abcd"}'), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage('{"t":"cpace-share","share":42}'), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage(`{"t":"cpace-share","share":${JSON.stringify(share)},"extra":true}`), /invalid PAKE message/);
  assert.throws(() => parsePakeShareMessage('{"t":"cpace-share","share":"not-base64"}'), /invalid PAKE share/);
  assert.throws(() => parsePakeShareMessage('{"t":"cpace-share","share":"abcd"}'), /invalid PAKE share/);
});

test("PAKE and encrypted manifest wrappers do not read inherited wrapper fields", async () => {
  assert.match(securityPolicy, /PAKE share and encrypted manifest wrapper parsers must read wrapper fields through own data descriptors/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const type = ownDataValue\(parsed, "t"\)/);
    assert.match(source, /const shareValue = ownDataValue\(parsed, "share"\)/);
    assert.match(source, /const type = ownDataValue\(opened, "t"\)/);
    assert.match(source, /const manifest = ownDataValue\(opened, "manifest"\)/);
    assert.match(source, /const pad = ownDataValue\(opened, "pad"\)/);
    assert.doesNotMatch(source, /parsed\.t/);
    assert.doesNotMatch(source, /parsed\.share/);
    assert.doesNotMatch(source, /opened\.t/);
    assert.doesNotMatch(source, /opened\.manifest/);
  }
  assert.match(distWebBundle, /`cpace-share`/);
  assert.match(distWebBundle, /`manifest`/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);

  const sid = "wrapper-own-fields-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const share = ownPakeShareB64(startPake("sender", "123456-apple-anchor", "parse-share-pollution-session"));
  const missingPakeType = JSON.stringify({ share });
  const missingManifestType = await sealRawManifestWrapperForTest(senderKeys, { manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] } });

  const originalType = Object.getOwnPropertyDescriptor(Object.prototype, "t");
  let inheritedGetterReads = 0;
  let sourcePakeRejected = false;
  let distPakeRejected = false;
  let sourceManifestRejected = false;
  let distManifestRejected = false;
  try {
    Object.defineProperty(Object.prototype, "t", {
      configurable: true,
      get() {
        inheritedGetterReads += 1;
        return "pair-manifest";
      }
    });

    try {
      parsePakeShareMessage(missingPakeType);
    } catch {
      sourcePakeRejected = true;
    }
    try {
      distParsePakeShareMessage(missingPakeType);
    } catch {
      distPakeRejected = true;
    }
    try {
      await openManifest(receiverKeys, missingManifestType);
    } catch {
      sourceManifestRejected = true;
    }
    try {
      await distOpenManifest(receiverKeys, missingManifestType);
    } catch {
      distManifestRejected = true;
    }
  } finally {
    if (originalType) Object.defineProperty(Object.prototype, "t", originalType);
    else delete (Object.prototype as Record<string, unknown>).t;
  }
  assert.equal(sourcePakeRejected, true);
  assert.equal(distPakeRejected, true);
  assert.equal(sourceManifestRejected, true);
  assert.equal(distManifestRejected, true);
  assert.equal(inheritedGetterReads, 0);
});

test("session key wipe clears mutable authentication material and disables AEAD use", async () => {
  const sid = "session-wipe";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const keys = await finishPake(sender, ownPakeShareB64(receiver));
  assert.equal(keys.destroyed, false);
  assert.notDeepEqual(keys.signalAuthKey, new Uint8Array(keys.signalAuthKey.length));
  wipeSessionKeys(keys);
  assert.equal(keys.destroyed, true);
  assert.deepEqual(keys.signalAuthKey, new Uint8Array(keys.signalAuthKey.length));
  for (const property of ["manifestKey", "controlSendKey", "controlRecvKey", "bulkSendKey", "bulkRecvKey"]) {
    assert.equal(Object.hasOwn(keys, property), false);
  }
  await assert.rejects(() => sealControl(keys, { t: "all-done" }), /wiped/);
  await assert.rejects(() => openControl(keys, "AAAA"), /wiped/);
  wipePakeState(receiver);
});

test("AEAD helpers reject accessor-backed session keys before key reads", async () => {
  assert.match(securityPolicy, /exported AEAD helpers must read session key fields through own data descriptors and require non-destroyed `CryptoKey` fields/);

  let getterInvoked = false;
  const accessorKeys = {};
  for (const property of ["destroyed", "sid", "manifestKey", "controlSendKey", "controlRecvKey", "bulkSendKey", "bulkRecvKey"]) {
    Object.defineProperty(accessorKeys, property, {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error(`${property} getter executed`);
      }
    });
  }

  for (const helper of [
    () => sealControl(accessorKeys as never, { t: "all-done" }),
    () => openControl(accessorKeys as never, "AAAA"),
    () => sealBulk(accessorKeys as never, 0, 0, new Uint8Array()),
    () => openBulk(accessorKeys as never, 0, 0, new Uint8Array()),
    () => distSealControl(accessorKeys as never, { t: "all-done" }),
    () => distOpenControl(accessorKeys as never, "AAAA"),
    () => distSealBulk(accessorKeys as never, 0, 0, new Uint8Array()),
    () => distOpenBulk(accessorKeys as never, 0, 0, new Uint8Array())
  ]) {
    await assert.rejects(helper, /Session keys have been wiped|PAKE session id is invalid/);
  }
  assert.equal(getterInvoked, false);

  const bogusKeys = {
    destroyed: false,
    sid: "sid",
    manifestKey: {},
    controlSendKey: {},
    controlRecvKey: {},
    bulkSendKey: {},
    bulkRecvKey: {}
  };
  await assert.rejects(() => sealControl(bogusKeys as never, { t: "all-done" }), /Session keys have been wiped/);
  await assert.rejects(() => openControl(bogusKeys as never, "AAAA"), /Session keys have been wiped/);
  await assert.rejects(() => distSealControl(bogusKeys as never, { t: "all-done" }), /Session keys have been wiped/);
  await assert.rejects(() => distOpenControl(bogusKeys as never, "AAAA"), /Session keys have been wiped/);

  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /function activeSessionKeys/);
    assert.match(source, /ownDataValue\(keys, "destroyed"\) !== false/);
    assert.match(source, /ownDataValue\(keys, "sid"\)/);
    assert.match(source, /ownDataValue\(keys, "bulkSendKey"\)/);
    assert.match(source, /function assertCryptoKey/);
    assert.match(source, /RuntimeCryptoKey/);
    assert.match(source, /assertCryptoKey\(manifestKey\)/);
    assert.match(source, /assertCryptoKey\(bulkRecvKey\)/);
    assert.doesNotMatch(source, /keys\.destroyed \|\| !keys\.manifestKey/);
  }
  assert.match(distWebBundle, /Session keys have been wiped/);
  assert.match(distWebBundle, /CryptoKey/);
  assert.doesNotMatch(distWebBundle, /if\(e\.destroyed\|\|!e\.manifestKey/);
});

test("session AES keys are imported with least-privilege WebCrypto usages", async () => {
  assert.match(securityPolicy, /WebCrypto AES keys must be imported with the minimum role-specific usages/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /manifestKey: await importAesKey\(raw\.manifestKey, stateParts\.role === "sender" \? \["encrypt"\] : \["decrypt"\]\)/);
    assert.match(source, /controlSendKey: await importAesKey\(stateParts\.role === "sender" \? raw\.controlSenderToReceiver : raw\.controlReceiverToSender, \["encrypt"\]\)/);
    assert.match(source, /controlRecvKey: await importAesKey\(stateParts\.role === "sender" \? raw\.controlReceiverToSender : raw\.controlSenderToReceiver, \["decrypt"\]\)/);
    assert.match(source, /bulkSendKey: await importAesKey\(stateParts\.role === "sender" \? raw\.bulkSenderToReceiver : raw\.bulkReceiverToSender, \["encrypt"\]\)/);
    assert.match(source, /bulkRecvKey: await importAesKey\(stateParts\.role === "sender" \? raw\.bulkReceiverToSender : raw\.bulkSenderToReceiver, \["decrypt"\]\)/);
  }
  assert.match(distWebBundle, /`encrypt`/);
  assert.match(distWebBundle, /`decrypt`/);
  assert.match(distWebBundle, /crypto\.subtle\.importKey/);

  const sid = "least-privilege-key-usages";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);

  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  assert.deepEqual(senderKeys.manifestKey?.usages, ["encrypt"]);
  assert.deepEqual(receiverKeys.manifestKey?.usages, ["decrypt"]);
  for (const keys of [senderKeys, receiverKeys]) {
    assert.deepEqual(keys.controlSendKey?.usages, ["encrypt"]);
    assert.deepEqual(keys.controlRecvKey?.usages, ["decrypt"]);
    assert.deepEqual(keys.bulkSendKey?.usages, ["encrypt"]);
    assert.deepEqual(keys.bulkRecvKey?.usages, ["decrypt"]);
  }
});

test("raw PAKE-derived key buffers are wiped after explicit session key copies", () => {
  assert.match(securityPolicy, /raw PAKE\/HKDF output buffers .*must be wiped/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /signalAuthKey: webBytes\(raw\.signalAuthKey\)/);
    assert.match(source, /raw\.signalAuthKey\.fill\(0\)/);
    for (const name of ["manifestKey", "controlSenderToReceiver", "controlReceiverToSender", "bulkSenderToReceiver", "bulkReceiverToSender", "sas"]) {
      assert.match(source, new RegExp(`raw\\.${name}\\.fill\\(0\\)`));
    }
  }
});

test("WebCrypto AEAD input copies are explicit and wiped", () => {
  assert.match(securityPolicy, /WebCrypto input copies of keys, nonces, AAD, plaintext, or ciphertext must be wiped/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const rawForWebCrypto = webBytes\(raw\)/);
    assert.match(source, /await crypto\.subtle\.importKey\("raw", rawForWebCrypto, "AES-GCM", false, usages\)/);
    assert.match(source, /rawForWebCrypto\.fill\(0\)/);
    assert.match(source, /const nonceForWebCrypto = webBytes\(nonce\)/);
    assert.match(source, /const aadForWebCrypto = webBytes\(aad\)/);
    assert.match(source, /iv: nonceForWebCrypto, additionalData: aadForWebCrypto/);
    assert.match(source, /nonceForWebCrypto\.fill\(0\)/);
    assert.match(source, /aadForWebCrypto\.fill\(0\)/);
    assert.match(source, /const plaintextForWebCrypto = webBytes\(plaintext\)/);
    assert.match(source, /key, plaintextForWebCrypto/);
    assert.match(source, /plaintextForWebCrypto\.fill\(0\)/);
    assert.match(source, /const plaintext = webBytes\(payload\)/);
    assert.match(source, /activeKeys\.bulkSendKey,\s*plaintext/);
    assert.match(source, /plaintext\.fill\(0\)/);
    assert.match(source, /const ciphertext = webBytes\(sealedPayload\)/);
    assert.match(source, /activeKeys\.bulkRecvKey,\s*ciphertext/);
    assert.match(source, /ciphertext\.fill\(0\)/);
    assert.match(source, /const ciphertextForWebCrypto = webBytes\(ciphertext\)/);
    assert.match(source, /key, ciphertextForWebCrypto/);
    assert.match(source, /ciphertextForWebCrypto\.fill\(0\)/);
  }
  assert.match(distWebBundle, /crypto\.subtle\.importKey/);
  assert.match(distWebBundle, /crypto\.subtle\.encrypt/);
  assert.match(distWebBundle, /crypto\.subtle\.decrypt/);
  assert.match(distWebBundle, /Encrypted payload decrypt failed/);
  assert.match(distWebBundle, /Encrypted bulk chunk decrypt failed/);
  assert.match(distWebBundle, /\.fill\(0\)/);
});

test("encrypted JSON wrapper validation requires plain objects", () => {
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const prototype = Object\.getPrototypeOf\(value\)/);
    assert.match(source, /prototype === Object\.prototype \|\| prototype === null/);
  }
});

test("PAKE parser enforces its own payload bound before JSON parsing", () => {
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const MAX_PAKE_MESSAGE_BYTES = 4096/);
    assert.match(source, /utf8ByteLengthExceeds\(data, MAX_PAKE_MESSAGE_BYTES\)/);
  }
  const oversizedBytePakeMessage = "😀".repeat(1_025);
  assert.equal(oversizedBytePakeMessage.length < 4096, true);
  assert.throws(() => parsePakeShareMessage(oversizedBytePakeMessage), /invalid PAKE message/);
  assert.throws(() => distParsePakeShareMessage(oversizedBytePakeMessage), /invalid PAKE message/);
  assert.match(distWebBundle, /Peer sent an invalid PAKE message/);
});

test("encrypted JSON openers reject non-text frames without coercion", async () => {
  const sid = "control-frame-type";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const sealedControl = await sealControl(senderKeys, { t: "all-done" });
  const sealedManifest = await sealManifest(senderKeys, { fileCount: 0, totalBytes: 0, files: [] });
  let coerced = false;
  const coercingFrame = {
    toString() {
      coerced = true;
      return sealedControl;
    }
  };

  await assert.rejects(() => openControl(receiverKeys, new TextEncoder().encode(sealedControl)), /text frame/);
  await assert.rejects(() => openControl(receiverKeys, coercingFrame), /text frame/);
  await assert.rejects(() => openManifest(receiverKeys, new TextEncoder().encode(sealedManifest)), /text frame/);
  assert.equal(coerced, false);
});

test("encrypted manifest opener rejects malformed wrappers before manifest validation", async () => {
  const sid = "manifest-wrapper-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  const missingManifest = await sealManifest(senderKeys, undefined);
  await assert.rejects(() => openManifest(receiverKeys, missingManifest), /wrapper is invalid/);
  await assert.rejects(() => distOpenManifest(receiverKeys, missingManifest), /wrapper is invalid/);

  const validManifest = { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] };
  const sealed = await sealManifest(senderKeys, validManifest);
  assert.deepEqual(await openManifest(receiverKeys, sealed), validManifest);
  assert.deepEqual(await distOpenManifest(receiverKeys, sealed), validManifest);

  const invalidPad = await sealRawManifestWrapperForTest(senderKeys, { t: "pair-manifest", manifest: validManifest, pad: 42 });
  await assert.rejects(() => openManifest(receiverKeys, invalidPad), /wrapper is invalid/);
  await assert.rejects(() => distOpenManifest(receiverKeys, invalidPad), /wrapper is invalid/);
});

test("sealed manifests are bucket padded so encrypted name length is not exact", async () => {
  assert.match(securityPolicy, /encrypted manifest wrappers must be padded before AEAD sealing/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const MANIFEST_PADDING_BUCKET_BYTES = 4096/);
    assert.match(source, /function paddedManifestWrapper/);
    assert.match(source, /function manifestPaddingTargetBytes/);
    assert.match(source, /paddedManifestWrapper\(manifest\)/);
  }

  const sid = "manifest-padding-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const shortManifest = {
    fileCount: 1,
    totalBytes: 5,
    files: [{ id: 0, name: "a.txt", size: 5, mime: "text/plain" }]
  };
  const longManifest = {
    fileCount: 1,
    totalBytes: 5,
    files: [{ id: 0, name: `${"very-long-private-name-".repeat(32)}.txt`, size: 5, mime: "application/x-private-transfer-test" }]
  };

  const shortSealed = await sealManifest(senderKeys, shortManifest);
  const longSealed = await sealManifest(senderKeys, longManifest);
  assert.equal(shortSealed.length, longSealed.length);
  assert.deepEqual(await openManifest(receiverKeys, shortSealed), shortManifest);
  assert.deepEqual(await openManifest(receiverKeys, longSealed), longManifest);
});

test("SDP authentication binds offer/answer bytes to the PAKE key", async () => {
  const sid = "sdp-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  const sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
  const tag = sdpAuthTag(senderKeys.signalAuthKey, sid, "sender", "offer", sdp);
  assert.equal(verifySdpAuthTag(receiverKeys.signalAuthKey, sid, "sender", "offer", sdp, tag), true);
  assert.equal(verifySdpAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "offer", sdp, tag), false);
  assert.equal(verifySdpAuthTag(receiverKeys.signalAuthKey, sid, "sender", "offer", `${sdp}a=tampered\r\n`, tag), false);
  assert.equal(verifySdpAuthTag(receiverKeys.signalAuthKey, sid, "sender", "answer", sdp, tag), false);
  assert.equal(verifySdpAuthTag(receiverKeys.signalAuthKey, sid, "sender", "offer", sdp, "not-base64"), false);
});

test("PAKE confirmation proves both peers derived the same session key", async () => {
  const sid = "confirm-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const wrongReceiver = startPake("receiver", "123456-apple-artist", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const wrongKeys = await finishPake(wrongReceiver, senderShare);

  const senderTag = sessionConfirmTag(senderKeys.signalAuthKey, sid, "sender");
  assert.equal(verifySessionConfirmTag(receiverKeys.signalAuthKey, sid, "sender", senderTag), true);
  assert.equal(verifySessionConfirmTag(receiverKeys.signalAuthKey, sid, "receiver", senderTag), false);
  assert.equal(verifySessionConfirmTag(wrongKeys.signalAuthKey, sid, "sender", senderTag), false);
  assert.equal(verifySessionConfirmTag(receiverKeys.signalAuthKey, "other-session", "sender", senderTag), false);
});

test("PAKE transcript binds the protocol version", async () => {
  assert.match(securityPolicy, /PAKE confirmation and session key derivation must bind the protocol version/);
  const sid = "protocol-version-session";
  const sender = startPake("sender", "123456-apple-anchor", sid, PROTOCOL_VERSION);
  const receiver = startPake("receiver", "123456-apple-anchor", sid, PROTOCOL_VERSION + 1);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const senderTag = sessionConfirmTag(senderKeys.signalAuthKey, sid, "sender", senderKeys.protocolVersion);
  assert.equal(senderKeys.protocolVersion, PROTOCOL_VERSION);
  assert.equal(receiverKeys.protocolVersion, PROTOCOL_VERSION + 1);
  assert.equal(verifySessionConfirmTag(receiverKeys.signalAuthKey, sid, "sender", senderTag, receiverKeys.protocolVersion), false);
  assert.notEqual(senderKeys.sas, receiverKeys.sas);
});

test("pair decisions are authenticated and bound to the sealed manifest", async () => {
  assert.match(securityPolicy, /`pair-accept` and `pair-reject` decisions must be authenticated with the PAKE-derived signal-auth key/);
  const sid = "pair-decision-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const wrongReceiver = startPake("receiver", "123456-apple-artist", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const wrongKeys = await finishPake(wrongReceiver, senderShare);
  const sealedManifest = await sealManifest(senderKeys, { fileCount: 1, totalBytes: 5, files: [{ id: 0, name: "secret.txt", size: 5 }] });
  const tamperedManifest = await sealManifest(senderKeys, { fileCount: 1, totalBytes: 5, files: [{ id: 0, name: "other.txt", size: 5 }] });

  const acceptAuth = pairDecisionAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, acceptAuth), true);
  assert.equal(distVerifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, acceptAuth), true);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "accept", tamperedManifest, undefined, acceptAuth), false);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, "other-session", "receiver", "accept", sealedManifest, undefined, acceptAuth), false);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "sender", "accept", sealedManifest, undefined, acceptAuth), false);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, undefined, acceptAuth), false);
  assert.equal(verifyPairDecisionAuthTag(wrongKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, acceptAuth), false);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, "not-base64"), false);

  const rejectAuth = distPairDecisionAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "user_declined");
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "user_declined", rejectAuth), true);
  assert.equal(distVerifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "user_declined", rejectAuth), true);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "other_reason", rejectAuth), false);
  assert.equal(verifyPairDecisionAuthTag(senderKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, undefined, rejectAuth), false);
  assert.throws(() => pairDecisionAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "other_reason"), /Pair decision reason is invalid/);
  assert.throws(() => distPairDecisionAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "reject", sealedManifest, "other_reason"), /Pair decision reason is invalid/);
  assert.throws(() => pairDecisionAuthTag(receiverKeys.signalAuthKey, sid, "receiver", "accept", sealedManifest, "user_declined"), /Pair decision reason is invalid/);
});

test("WebRTC signal authentication also binds ICE candidates", async () => {
  const sid = "candidate-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const candidate = { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 };
  const auth = signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate });

  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate, auth }), true);
  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "receiver", { kind: "candidate", candidate, auth }), false);
  assert.equal(
    verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", {
      kind: "candidate",
      candidate: { candidate: "candidate:0 1 UDP 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      auth
    }),
    false
  );
  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, "other-session", "sender", { kind: "candidate", candidate, auth }), false);
});

test("low-level WebRTC signal authentication rejects noncanonical signal shapes", async () => {
  const sid = "signal-shape-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  await finishPake(receiver, senderShare);

  assert.throws(
    () => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, ignored: "field" } as never }),
    /signal auth payload/
  );
  assert.throws(
    () => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host" } as never }),
    /signal auth payload/
  );
  assert.throws(
    () => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: "v=0\r\n", extra: true } as never),
    /signal auth payload/
  );
  assert.equal(
    verifySignalAuthTag(senderKeys.signalAuthKey, sid, "sender", {
      kind: "candidate",
      candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, ignored: "field" } as never,
      auth: validTag
    }),
    false
  );

  const hiddenExtraOffer = { kind: "offer", sdp: "v=0\r\n" };
  Object.defineProperty(hiddenExtraOffer, "extra", { enumerable: false, value: true });
  assert.throws(() => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", hiddenExtraOffer as never), /signal auth payload/);
  const hiddenRequiredOffer = { kind: "offer" };
  Object.defineProperty(hiddenRequiredOffer, "sdp", { enumerable: false, value: "v=0\r\n" });
  assert.throws(() => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", hiddenRequiredOffer as never), /signal auth payload/);
  const symbolExtraCandidate = { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 };
  Object.defineProperty(symbolExtraCandidate, Symbol("extra"), { enumerable: true, value: true });
  assert.throws(() => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: symbolExtraCandidate } as never), /signal auth payload/);
});

test("low-level WebRTC signal authentication rejects accessor-backed shapes without invoking getters", async () => {
  const sid = "signal-accessor-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const validOfferAuth = signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: "v=0\r\n" });
  let rootGetterCalled = false;
  const accessorRoot = { auth: validOfferAuth };
  Object.defineProperty(accessorRoot, "kind", {
    enumerable: true,
    get() {
      rootGetterCalled = true;
      return "offer";
    }
  });
  Object.defineProperty(accessorRoot, "sdp", { enumerable: true, value: "v=0\r\n" });

  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", accessorRoot as never), false);
  assert.equal(rootGetterCalled, false);

  let authGetterCalled = false;
  const accessorAuth = { kind: "offer", sdp: "v=0\r\n" };
  Object.defineProperty(accessorAuth, "auth", {
    enumerable: true,
    get() {
      authGetterCalled = true;
      return validOfferAuth;
    }
  });
  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", accessorAuth as never), false);
  assert.equal(authGetterCalled, false);

  let candidateGetterCalled = false;
  const accessorCandidate = { sdpMid: "0", sdpMLineIndex: 0 };
  Object.defineProperty(accessorCandidate, "candidate", {
    enumerable: true,
    get() {
      candidateGetterCalled = true;
      return "candidate:0 1 UDP 1 127.0.0.1 9 typ host";
    }
  });
  assert.equal(
    verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", {
      kind: "candidate",
      candidate: accessorCandidate as never,
      auth: validTag
    }),
    false
  );
  assert.equal(candidateGetterCalled, false);

  assert.throws(
    () => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: accessorCandidate as never }),
    /signal auth payload/
  );
  assert.equal(candidateGetterCalled, false);
});

test("low-level WebRTC signal authentication does not read inherited signal getters", async () => {
  assert.match(securityPolicy, /read canonical SDP\/ICE fields through own data descriptors/);
  const sid = "signal-inherited-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const validOffer = { kind: "offer" as const, sdp: "v=0\r\n" };
  const validOfferAuth = signalAuthTag(senderKeys.signalAuthKey, sid, "sender", validOffer);
  const validCandidate = { kind: "candidate" as const, candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } };
  const keys = ["kind", "sdp", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment", "auth"];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let inheritedGetterReads = 0;
  let observedInheritedGetterReads = -1;
  try {
    for (const key of keys) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          inheritedGetterReads += 1;
          return undefined;
        },
        set() {
          // Some platform/test objects assign these common names while assertions run.
        }
      });
    }

    for (const tag of [signalAuthTag, distSignalAuthTag]) {
      if (tag(senderKeys.signalAuthKey, sid, "sender", validOffer) !== validOfferAuth) throw new Error("offer signal auth changed.");
      if (typeof tag(senderKeys.signalAuthKey, sid, "sender", validCandidate) !== "string") throw new Error("candidate signal auth failed.");
      let missingSdpRejected = false;
      try {
        tag(senderKeys.signalAuthKey, sid, "sender", { kind: "offer" } as never);
      } catch {
        missingSdpRejected = true;
      }
      if (!missingSdpRejected) throw new Error("missing SDP was accepted.");
      let missingCandidateMidRejected = false;
      try {
        tag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host" } } as never);
      } catch {
        missingCandidateMidRejected = true;
      }
      if (!missingCandidateMidRejected) throw new Error("candidate without mid/index was accepted.");
    }

    for (const verify of [verifySignalAuthTag, distVerifySignalAuthTag]) {
      if (!verify(receiverKeys.signalAuthKey, sid, "sender", { ...validOffer, auth: validOfferAuth })) throw new Error("valid offer auth was rejected.");
      if (verify(receiverKeys.signalAuthKey, sid, "sender", { auth: validOfferAuth } as never)) throw new Error("missing signal kind was accepted.");
    }
    observedInheritedGetterReads = inheritedGetterReads;
  } finally {
    for (const key of keys) {
      const original = originals.get(key);
      if (original) {
        Object.defineProperty(Object.prototype, key, original);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
  assert.equal(observedInheritedGetterReads, 0);
});

test("signal authentication helper validates the exact canonical shape before signing", () => {
  assert.match(securityPolicy, /WebRTC signal auth helpers must reject noncanonical signal shapes before computing HMAC tags/);
  assert.match(securityPolicy, /WebRTC signal auth helpers must reject accessor-backed signal records and read canonical SDP\/ICE fields through own data descriptors/);
  assert.match(securityPolicy, /WebRTC signal auth helpers must byte-cap SDP and ICE string fields before canonical JSON construction or HMAC/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /assertSignalPayloadForAuth\(signal\)/);
    assert.match(source, /assertSignalPayloadForVerify\(signal\)/);
    assert.match(source, /const MAX_AUTH_SDP_BYTES = 128 \* 1024/);
    assert.match(source, /const MAX_AUTH_CANDIDATE_BYTES = 4096/);
    assert.match(source, /function utf8ByteLengthExceeds/);
    assert.match(source, /isNonEmptyByteBoundedString\(ownDataValue\(signal, "sdp"\), MAX_AUTH_SDP_BYTES\)/);
    assert.match(source, /isSafeNonEmptyByteBoundedString\(candidate, MAX_AUTH_CANDIDATE_BYTES\)/);
    assert.match(source, /ownDataValue\(signal, "auth"\)/);
    assert.match(source, /ownDataValue\(signal, "kind"\)/);
    assert.match(source, /ownDataValue\(signal, "sdp"\)/);
    assert.match(source, /ownDataValue\(signal, "candidate"\)/);
    assert.doesNotMatch(source, /signal\.kind/);
    assert.doesNotMatch(source, /signal\.sdp/);
    assert.doesNotMatch(source, /signal\.candidate/);
    assert.doesNotMatch(source, /value\.sdpMid/);
    assert.doesNotMatch(source, /value\.candidate/);
    assert.match(source, /hasOnlyDataProperties/);
    assert.match(source, /hasOnlyKeys\(signal, \["kind", "sdp"\]\)/);
    assert.match(source, /hasOnlyKeys\(signal, \["kind", "sdp", "auth"\]\)/);
    assert.match(source, /isIceCandidateInitForAuth/);
    assert.match(source, /hasOnlyKeys\(value, \["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"\]\)/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /!descriptor\.enumerable/);
  }
  assert.match(distWebBundle, /WebRTC signal auth payload is invalid/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /Reflect\.ownKeys/);
  assert.match(distWebBundle, /4096/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e\)\{[\s\S]{0,700}e\.sdpMid/);
  assert.doesNotMatch(distWebBundle, /function \w+\(e\)\{[\s\S]{0,260}e\.kind/);
});

test("WebRTC signal authentication byte-caps SDP and ICE strings", async () => {
  const sid = "signal-byte-bound-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  const oversizedSdp = "😀".repeat(32_769);
  assert.equal(oversizedSdp.length < 128 * 1024, true);
  assert.throws(() => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: oversizedSdp }), /signal auth payload/);
  assert.throws(() => distSignalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: oversizedSdp }), /signal auth payload/);
  assert.equal(verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: oversizedSdp, auth: validTag }), false);
  assert.equal(distVerifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", { kind: "offer", sdp: oversizedSdp, auth: validTag }), false);

  const oversizedCandidate = "😀".repeat(1_025);
  assert.equal(oversizedCandidate.length < 4096, true);
  assert.throws(
    () => signalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: oversizedCandidate, sdpMid: "0", sdpMLineIndex: 0 } }),
    /signal auth payload/
  );
  assert.throws(
    () => distSignalAuthTag(senderKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: oversizedCandidate, sdpMid: "0", sdpMLineIndex: 0 } }),
    /signal auth payload/
  );
  assert.equal(
    verifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: oversizedCandidate, sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag }),
    false
  );
  assert.equal(
    distVerifySignalAuthTag(receiverKeys.signalAuthKey, sid, "sender", { kind: "candidate", candidate: { candidate: oversizedCandidate, sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag }),
    false
  );
});

test("WebRTC signal authentication matches conformance vectors", () => {
  assert.equal(vectors.signalAuth.some((vector) => vector.signal.kind === "answer"), true);
  assert.equal(
    vectors.signalAuth.some((vector) => vector.signal.kind === "candidate" && vector.signal.candidate.usernameFragment === "ufrag-123"),
    true
  );
  for (const vector of vectors.signalAuth) {
    assert.equal(signalAuthTag(Buffer.from(vector.keyHex, "hex"), vector.sid, vector.fromRole, vector.signal), vector.tagBase64);
  }
});

test("PAKE confirmation tags match conformance vectors", () => {
  for (const vector of vectors.sessionConfirm) {
    assert.equal(sessionConfirmTag(Buffer.from(vector.keyHex, "hex"), vector.sid, vector.fromRole), vector.tagBase64);
  }
});

test("pair decision authentication matches conformance vectors", () => {
  assert.equal(vectors.pairDecisionAuth.some((vector) => vector.decision === "reject" && vector.reason === "user_declined"), true);
  for (const vector of vectors.pairDecisionAuth) {
    assert.equal(pairDecisionAuthTag(Buffer.from(vector.keyHex, "hex"), vector.sid, vector.fromRole, vector.decision, vector.sealedManifest, vector.reason), vector.tagBase64);
  }
});

test("AEAD helpers match conformance vectors", async () => {
  assert.equal(vectors.encryptedJsonAead.some((vector) => vector.kind === "manifest"), true);
  assert.equal(vectors.encryptedJsonAead.some((vector) => vector.kind === "control"), true);
  assert.equal(vectors.bulkAead.length >= 1, true);

  for (const vector of vectors.encryptedJsonAead) {
    const keys = await vectorSessionKeys(vector.sid, vector.keyHex, "decrypt");
    if (vector.kind === "manifest") {
      assert.deepEqual(await openManifest(keys, vector.sealedBase64), vector.plaintext, vector.name);
      assert.deepEqual(await distOpenManifest(keys, vector.sealedBase64), vector.plaintext, vector.name);
    } else {
      assert.deepEqual(await openControl(keys, vector.sealedBase64), vector.plaintext, vector.name);
      assert.deepEqual(await distOpenControl(keys, vector.sealedBase64), vector.plaintext, vector.name);
    }
  }

  for (const vector of vectors.bulkAead) {
    const encryptKeys = await vectorSessionKeys(vector.sid, vector.keyHex, "encrypt");
    const decryptKeys = await vectorSessionKeys(vector.sid, vector.keyHex, "decrypt");
    const payload = new Uint8Array(Buffer.from(vector.payloadHex, "hex"));
    const expectedSealed = Buffer.from(vector.sealedPayloadHex, "hex");
    const sealed = await sealBulk(encryptKeys, vector.fileId, vector.chunkSeq, payload);
    const distSealed = await distSealBulk(encryptKeys, vector.fileId, vector.chunkSeq, payload);

    assert.equal(Buffer.from(sealed).toString("hex"), vector.sealedPayloadHex, vector.name);
    assert.equal(Buffer.from(distSealed).toString("hex"), vector.sealedPayloadHex, vector.name);
    assert.deepEqual(await openBulk(decryptKeys, vector.fileId, vector.chunkSeq, expectedSealed), payload, vector.name);
    assert.deepEqual(await distOpenBulk(decryptKeys, vector.fileId, vector.chunkSeq, expectedSealed), payload, vector.name);
  }
});

test("bulk AEAD rejects tampered ciphertext and chunk metadata", async () => {
  const sid = "bulk-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  const sealed = await sealBulk(senderKeys, 3, 9, new TextEncoder().encode("payload"));
  sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
  await assert.rejects(() => openBulk(receiverKeys, 3, 9, sealed));

  const clean = await sealBulk(senderKeys, 3, 9, new TextEncoder().encode("payload"));
  await assert.rejects(() => openBulk(receiverKeys, 3, 10, clean), /decrypt failed/);
  await assert.rejects(() => sealBulk(senderKeys, 256, 0, new Uint8Array([1])), /fileId/);
  await assert.rejects(() => sealBulk(senderKeys, 0, 0x1_0000_0000, new Uint8Array([1])), /chunkSeq/);
  await assert.rejects(() => openBulk(receiverKeys, -1, 0, clean), /fileId/);
  await assert.rejects(() => openBulk(receiverKeys, 0, -1, clean), /chunkSeq/);
});

test("bulk AEAD primitive enforces chunk size caps without relying on frame decoding", async () => {
  assert.match(securityPolicy, /bulk AEAD helpers must reject non-canonical binary values, non-binary values, and oversized plaintext or ciphertext payloads/);
  const sid = "bulk-size-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  await assert.rejects(() => sealBulk(senderKeys, 0, 0, new Uint8Array(CHUNK_SIZE + 1)), /chunk size/);
  await assert.rejects(() => openBulk(receiverKeys, 0, 0, new Uint8Array(CHUNK_SIZE + 17)), /chunk size/);
  let byteLengthRead = false;
  const hostilePayload = {};
  Object.defineProperty(hostilePayload, "byteLength", {
    get() {
      byteLengthRead = true;
      return 1;
    }
  });
  await assert.rejects(() => sealBulk(senderKeys, 0, 0, hostilePayload as never), /must be binary/);
  await assert.rejects(() => openBulk(receiverKeys, 0, 0, hostilePayload as never), /must be binary/);
  assert.equal(byteLengthRead, false);

  let typedArrayGetterInvoked = false;
  class HostileBulkPayload extends Uint8Array {
    override get byteLength() {
      typedArrayGetterInvoked = true;
      return 1;
    }
  }
  const hostileTypedArray = new HostileBulkPayload(1);
  await assert.rejects(() => sealBulk(senderKeys, 0, 0, hostileTypedArray), /must be binary/);
  await assert.rejects(() => openBulk(receiverKeys, 0, 0, hostileTypedArray), /must be binary/);
  assert.equal(typedArrayGetterInvoked, false);

  assert.match(distSecuritySource, /const MAX_BULK_SEALED_BYTES = CHUNK_SIZE \+ AES_GCM_TAG_BYTES/);
  assert.match(distSecuritySource, /function binaryPayloadByteLength/);
  assert.match(distSecuritySource, /canonicalUint8ArrayByteLength\(value, "Bulk payload must be binary\."\)/);
  assert.match(distSecuritySource, /payloadByteLength > CHUNK_SIZE/);
  assert.match(distSecuritySource, /sealedByteLength > MAX_BULK_SEALED_BYTES/);
  assert.match(distWebBundle, /Bulk payload must be binary/);
  assert.match(distWebBundle, /16384/);
  assert.match(distWebBundle, /Encrypted bulk chunk decrypt failed/);
});

test("encrypted JSON payloads are bounded before decode and decrypt", async () => {
  const sid = "json-bound-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);

  await assert.rejects(() => openControl(receiverKeys, "A".repeat(ENCRYPTED_JSON_MAX_CHARS + 4)), /too large/);
  await assert.rejects(() => sealControl(senderKeys, { value: "x".repeat(ENCRYPTED_JSON_MAX_CHARS) }), /too large/);
  await assert.rejects(() => sealManifest(senderKeys, { value: "x".repeat(ENCRYPTED_JSON_MAX_CHARS) }), /too large/);
  await assert.rejects(() => sealControl(senderKeys, { values: Array.from({ length: 10_001 }, () => 0) }), /too large/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(() => sealControl(senderKeys, cyclic), /not JSON serializable/);
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "secret" });
  await assert.rejects(() => sealControl(senderKeys, accessor), /not JSON serializable/);
  let symbolAccessorReads = 0;
  const symbolAccessor = { ok: true };
  Object.defineProperty(symbolAccessor, Symbol("hidden"), {
    enumerable: true,
    get() {
      symbolAccessorReads += 1;
      return "secret";
    }
  });
  await assert.rejects(() => sealControl(senderKeys, symbolAccessor), /not JSON serializable/);
  await assert.rejects(() => distSealControl(senderKeys, symbolAccessor), /not JSON serializable/);
  assert.equal(symbolAccessorReads, 0);
  const symbolData = { ok: true };
  Object.defineProperty(symbolData, Symbol("hidden"), { enumerable: true, value: "secret" });
  await assert.rejects(() => sealControl(senderKeys, symbolData), /not JSON serializable/);
  await assert.rejects(() => distSealControl(senderKeys, symbolData), /not JSON serializable/);
  const accessorArray = [1];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => 1 });
  await assert.rejects(() => sealControl(senderKeys, { values: accessorArray }), /not JSON serializable/);
  const sparseArray: unknown[] = [];
  sparseArray.length = 1;
  await assert.rejects(() => sealControl(senderKeys, { values: sparseArray }), /not JSON serializable/);
  const previousToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let inheritedToJsonCalled = false;
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        inheritedToJsonCalled = true;
        return { pwned: true };
      }
    });
    const sealedWithoutToJson = await sealControl(senderKeys, { ok: true });
    assert.equal(inheritedToJsonCalled, false);
    assert.deepEqual(await openControl(receiverKeys, sealedWithoutToJson), { ok: true });
  } finally {
    if (previousToJson) Object.defineProperty(Object.prototype, "toJSON", previousToJson);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
  }
  const sealed = await sealControl(senderKeys, { ok: true });
  const tamperedBytes = base64ToBytes(sealed);
  tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 0xff;
  const tampered = bytesToBase64(tamperedBytes);
  await assert.rejects(() => openControl(receiverKeys, tampered), /decrypt failed/);
  await assert.rejects(() => sealControl(senderKeys, undefined), /not JSON serializable/);
  await assert.rejects(() => sealControl(senderKeys, { value: 1n }), /not JSON serializable/);
  assert.match(securityPolicy, /encrypted JSON sealers must preflight JSON depth, node count, accessors, symbol-keyed properties, cycles, and plaintext byte size, then serialize through descriptor-owned data only/);
  for (const source of [securitySource, distSecuritySource]) {
    assert.match(source, /const MAX_ENCRYPTED_JSON_PLAINTEXT_BYTES/);
    assert.match(source, /function assertJsonValueWithinEncryptionBounds/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, String\(index\)\)/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /Object\.getOwnPropertySymbols\(value\)\.length > 0/);
    assert.match(source, /if \(!descriptor\)[\s\S]{0,120}Encrypted payload is not JSON serializable/);
    assert.match(source, /assertJsonValueWithinEncryptionBounds\(value\);[\s\S]*stringifyPreflightedJsonValue\(value\)/);
    assert.doesNotMatch(source, /function stringifyJsonValue\(value[\s\S]{0,500}JSON\.stringify\(value\)/);
  }
  assert.match(distWebBundle, /Encrypted payload is not JSON serializable/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
});

test("encrypted manifest cap supports the declared maximum session shape", async () => {
  const sid = "max-manifest-session";
  const sender = startPake("sender", "123456-apple-anchor", sid);
  const receiver = startPake("receiver", "123456-apple-anchor", sid);
  const senderShare = ownPakeShareB64(sender);
  const receiverShare = ownPakeShareB64(receiver);
  const senderKeys = await finishPake(sender, receiverShare);
  const receiverKeys = await finishPake(receiver, senderShare);
  const manifest = {
    fileCount: MAX_FILES_PER_SESSION,
    totalBytes: MAX_FILES_PER_SESSION,
    files: Array.from({ length: MAX_FILES_PER_SESSION }, (_, id) => ({
      id,
      name: `${String(id).padStart(3, "0")}-${"x".repeat(MAX_FILE_NAME_CHARS - 4)}`,
      size: 1
    }))
  };

  const sealed = await sealManifest(senderKeys, manifest);
  assert.equal(sealed.length <= ENCRYPTED_JSON_MAX_CHARS, true);
  assert.deepEqual(await openManifest(receiverKeys, sealed), manifest);
});

test("pair-request messages require encrypted manifest to prevent downgrade", () => {
  const manifest = { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "encrypted-0", size: 1 }] };
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest, sealedManifest: "sealed" }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest, sealedManifest: validSealed }), true);
});

test("signaling schema rejects malformed signal and manifest fields", () => {
  assert.match(securityPolicy, /session ids in every signaling message schema must be restricted to the URL-safe nanoid alphabet/);
  for (const source of [messagesSource, distMessagesSource]) {
    assert.match(source, /function isSessionId/);
    assert.match(source, /const MAX_PAKE_BYTES = 4096/);
    assert.match(source, /const MAX_SDP_BYTES = 128 \* 1024/);
    assert.match(source, /const MAX_CANDIDATE_BYTES = 4096/);
    assert.match(source, /isNonEmptyByteBoundedString\(ownDataValue\(value, "data"\), MAX_PAKE_BYTES\)/);
    assert.match(source, /isNonEmptyByteBoundedString\(ownDataValue\(value, "sdp"\), MAX_SDP_BYTES\)/);
    assert.match(source, /isSafeNonEmptyByteBoundedString\(candidate, MAX_CANDIDATE_BYTES\)/);
    assert.match(source, /function hasOnlyDataProperties/);
    assert.match(source, /function ownArrayDataValue/);
    assert.match(source, /function ownDataArrayValues/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, String\(index\)\)/);
    assert.match(source, /function ownDataValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.match(source, /Reflect\.ownKeys\(value\)/);
    assert.match(source, /!descriptor\.enumerable/);
    assert.doesNotMatch(source, /value\.files\)\s*\{[\s\S]{0,200}for \(const file of value\.files\)/);
    assert.match(source, /SESSION_ID_VALUE = \/\^\[A-Za-z0-9_-\]\+\$\//);
    assert.match(source, /SESSION_ID_VALUE\.test\(value\)/);
    assert.doesNotMatch(source, /isNonEmptyBoundedString\(value\.sid, MAX_SID_CHARS\)/);
  }
  assert.match(securityPolicy, /plain-record schema predicates must reject own string-keyed, symbol-keyed, or inherited accessor-backed records/);
  assert.match(securityPolicy, /schema allowed-key checks must reject non-enumerable and symbol properties/);
  assert.match(securityPolicy, /signaling schema predicates for manifest and ICE arrays must reject sparse or accessor-backed array entries/);
  assert.match(securityPolicy, /signaling schema predicates must byte-cap PAKE, SDP, and ICE string fields before accepting direct validator calls/);
  assert.match(distWebBundle, /Reflect\.ownKeys/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor/);
  assert.match(distWebBundle, /Object\.getOwnPropertySymbols/);
  assert.match(distWebBundle, /`peer-joined`/);
  assert.match(distWebBundle, /`sid`/);
  assert.doesNotMatch(distWebBundle, /O\(e\.sid,\$e\)/);
  assert.equal(isClientMessage([]), false);
  assert.equal(isServerMessage([]), false);
  assert.equal(isClientMessage(new Date()), false);
  assert.equal(isServerMessage(new Map()), false);
  const accessorMessage = {};
  Object.defineProperty(accessorMessage, "type", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.equal(isClientMessage(accessorMessage), false);
  assert.equal(isServerMessage(accessorMessage), false);
  assert.equal(distIsClientMessage(accessorMessage), false);
  assert.equal(distIsServerMessage(accessorMessage), false);
  assertSignalingSchemasDoNotReadInheritedGetters();
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "12345678", protocolVersion: PROTOCOL_VERSION }), true);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "123456789012", protocolVersion: PROTOCOL_VERSION }), true);
  const hiddenExtraRegister = { type: "register", role: "receiver", code: "12345678", protocolVersion: PROTOCOL_VERSION };
  Object.defineProperty(hiddenExtraRegister, "extra", { enumerable: false, value: true });
  assert.equal(isClientMessage(hiddenExtraRegister), false);
  const hiddenRequiredRegister = { type: "register", role: "receiver", protocolVersion: PROTOCOL_VERSION };
  Object.defineProperty(hiddenRequiredRegister, "code", { enumerable: false, value: "12345678" });
  assert.equal(isClientMessage(hiddenRequiredRegister), false);
  assert.equal(distIsClientMessage(hiddenRequiredRegister), false);
  const symbolExtraRegistered = { type: "registered", code: "12345678", expiresInSec: 60 };
  Object.defineProperty(symbolExtraRegistered, Symbol("extra"), { enumerable: true, value: true });
  assert.equal(isServerMessage(symbolExtraRegistered), false);
  let symbolSchemaReads = 0;
  const symbolAccessorRegistered = { type: "registered", code: "12345678", expiresInSec: 60 };
  Object.defineProperty(symbolAccessorRegistered, Symbol("extra"), {
    enumerable: true,
    get() {
      symbolSchemaReads += 1;
      return true;
    }
  });
  assert.equal(isServerMessage(symbolAccessorRegistered), false);
  assert.equal(distIsServerMessage(symbolAccessorRegistered), false);
  assert.equal(symbolSchemaReads, 0);
  const hiddenExtraCandidate = { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 };
  Object.defineProperty(hiddenExtraCandidate, "extra", { enumerable: false, value: true });
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: hiddenExtraCandidate, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "12345678", protocolVersion: PROTOCOL_VERSION }), true);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "123456789012", protocolVersion: PROTOCOL_VERSION }), true);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "", protocolVersion: 1 }), false);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "", protocolVersion: 1 }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "123456", protocolVersion: PROTOCOL_VERSION }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "1234567890", protocolVersion: PROTOCOL_VERSION }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "1234567890123", protocolVersion: PROTOCOL_VERSION }), false);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "12345678-apple-anchor", protocolVersion: PROTOCOL_VERSION }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "12345678", protocolVersion: 1.5 }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "bad\nsid", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "bad\u202esid", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "bad sid", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "bad/sid", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "bad.sid", data: "share" }), false);
  assert.equal(isClientMessage({ type: "pake", sid: "good_sid-1", data: "share" }), true);
  assert.equal(isClientMessage({ type: "pake", sid: "sid", data: "" }), false);
  const oversizedBytePake = "😀".repeat(1_025);
  assert.equal(oversizedBytePake.length < 4096, true);
  assert.equal(isClientMessage({ type: "pake", sid: "sid", data: oversizedBytePake }), false);
  assert.equal(distIsClientMessage({ type: "pake", sid: "sid", data: oversizedBytePake }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "", tag: validTag }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: "" }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: "tag" }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: validTag }), true);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: "A".repeat(42) + "==" }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: `${"A".repeat(41)}AB=` }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "", manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] }, sealedManifest: validSealed }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest: { fileCount: 0, totalBytes: 0, files: [] }, sealedManifest: "" }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] }, sealedManifest: "not-base64" }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] }, sealedManifest: "AAAA" }), false);
  assert.equal(isClientMessage({ type: "pair-request", sid: "sid", manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] }, sealedManifest: `${"A".repeat(17)}AB=` }), false);
  assert.equal(isClientMessage({ type: "pair-accept", sid: "" }), false);
  assert.equal(isClientMessage({ type: "pair-accept", sid: "sid" }), false);
  assert.equal(isClientMessage({ type: "pair-accept", sid: "sid", auth: validTag }), true);
  assert.equal(isClientMessage({ type: "pair-accept", sid: "sid", auth: "auth" }), false);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "" }), false);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "sid", reason: "user_declined" }), false);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "sid", auth: validTag }), false);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "sid", auth: validTag, reason: "user_declined" }), true);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "sid", auth: validTag, reason: "peer_wrote_this" }), false);
  assert.equal(isClientMessage({ type: "pair-reject", sid: "sid", auth: validTag, reason: "\u001b[31mnope" }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "", signal: { kind: "offer", sdp: "v=0\r\n", auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "bye", sid: "" }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "123456", protocolVersion: 1, extra: true }), false);
  assert.equal(isClientMessage({ type: "bye", sid: "sid", reason: "bad\nreason" }), false);
  assert.equal(isClientMessage({ type: "register", role: "receiver", code: "123456", protocolVersion: 1, pake: "legacy" }), false);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "123456", protocolVersion: 1, pake: { bad: true } }), false);
  assert.equal(isClientMessage({ type: "connect", role: "sender", code: "123456", protocolVersion: 1, pake: "legacy" }), false);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: validTag }), true);
  assert.equal(isClientMessage({ type: "confirm", sid: "sid", tag: "x".repeat(300) }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer" } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "bogus", sdp: "x" } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "", auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "v=0\r\n", auth: "" } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "v=0\r\n", auth: "auth" } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "v=0\r\n", auth: validTag } }), true);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "x".repeat(200_000) } }), false);
  const oversizedByteSdp = "😀".repeat(32_769);
  assert.equal(oversizedByteSdp.length < 128 * 1024, true);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: oversizedByteSdp, auth: validTag } }), false);
  assert.equal(distIsClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: oversizedByteSdp, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "offer", sdp: "v=0\r\n", extra: true } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { arbitrary: "object" } } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host" } } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host" }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "", sdpMLineIndex: null }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag } }), false);
  const oversizedByteCandidate = "😀".repeat(1_025);
  assert.equal(oversizedByteCandidate.length < 4096, true);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: oversizedByteCandidate, sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(distIsClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: oversizedByteCandidate, sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host\nbad", sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "\u202e0", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0\u200b", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "audio mid", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "m\u00edd", sdpMLineIndex: 0 }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ufrag\nbad" }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "bad ufrag" }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ufr\u00e1g" }, auth: validTag } }), false);
  assert.equal(isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 }, auth: "" } }), false);
  assert.equal(
    isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 }, auth: validTag } }),
    true
  );
  assert.equal(
    isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0" }, auth: validTag } }),
    true
  );
  assert.equal(
    isClientMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMLineIndex: 0 }, auth: validTag } }),
    true
  );
  assert.equal(isManifest({ fileCount: 1.1, totalBytes: 1, files: [{ name: "x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 2, totalBytes: 1, files: [{ name: "x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: -1, files: [{ name: "x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 2, files: [{ name: "x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ name: "x", size: -1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ name: "x", size: 1, extra: true }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [["x", 1]] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ name: "", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ name: "../x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ name: ".", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 300, name: "x", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 2, totalBytes: 2, files: [{ id: 0, name: "x", size: 1 }, { id: 0, name: "y", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text/plain; charset=utf-8" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text/plain;charset=utf-8" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text/" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text/plain\nbad" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x\u200b", size: 1 }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "text/plain\u200b" }] }), false);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1, mime: "image/svg+xml" }] }), true);
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x".repeat(2000), size: 1 }] }), false);
  const sparseSchemaManifestFiles = [] as unknown[];
  sparseSchemaManifestFiles.length = 1;
  assert.equal(isManifest({ fileCount: 1, totalBytes: 0, files: sparseSchemaManifestFiles }), false);
  const accessorSchemaManifestFiles = [{ id: 0, name: "x", size: 1 }];
  Object.defineProperty(accessorSchemaManifestFiles, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.equal(isManifest({ fileCount: 1, totalBytes: 1, files: accessorSchemaManifestFiles }), false);
  assert.equal(isServerMessage({ type: "registered", code: "12345678", expiresInSec: 600 }), true);
  assert.equal(isServerMessage({ type: "registered", code: "123456789012", expiresInSec: 600 }), true);
  assert.equal(isServerMessage({ type: "registered", code: "123456", expiresInSec: 600 }), false);
  assert.equal(isServerMessage({ type: "registered", code: "1234567890", expiresInSec: 600 }), false);
  assert.equal(isServerMessage({ type: "registered", code: "12345678", expiresInSec: "600" }), false);
  assert.equal(isServerMessage({ type: "registered", code: "12345678", expiresInSec: 600, extra: true }), false);
  assert.equal(isServerMessage({ type: "registered", code: "", expiresInSec: 600 }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "bad\nsid" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "bad\u202esid" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "bad sid" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "bad/sid" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "bad.sid" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "good_sid-1" }), true);
  assert.equal(isServerMessage({ type: "pake", sid: "sid", data: "" }), false);
  assert.equal(isServerMessage({ type: "confirm", sid: "sid", tag: "" }), false);
  assert.equal(isServerMessage({ type: "confirm", sid: "sid", tag: "tag" }), false);
  assert.equal(isServerMessage({ type: "pair-request", sid: "sid", manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "x", size: 1 }] }, sealedManifest: "" }), false);
  assert.equal(isServerMessage({ type: "pair-accept", sid: "" }), false);
  assert.equal(isServerMessage({ type: "pair-accept", sid: "sid" }), false);
  assert.equal(isServerMessage({ type: "pair-accept", sid: "sid", auth: validTag }), true);
  assert.equal(isServerMessage({ type: "pair-reject", sid: "" }), false);
  assert.equal(isServerMessage({ type: "pair-reject", sid: "sid", auth: validTag }), false);
  assert.equal(isServerMessage({ type: "pair-reject", sid: "sid", auth: validTag, reason: "user_declined" }), true);
  assert.equal(isServerMessage({ type: "pair-reject", sid: "sid", auth: validTag, reason: "peer_wrote_this" }), false);
  assert.equal(isServerMessage({ type: "peer-left", sid: "" }), false);
  assert.equal(isServerMessage({ type: "peer-left", sid: "sid", reason: "\u202ereason" }), false);
  assert.equal(isServerMessage({ type: "signal", sid: "sid", signal: { kind: "candidate", candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host" }, auth: validTag } }), false);
  assert.equal(isServerMessage({ type: "error", code: "bad_message", message: "" }), false);
  assert.equal(isServerMessage({ type: "error", code: "bad_message", message: "\u001b[31mnope" }), false);
  assert.equal(isServerMessage({ type: "error", code: "bad_message", message: "zero\u200bwidth" }), false);
  assert.equal(isServerMessage({ type: "peer-joined", sid: "sid", pake: "legacy" }), false);
  assert.equal(isServerMessage({ type: "confirm", sid: "sid", tag: validTag }), true);
  assert.equal(isServerMessage({ type: "error", code: "bogus", message: "no" }), false);
  assert.equal(isServerMessage({ type: "signal", sid: "sid", signal: { kind: "answer" } }), false);
  assert.equal(isIceServers([]), false);
  const sparseIceServers = [] as unknown[];
  sparseIceServers.length = 1;
  assert.equal(isIceServers(sparseIceServers), false);
  const accessorIceServers = [{ urls: "stun:stun.example.test" }];
  Object.defineProperty(accessorIceServers, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.equal(isIceServers(accessorIceServers), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test" }]), true);
  assert.equal(isIceServers([{ urls: "STUN:stun.example.test:3478?transport=UDP" }]), true);
  assert.equal(isIceServers([{ urls: "turn:[::1]:3478?transport=tcp" }]), false);
  assert.equal(isIceServers([{ urls: "turn:[::1]:3478?transport=tcp", username: "u", credential: "p" }]), true);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test\u0000" }]), false);
  assert.equal(isIceServers([{ urls: "https://example.test" }]), false);
  assert.equal(isIceServers([{ urls: "stun:bad_host.example" }]), false);
  assert.equal(isIceServers([{ urls: "stun:files.example." }]), false);
  assert.equal(isIceServers([{ urls: "stun:0177.0.0.1" }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test:0" }]), false);
  const sparseIceUrls = [] as unknown[];
  sparseIceUrls.length = 1;
  assert.equal(isIceServers([{ urls: sparseIceUrls }]), false);
  const accessorIceUrls = ["stun:stun.example.test"];
  Object.defineProperty(accessorIceUrls, "0", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.equal(isIceServers([{ urls: accessorIceUrls }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test:0", username: "u", credential: "p" }]), false);
  assert.equal(isIceServers([{ urls: "turn:user:pass@turn.example.test" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test:3478?transport=tcp&x=1" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test/path" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test:3478?transport=tcp" }]), false);
  assert.equal(isIceServers([{ urls: [] }]), false);
  assert.equal(isIceServers([{ urls: [42] }]), false);
  assert.equal(isIceServers(new Array(17).fill({ urls: "stun:stun.example.test" })), false);
  assert.equal(isIceServers([{ urls: new Array(9).fill("stun:stun.example.test") }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test", credential: "x".repeat(2000) }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test", username: "u" }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test", username: "u", credential: "p", credentialType: "oauth" }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test", username: "u", credential: "p", credentialType: "password" }]), true);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "", credential: "p", credentialType: "password" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "u", credential: "", credentialType: "password" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "bad\nuser", credential: "p", credentialType: "password" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "u", credential: "bad\u202epass", credentialType: "password" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "u\u200b", credential: "p", credentialType: "password" }]), false);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "u", credential: "p", credentialType: "password" }]), true);
  assert.equal(isIceServers([{ urls: "turn:turn.example.test", username: "u", credential: {}, credentialType: "oauth" }]), false);
  assert.equal(isIceServers([{ urls: ["stun:stun.example.test", "turn:turn.example.test"] }]), false);
  assert.equal(isIceServers([{ urls: "stun:stun.example.test", extra: "nope" }]), false);
});

test("base64 decoder rejects malformed non-canonical payloads", () => {
  assert.throws(() => base64ToBytes("abcd!"));
  assert.throws(() => base64ToBytes("abc"));
  assert.throws(() => base64ToBytes(""));
  assert.throws(() => base64ToBytes("AB=="));
  assert.throws(() => base64ToBytes("AAB="));
});

test("signaling JSON parsing and serialization are size bounded", () => {
  assert.equal(parseJsonMessage(" ".repeat(SIGNALING_MAX_PAYLOAD_BYTES + 1)), null);
  assert.equal(parseJsonMessage(JSON.stringify({ data: "😀".repeat(Math.ceil(SIGNALING_MAX_PAYLOAD_BYTES / 4)) })), null);
  let coerced = false;
  const stringLike = {
    get length() {
      coerced = true;
      return 2;
    },
    toString() {
      coerced = true;
      return "{}";
    }
  };
  assert.equal(parseJsonMessage(stringLike), null);
  assert.equal(distParseJsonMessage(stringLike), null);
  assert.equal(coerced, false);
  assert.throws(
    () => serializeMessage({ type: "error", code: "bad_message", message: "x".repeat(SIGNALING_MAX_PAYLOAD_BYTES) }),
    /exceeds maximum/
  );
  assert.throws(
    () =>
      serializeMessage({
        type: "signal",
        sid: "sid",
        signal: { kind: "offer", sdp: "😀".repeat(Math.ceil(SIGNALING_MAX_PAYLOAD_BYTES / 4)), auth: "auth" }
      }),
    /exceeds maximum/
  );
  assert.match(securityPolicy, /exported signaling JSON parsers must reject non-string direct inputs before length, byte-length, JSON parsing, or string-like coercion/);
  assert.match(messagesSource, /typeof raw !== "string"/);
  assert.match(distMessagesSource, /typeof raw !== "string"/);
  assert.match(distWebBundle, /typeof e!=`string`\|\|e\.length>262144/);
});

test("signaling serialization ignores toJSON hooks and rejects accessors", () => {
  const original = (Object.prototype as { toJSON?: unknown }).toJSON;
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        return { type: "error", code: "bad_message", message: "polluted" };
      }
    });
    assert.equal(serializeMessage({ type: "bye", reason: "cancelled" }), '{"type":"bye","reason":"cancelled"}');
  } finally {
    if (original === undefined) {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    } else {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: original });
    }
  }

  assert.throws(() => serializeMessage({ type: "bye", toJSON: () => ({ type: "bye" }) } as never), /not JSON serializable/);
  const accessorMessage = {};
  Object.defineProperty(accessorMessage, "type", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    }
  });
  assert.throws(() => serializeMessage(accessorMessage as never), /not JSON serializable/);
  const symbolDataMessage = { type: "bye", reason: "cancelled" };
  Object.defineProperty(symbolDataMessage, Symbol("hidden"), { enumerable: true, value: "secret" });
  assert.throws(() => serializeMessage(symbolDataMessage as never), /not JSON serializable/);
  assert.throws(() => distSerializeMessage(symbolDataMessage as never), /not JSON serializable/);
  assert.throws(() => serializeMessage({ type: "registered", code: "12345678", expiresInSec: Number.NaN } as never), /not JSON serializable/);
  assert.throws(() => serializeMessage({ type: "registered", code: "12345678", expiresInSec: Number.POSITIVE_INFINITY } as never), /not JSON serializable/);
  assert.throws(() => distSerializeMessage({ type: "registered", code: "12345678", expiresInSec: Number.NaN } as never), /not JSON serializable/);
  const accessorArray = ["stun:one.example"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      throw new Error("array getter should not run");
    }
  });
  assert.throws(() => serializeMessage({ type: "ice-config", iceServers: [{ urls: accessorArray }] } as never), /not JSON serializable/);
  const sparseArray = [] as string[];
  sparseArray.length = 1;
  assert.throws(() => serializeMessage({ type: "ice-config", iceServers: [{ urls: sparseArray }] } as never), /not JSON serializable/);
  assert.throws(() => serializeMessage({ type: "bye", reason: "cancelled", extra: true } as never), /not a valid protocol message/);
  assert.throws(() => distSerializeMessage({ type: "bye", reason: "cancelled", extra: true } as never), /not a valid protocol message/);
  assert.match(securityPolicy, /signaling frame serialization must reject symbol-keyed records, ignore inherited `toJSON` hooks, reject own accessors or own `toJSON` hooks, and re-parse the serialized frame through the protocol schema/);
  assert.match(securityPolicy, /signaling frame serialization must reject non-finite numbers/);
  assert.match(messagesSource, /function stringifyJsonData/);
  assert.match(distMessagesSource, /function stringifyJsonData/);
  assert.match(messagesSource, /const parsed = parseJsonMessage\(serialized\)/);
  assert.match(messagesSource, /!isClientMessage\(parsed\) && !isServerMessage\(parsed\)/);
  assert.match(distMessagesSource, /const parsed = parseJsonMessage\(serialized\)/);
  assert.match(distMessagesSource, /!isClientMessage\(parsed\) && !isServerMessage\(parsed\)/);
  assert.match(messagesSource, /Object\.getOwnPropertySymbols\(value\)\.length > 0/);
  assert.match(distMessagesSource, /Object\.getOwnPropertySymbols\(value\)\.length > 0/);
  assert.doesNotMatch(messagesSource, /Number\.isFinite\(value\) \? String\(value\) : "null"/);
  assert.doesNotMatch(distMessagesSource, /Number\.isFinite\(value\) \? String\(value\) : "null"/);
  assert.match(distWebBundle, /Signaling message is not JSON serializable/);
  assert.match(distWebBundle, /Number\.isFinite/);
  assert.doesNotMatch(distWebBundle, /Number\.isFinite\(e\)\?String\(e\):`null`/);
  assert.match(distWebBundle, /throw Error\(`Signaling message is not JSON serializable\.`\)/);
  assert.match(distWebBundle, /Object\.getOwnPropertySymbols\(e\)\.length>0\)throw Error\(`Signaling message is not JSON serializable\.`\)/);
  assert.match(distWebBundle, /Encrypted payload is not JSON serializable/);
  assert.match(distWebBundle, /Signaling message is not a valid protocol message/);
  assert.match(distWebBundle, /Signaling message is not a valid protocol message/);
  assert.match(distWebBundle, /Buffered WebRTC signal message is invalid/);
  assert.match(distWebBundle, /\.encode\(\w+\)\.byteLength/);
  assert.doesNotMatch(messagesSource, /const serialized = JSON\.stringify\(message\)/);
  assert.doesNotMatch(distMessagesSource, /const serialized = JSON\.stringify\(message\)/);
});

test("signaling text frame parser rejects binary and malformed UTF-8 frames", () => {
  assert.match(securityPolicy, /signaling text-frame parsing must reject non-canonical binary frames before byte-length reads or UTF-8 decode/);
  const message = { type: "registered", code: "12345678", expiresInSec: 600 };
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  assert.deepEqual(parseJsonTextFrame(encoded, false), message);
  assert.equal(parseJsonTextFrame(encoded, true), null);
  assert.equal(parseJsonTextFrame(new Uint8Array([0xff, 0xff]), false), null);

  let typedArrayGetterInvoked = false;
  class HostileFrame extends Uint8Array {
    override get byteLength() {
      typedArrayGetterInvoked = true;
      return encoded.byteLength;
    }
  }
  assert.equal(parseJsonTextFrame(new HostileFrame(encoded), false), null);
  assert.equal(typedArrayGetterInvoked, false);

  for (const source of [messagesSource, distMessagesSource]) {
    assert.match(source, /function canonicalBinaryFrameByteLength/);
    assert.match(source, /function isCanonicalBinaryPrototype/);
    assert.match(source, /prototype === Uint8Array\.prototype/);
    assert.match(source, /prototype === Buffer\.prototype/);
    assert.match(source, /fatalUtf8\.decode\(data\)/);
    assert.doesNotMatch(source, /data\.byteLength > SIGNALING_MAX_PAYLOAD_BYTES/);
  }
});

test("browser signaling parser rejects non-text frames without coercion", () => {
  const message = { type: "registered", code: "12345678", expiresInSec: 600 };
  assert.deepEqual(parseBrowserJsonMessage(JSON.stringify(message)), message);
  assert.equal(parseBrowserJsonMessage(new TextEncoder().encode(JSON.stringify(message))), null);
  assert.equal(parseBrowserJsonMessage(new ArrayBuffer(8)), null);
  let coerced = false;
  assert.equal(
    parseBrowserJsonMessage({
      toString() {
        coerced = true;
        return JSON.stringify(message);
      }
    }),
    null
  );
  assert.equal(coerced, false);
});

function assertSignalingSchemasDoNotReadInheritedGetters(): void {
  const keys = ["type", "role", "code", "protocolVersion", "sid", "data", "tag", "reason", "files", "fileCount", "totalBytes", "id", "name", "size", "mime", "kind", "candidate", "auth", "sdp", "sdpMid", "sdpMLineIndex", "usernameFragment", "urls", "username", "credential", "credentialType"];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let inheritedGetterReads = 0;
  try {
    for (const key of keys) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          inheritedGetterReads += 1;
          return undefined;
        },
        set() {
          // Allow platform internals such as Error#code assignment while the prototype-pollution fixture is installed.
        }
      });
    }

    for (const messageValidator of [isClientMessage, distIsClientMessage]) {
      assert.equal(messageValidator({}), false);
      assert.equal(messageValidator({ type: "bye" }), true);
      assert.equal(messageValidator({ type: "peer-left", sid: "sid" }), false);
      assert.equal(messageValidator({ type: "ice-config" }), false);
    }
    for (const messageValidator of [isServerMessage, distIsServerMessage]) {
      assert.equal(messageValidator({}), false);
      assert.equal(messageValidator({ type: "bye" }), false);
      assert.equal(messageValidator({ type: "peer-left", sid: "sid" }), true);
      assert.equal(messageValidator({ type: "ice-config" }), false);
    }
    for (const manifestValidator of [isManifest, distIsManifest]) {
      assert.equal(manifestValidator({ fileCount: 1, totalBytes: 1 }), false);
      assert.equal(manifestValidator({ files: [{ name: "x", size: 1 }], fileCount: 1, totalBytes: 1 }), true);
    }
    for (const iceValidator of [isIceServers, distIsIceServers]) {
      assert.equal(iceValidator([{ urls: "stun:stun.example.com:3478" }]), true);
    }
    assert.equal(inheritedGetterReads, 0);
  } finally {
    for (const key of keys) {
      const original = originals.get(key);
      if (original) {
        Object.defineProperty(Object.prototype, key, original);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
}

async function sealRawManifestWrapperForTest(keys: { sid: string; manifestKey?: CryptoKey }, wrapper: unknown): Promise<string> {
  if (!keys.manifestKey) throw new Error("missing manifest key");
  const encoder = new TextEncoder();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`manifest:${keys.sid}`);
  const plaintext = encoder.encode(JSON.stringify(wrapper));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, keys.manifestKey, plaintext));
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(ciphertext, nonce.byteLength);
  return bytesToBase64(sealed);
}

async function vectorSessionKeys(sid: string, keyHex: string, role: "encrypt" | "decrypt"): Promise<SessionKeys> {
  const parsed = Buffer.from(keyHex, "hex");
  const raw = new Uint8Array(parsed.length);
  raw.set(parsed);
  assert.equal(raw.byteLength, 32);
  return {
    sid,
    role: role === "encrypt" ? "sender" : "receiver",
    protocolVersion: PROTOCOL_VERSION,
    sas: "vector",
    destroyed: false,
    signalAuthKey: new Uint8Array(32),
    manifestKey: await importAesVectorKey(raw, ["decrypt"]),
    controlSendKey: await importAesVectorKey(raw, ["encrypt"]),
    controlRecvKey: await importAesVectorKey(raw, ["decrypt"]),
    bulkSendKey: await importAesVectorKey(raw, ["encrypt"]),
    bulkRecvKey: await importAesVectorKey(raw, ["decrypt"])
  };
}

async function importAesVectorKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
