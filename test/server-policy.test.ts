import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SIGNALING_MAX_ICE_CANDIDATES_PER_PEER } from "../src/shared/constants.js";
import {
  applyRelayPhase,
  otherSessionPeerId,
  publicPairRequestManifestIsRedacted,
  receiverCanRetryPrePair,
  relayAllowedForPhase,
  relayAllowedForRole,
  senderDisconnectCanRestoreReceiver,
  sessionBeforePairAcceptance,
  sessionHasConfirmedPake,
  sessionPeerId,
  type RelayPolicyPeer,
  type RelayPolicySession
} from "../src/server/policy.js";
import type { ClientMessage, FileManifest } from "../src/shared/messages.js";
import { redactManifestForSignaling } from "../src/shared/public-manifest.js";

const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const policySource = fs.readFileSync(new URL("../src/server/policy.ts", import.meta.url), "utf8");
const publicManifestSource = fs.readFileSync(new URL("../src/shared/public-manifest.ts", import.meta.url), "utf8");
const distPolicySource = fs.readFileSync(new URL("../dist-node/server/policy.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const AUTH_TAG = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("relay role policy rejects impossible sender/receiver messages", () => {
  const session = makeSession();
  assert.equal(sessionPeerId(session, session.sender), "sender");
  assert.equal(sessionPeerId(session, session.receiver), "receiver");
  assert.equal(sessionPeerId(session, { id: "intruder" }), null);
  assert.equal(otherSessionPeerId("sender"), "receiver");
  assert.equal(otherSessionPeerId("receiver"), "sender");
  assert.equal(relayAllowedForRole(session, session.sender, pairRequest()), true);
  assert.equal(relayAllowedForRole(session, session.receiver, pairRequest()), false);
  assert.equal(relayAllowedForRole(session, { id: "intruder" }, pairRequest()), false);
  assert.equal(relayAllowedForRole(session, session.receiver, { type: "pair-accept", sid: "sid", auth: AUTH_TAG }), true);
  assert.equal(relayAllowedForRole(session, session.sender, { type: "pair-accept", sid: "sid", auth: AUTH_TAG }), false);
  assert.equal(relayAllowedForRole(session, session.sender, offer()), true);
  assert.equal(relayAllowedForRole(session, session.receiver, offer()), false);
  assert.equal(relayAllowedForRole(session, session.receiver, answer()), true);
  assert.equal(relayAllowedForRole(session, session.sender, answer()), false);
});

test("session peer-id helpers reject malformed runtime peer ids", () => {
  assert.match(securityPolicy, /session peer-id helpers must reject malformed runtime ids before selecting the opposite peer/);
  let coerced = false;
  const hostilePeerId = {
    valueOf() {
      coerced = true;
      return "sender";
    },
    toString() {
      coerced = true;
      return "sender";
    }
  };

  assert.throws(() => otherSessionPeerId("intruder" as never), /Session peer id is invalid/);
  assert.throws(() => otherSessionPeerId(hostilePeerId as never), /Session peer id is invalid/);
  assert.equal(coerced, false);

  for (const source of [policySource, distPolicySource]) {
    assert.match(source, /peerId === "sender"/);
    assert.match(source, /peerId === "receiver"/);
    assert.match(source, /throw new Error\("Session peer id is invalid\."\)/);
    assert.doesNotMatch(source, /return peerId === "sender" \? "receiver" : "sender"/);
  }
});

test("relay phase policy enforces pair decision before WebRTC signaling", () => {
  const session = makeSession();
  assert.equal(sessionHasConfirmedPake(session), false);
  assert.equal(relayAllowedForPhase(session, session.sender, offer()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, { type: "pair-accept", sid: "sid", auth: AUTH_TAG }), false);
  assert.equal(relayAllowedForPhase(session, session.sender, pairRequest()), false);
  assert.equal(relayAllowedForPhase(session, session.sender, pake()), true);
  applyRelayPhase(session, session.sender, pake());
  assert.equal(relayAllowedForPhase(session, session.sender, pairRequest()), false);
  assert.equal(relayAllowedForPhase(session, session.sender, confirm()), false);
  assert.equal(relayAllowedForPhase(session, session.sender, pake()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, pake()), true);
  applyRelayPhase(session, session.receiver, pake());
  assert.equal(relayAllowedForPhase(session, session.sender, pairRequest()), false);
  assert.equal(relayAllowedForPhase(session, session.sender, confirm()), true);
  applyRelayPhase(session, session.sender, confirm());
  assert.equal(sessionHasConfirmedPake(session), false);
  assert.equal(relayAllowedForPhase(session, session.sender, confirm()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, confirm()), true);
  applyRelayPhase(session, session.receiver, confirm());
  assert.equal(sessionHasConfirmedPake(session), true);
  assert.equal(relayAllowedForPhase(session, session.sender, pairRequest()), true);
  applyRelayPhase(session, session.sender, pairRequest());
  assert.equal(relayAllowedForPhase(session, session.sender, pairRequest()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, pake()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, { type: "pair-accept", sid: "sid", auth: AUTH_TAG }), true);
  applyRelayPhase(session, session.receiver, { type: "pair-accept", sid: "sid", auth: AUTH_TAG });
  assert.equal(relayAllowedForPhase(session, session.sender, offer()), true);
  assert.equal(relayAllowedForPhase(session, session.sender, candidate()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, candidate()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, answer()), false);
  applyRelayPhase(session, session.sender, offer());
  assert.equal(relayAllowedForPhase(session, session.sender, offer()), false);
  assert.equal(relayAllowedForPhase(session, session.sender, candidate()), true);
  assert.equal(relayAllowedForPhase(session, session.receiver, candidate()), true);
  assert.equal(relayAllowedForPhase(session, session.receiver, answer()), true);
  applyRelayPhase(session, session.receiver, answer());
  assert.equal(relayAllowedForPhase(session, session.receiver, answer()), false);
});

test("relay phase policy caps authenticated ICE candidates per peer", () => {
  const session = makeSession();
  session.senderPakeSeen = true;
  session.receiverPakeSeen = true;
  session.senderConfirmed = true;
  session.receiverConfirmed = true;
  session.pairRequested = true;
  session.pairDecided = true;
  session.offerSeen = true;
  session.answerSeen = true;

  assert.equal(relayAllowedForPhase(session, session.sender, candidate()), true);
  assert.equal(relayAllowedForPhase(session, session.receiver, candidate()), true);
  applyRelayPhase(session, session.sender, candidate());
  applyRelayPhase(session, session.receiver, candidate());
  assert.equal(session.senderCandidateCount, 1);
  assert.equal(session.receiverCandidateCount, 1);

  session.senderCandidateCount = SIGNALING_MAX_ICE_CANDIDATES_PER_PEER;
  assert.equal(relayAllowedForPhase(session, session.sender, candidate()), false);
  assert.equal(relayAllowedForPhase(session, session.receiver, candidate()), true);

  session.receiverCandidateCount = SIGNALING_MAX_ICE_CANDIDATES_PER_PEER;
  assert.equal(relayAllowedForPhase(session, session.receiver, candidate()), false);
});

test("server-visible pair request manifests must be redacted", () => {
  assert.match(securityPolicy, /server-visible redacted pair-request manifests must reject unknown manifest and file-entry fields/);
  assert.match(policySource, /sharedPublicPairRequestManifestIsRedacted\(manifest\)/);
  assert.match(publicManifestSource, /function hasOnlyOwnDataKeys/);
  assert.match(publicManifestSource, /Object\.getOwnPropertySymbols\(value\)\.length !== 0/);
  assert.equal(
    publicPairRequestManifestIsRedacted({
      fileCount: 2,
      totalBytes: 4,
      files: [
        { id: 0, name: "encrypted-0", size: 4 },
        { id: 1, name: "encrypted-1", size: 0 }
      ]
    }),
    true
  );
  assert.equal(
    publicPairRequestManifestIsRedacted({
      fileCount: 2,
      totalBytes: 3,
      files: [
        { id: 0, name: "encrypted-0", size: 3 },
        { id: 1, name: "encrypted-1", size: 0 }
      ]
    }),
    false
  );
  assert.equal(
    publicPairRequestManifestIsRedacted({
      fileCount: 2,
      totalBytes: 4,
      files: [
        { id: 0, name: "encrypted-0", size: 1 },
        { id: 1, name: "encrypted-1", size: 3 }
      ]
    }),
    false
  );
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "taxes.pdf", size: 1 }] }), false);
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 0, totalBytes: 0, files: [] }), false);
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "encrypted-0", size: 1, mime: "application/pdf" }] }), false);
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 1, totalBytes: 1, files: [{ id: 7, name: "encrypted-0", size: 1 }] }), false);
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "encrypted-1", size: 1 }] }), false);

  const manifestWithExtraField = {
    fileCount: 1,
    totalBytes: 1,
    files: [{ id: 0, name: "encrypted-0", size: 1 }],
    leaked: "taxes.pdf"
  };
  assert.equal(publicPairRequestManifestIsRedacted(manifestWithExtraField as never), false);

  const manifestWithExtraFileField = {
    fileCount: 1,
    totalBytes: 1,
    files: [{ id: 0, name: "encrypted-0", size: 1, leaked: "taxes.pdf" }]
  };
  assert.equal(publicPairRequestManifestIsRedacted(manifestWithExtraFileField as never), false);

  const manifestWithSymbolField = {
    fileCount: 1,
    totalBytes: 1,
    files: [{ id: 0, name: "encrypted-0", size: 1 }]
  };
  Object.defineProperty(manifestWithSymbolField, Symbol("leaked"), { value: "taxes.pdf" });
  assert.equal(publicPairRequestManifestIsRedacted(manifestWithSymbolField as never), false);
});

test("public pair request manifests expose only bucketed count and byte upper bounds", () => {
  const publicManifest = redactManifestForSignaling({
    fileCount: 3,
    totalBytes: 184_321,
    files: [
      { id: 0, name: "taxes.pdf", size: 100_000, mime: "application/pdf" },
      { id: 1, name: "payroll.csv", size: 84_321 },
      { id: 2, name: "empty-note.txt", size: 0 }
    ]
  });

  assert.deepEqual(publicManifest, {
    fileCount: 4,
    totalBytes: 262_144,
    files: [
      { id: 0, name: "encrypted-0", size: 262_144 },
      { id: 1, name: "encrypted-1", size: 0 },
      { id: 2, name: "encrypted-2", size: 0 },
      { id: 3, name: "encrypted-3", size: 0 }
    ]
  });
  assert.equal(publicPairRequestManifestIsRedacted(publicManifest), true);
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 3, totalBytes: 184_321, files: publicManifest.files.slice(0, 3) }), false);
});

test("relay policy helpers reject accessor-backed records without invoking getters", () => {
  let getterCalls = 0;
  const hostileGetter = () => {
    getterCalls += 1;
    return "sender";
  };
  const accessorPeer = {};
  Object.defineProperty(accessorPeer, "id", { get: hostileGetter });
  assert.equal(sessionPeerId(makeSession(), accessorPeer as RelayPolicyPeer), null);

  const accessorSession = { sid: "sid" };
  Object.defineProperty(accessorSession, "sender", { get: hostileGetter });
  Object.defineProperty(accessorSession, "receiver", { get: hostileGetter });
  assert.equal(sessionPeerId(accessorSession as RelayPolicySession, { id: "sender" }), null);

  const accessorMessage = { sid: "sid" };
  Object.defineProperty(accessorMessage, "type", { get: hostileGetter });
  assert.equal(relayAllowedForRole(makeSession(), { id: "sender" }, accessorMessage as Extract<ClientMessage, { sid: string }>), false);
  assert.equal(relayAllowedForPhase(makeSession(), { id: "sender" }, accessorMessage as Extract<ClientMessage, { sid: string }>), false);

  const signalKindMessage = { type: "signal", sid: "sid", signal: {} };
  Object.defineProperty(signalKindMessage.signal, "kind", { get: hostileGetter });
  const signalSession = makeSession();
  signalSession.senderPakeSeen = true;
  signalSession.receiverPakeSeen = true;
  signalSession.senderConfirmed = true;
  signalSession.receiverConfirmed = true;
  signalSession.pairRequested = true;
  signalSession.pairDecided = true;
  signalSession.offerSeen = true;
  assert.equal(relayAllowedForRole(signalSession, signalSession.sender, signalKindMessage as Extract<ClientMessage, { sid: string }>), false);
  assert.equal(relayAllowedForPhase(signalSession, signalSession.sender, signalKindMessage as Extract<ClientMessage, { sid: string }>), false);

  const mutationSession = makeSession();
  applyRelayPhase(mutationSession, mutationSession.sender, accessorMessage as Extract<ClientMessage, { sid: string }>);
  assert.deepEqual(mutationSession, makeSession());

  const accessorFlags = makeSession();
  Object.defineProperty(accessorFlags, "senderConfirmed", { get: hostileGetter });
  Object.defineProperty(accessorFlags, "receiverConfirmed", { get: hostileGetter });
  Object.defineProperty(accessorFlags, "pairDecided", { get: hostileGetter });
  assert.equal(sessionHasConfirmedPake(accessorFlags), false);
  assert.equal(sessionBeforePairAcceptance(accessorFlags), false);
  assert.equal(receiverCanRetryPrePair(accessorFlags, accessorFlags.receiver), false);
  assert.equal(senderDisconnectCanRestoreReceiver(accessorFlags, accessorFlags.sender), false);

  const accessorFile = {};
  Object.defineProperty(accessorFile, "id", { get: hostileGetter });
  Object.defineProperty(accessorFile, "name", { get: hostileGetter });
  Object.defineProperty(accessorFile, "mime", { get: hostileGetter });
  assert.equal(publicPairRequestManifestIsRedacted({ fileCount: 1, totalBytes: 1, files: [accessorFile as never] }), false);

  const accessorFiles = { fileCount: 1, totalBytes: 1 };
  Object.defineProperty(accessorFiles, "files", {
    get() {
      getterCalls += 1;
      return [{ id: 0, name: "encrypted-0", size: 1 }];
    }
  });
  assert.equal(publicPairRequestManifestIsRedacted(accessorFiles as FileManifest), false);

  assert.equal(getterCalls, 0);
});

test("relay phase mutation does not invoke accessor-backed session setters", () => {
  let setterCalls = 0;
  const accessorSession = {
    sid: "sid",
    sender: { id: "sender" },
    receiver: { id: "receiver" },
    get senderPakeSeen() {
      return false;
    },
    set senderPakeSeen(_value: boolean) {
      setterCalls += 1;
    },
    receiverPakeSeen: false,
    senderConfirmed: false,
    receiverConfirmed: false,
    pairRequested: false,
    pairDecided: false,
    offerSeen: false,
    answerSeen: false,
    senderCandidateCount: 0,
    receiverCandidateCount: 0
  };

  applyRelayPhase(accessorSession as never, accessorSession.sender, pake());

  assert.equal(setterCalls, 0);
});

test("relay phase mutation policy is present in source and shipped artifacts", () => {
  assert.match(securityPolicy, /mutate phase flags only through own writable data descriptors/);
  for (const source of [policySource, distPolicySource]) {
    assert.match(source, /function setBooleanFlag/);
    assert.match(source, /function setCandidateCount/);
    assert.match(source, /Object\.defineProperty\(value, key/);
    assert.match(source, /ownWritableDataDescriptor/);
    assert.doesNotMatch(source, /session\.senderPakeSeen = true/);
    assert.doesNotMatch(source, /session\.receiverPakeSeen = true/);
    assert.doesNotMatch(source, /session\.senderConfirmed = true/);
    assert.doesNotMatch(source, /session\.receiverConfirmed = true/);
    assert.doesNotMatch(source, /session\.pairRequested = true/);
    assert.doesNotMatch(source, /session\.pairDecided = true/);
    assert.doesNotMatch(source, /session\.offerSeen = true/);
    assert.doesNotMatch(source, /session\.answerSeen = true/);
    assert.doesNotMatch(source, /session\.senderCandidateCount =/);
    assert.doesNotMatch(source, /session\.receiverCandidateCount =/);
  }
});

test("relay policy source keeps descriptor-only trust boundaries", () => {
  assert.match(securityPolicy, /relay policy helpers must read session, peer, message, and redacted-manifest fields through own data descriptors/);
  assert.match(policySource, /Object\.getOwnPropertyDescriptor\(value, key\)/);
  assert.match(distPolicySource, /Object\.getOwnPropertyDescriptor\(value, key\)/);
  assert.match(publicManifestSource, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
  assert.match(policySource, /sharedPublicPairRequestManifestIsRedacted\(manifest\)/);
  assert.doesNotMatch(policySource, /manifest\.files\.every/);
  assert.doesNotMatch(policySource, /session\.sender\.id === peer\.id/);
  assert.doesNotMatch(policySource, /session\.receiver\.id === peer\.id/);
  assert.doesNotMatch(policySource, /message\.signal\.kind/);
  assert.match(policySource, /if \(signalKind\(message\) === "candidate"\) return true/);
  assert.match(policySource, /if \(signalKind\(message\) === "candidate"\) return boolFlag\(session, "offerSeen"\)/);
});

test("receiver pre-pair retry remains available until pair acceptance", () => {
  const session = makeSession();
  assert.equal(sessionBeforePairAcceptance(session), true);
  assert.equal(receiverCanRetryPrePair(session, session.receiver), true);
  assert.equal(receiverCanRetryPrePair(session, session.sender), false);
  assert.equal(senderDisconnectCanRestoreReceiver(session, session.sender), true);
  assert.equal(senderDisconnectCanRestoreReceiver(session, session.receiver), false);

  session.senderPakeSeen = true;
  session.receiverPakeSeen = true;
  session.senderConfirmed = true;
  session.receiverConfirmed = true;
  session.pairRequested = true;
  assert.equal(sessionBeforePairAcceptance(session), true);
  assert.equal(receiverCanRetryPrePair(session, session.receiver), true);
  assert.equal(senderDisconnectCanRestoreReceiver(session, session.sender), true);

  session.pairDecided = true;
  assert.equal(sessionBeforePairAcceptance(session), false);
  assert.equal(receiverCanRetryPrePair(session, session.receiver), false);
  assert.equal(senderDisconnectCanRestoreReceiver(session, session.sender), false);
});

test("invalid sender relay messages before pair acceptance restore the receiver immediately", () => {
  const relayBody = extractFunctionBody(serverSource, "relay");
  const rejectBody = extractFunctionBody(serverSource, "rejectRelayMessage");
  const badMessageBody = extractFunctionBody(serverSource, "badMessage");
  const malformedRejectBody = extractFunctionBody(serverSource, "rejectMalformedPrePairSenderMessage");

  assert.match(securityPolicy, /invalid sender signaling before pair acceptance must restore or expire the receiver code immediately/);
  assert.match(relayBody, /return rejectRelayMessage\(session, peer, "Manifest exceeds transfer limits\."\)/);
  assert.match(relayBody, /return rejectRelayMessage\(session, peer, "Pair request manifest must be redacted\."\)/);
  assert.match(relayBody, /return rejectRelayMessage\(session, peer, "Message is not valid for this peer role\."\)/);
  assert.match(relayBody, /return rejectRelayMessage\(session, peer, "Message is not valid in this session phase\."\)/);
  assert.match(rejectBody, /senderDisconnectCanRestoreReceiver\(session, peer\)/);
  assert.doesNotMatch(rejectBody, /consumePrePairAttempt/);
  assert.match(rejectBody, /fail\(peer, "bad_message", message\)/);
  assert.match(rejectBody, /restoreWaitingReceiver\(session, "invalid sender pre-pair message", true\)/);
  assert.match(rejectBody, /badMessage\(peer, message\)/);
  assert.match(badMessageBody, /if \(rejectMalformedPrePairSenderMessage\(peer, message\)\) return/);
  assert.match(malformedRejectBody, /const session = peer\.sid \? sessions\.get\(peer\.sid\) : undefined/);
  assert.match(malformedRejectBody, /senderDisconnectCanRestoreReceiver\(session, peer\)/);
  assert.doesNotMatch(malformedRejectBody, /consumePrePairAttempt/);
  assert.match(malformedRejectBody, /fail\(peer, "bad_message", message\)/);
  assert.match(malformedRejectBody, /restoreWaitingReceiver\(session, "invalid sender pre-pair message", true\)/);
  assert.match(malformedRejectBody, /return true/);
  const restoreBody = extractFunctionBody(serverSource, "restoreWaitingReceiver");
  assert.match(restoreBody, /closePeerAndRelease\(session\.sender, reason\)/);
});

test("relay delivery failures clean up session state immediately", () => {
  const relayBody = extractFunctionBody(serverSource, "relay");
  const deliveryFailedBody = extractFunctionBody(serverSource, "relayDeliveryFailed");

  assert.match(securityPolicy, /relay delivery failures must immediately remove the stale session or restore the receiver before pair acceptance/);
  assert.match(relayBody, /const terminalReject = message\.type === "pair-reject"/);
  assert.match(relayBody, /relayDeliveryFailed\(session, peer, target, terminalReject \? "pair rejected" : "peer unavailable", !terminalReject\)/);
  assert.match(deliveryFailedBody, /fail\(peer, "peer_unavailable", "Peer is no longer connected\."\)/);
  assert.match(deliveryFailedBody, /const targetPeerId = sessionPeerId\(session, target\)/);
  assert.match(deliveryFailedBody, /restoreReceiverOnSenderFailure && targetPeerId === "sender" && sessionBeforePairAcceptance\(session\)/);
  assert.match(deliveryFailedBody, /restoreWaitingReceiver\(session, reason, true\)/);
  assert.match(deliveryFailedBody, /endSession\(session, reason, targetPeerId \?\? undefined\)/);
});

test("session end cleanup clears each peer state exactly once before closing the remaining peer", () => {
  const endBody = extractFunctionBody(serverSource, "endSession");
  assert.equal(countMatches(endBody, /clearPeerSessionState\(session\.sender\)/g), 1);
  assert.equal(countMatches(endBody, /clearPeerSessionState\(session\.receiver\)/g), 1);
  assert.match(endBody, /clearPeerSessionState\(session\.sender\);[\s\S]*clearPeerSessionState\(session\.receiver\);[\s\S]*if \(remaining\) closePeerAndRelease\(remaining, reason\)/);
  const closeSessionPeersBody = extractFunctionBody(serverSource, "closeSessionPeers");
  assert.match(closeSessionPeersBody, /closePeerAndRelease\(session\.sender, reason\)/);
  assert.match(closeSessionPeersBody, /closePeerAndRelease\(session\.receiver, reason\)/);
});

test("server ignores late client frames after a close decision", () => {
  const distServerSource = fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8");
  const sourceMessageHandler = /ws\.on\("message", \(data, isBinary\) => \{([\s\S]*?)\n\s+\}\);/.exec(serverSource)?.[1] ?? "";
  const distMessageHandler = /ws\.on\("message", \(data, isBinary\) => \{([\s\S]*?)\n\s+\}\);/.exec(distServerSource)?.[1] ?? "";

  assert.match(securityPolicy, /server WebSocket message ingress must ignore frames once a server-initiated close has been scheduled/);
  for (const source of [serverSource, distServerSource]) {
    const acceptsBody = extractFunctionBody(source, "peerAcceptsClientMessages");
    assert.match(acceptsBody, /peer\.ws\.readyState === peer\.ws\.OPEN/);
    assert.match(acceptsBody, /!peer\.closeTimer/);
    assert.match(acceptsBody, /!peer\.connectionReleased/);
  }
  for (const body of [sourceMessageHandler, distMessageHandler]) {
    const guardIndex = body.indexOf("if (!peerAcceptsClientMessages(peer))");
    const rateLimitIndex = body.indexOf("if (!hitMessageLimit(peer))");
    const parseIndex = body.indexOf("parseJsonTextFrame(data, isBinary)");
    const handleIndex = body.indexOf("handleMessage(peer, parsed)");
    assert.equal(guardIndex >= 0 && guardIndex < rateLimitIndex && rateLimitIndex < parseIndex && parseIndex < handleIndex, true);
  }
});

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function makeSession(): RelayPolicySession {
  return {
    sid: "sid",
    sender: { id: "sender" },
    receiver: { id: "receiver" },
    senderPakeSeen: false,
    receiverPakeSeen: false,
    senderConfirmed: false,
    receiverConfirmed: false,
    pairRequested: false,
    pairDecided: false,
    offerSeen: false,
    answerSeen: false,
    senderCandidateCount: 0,
    receiverCandidateCount: 0
  };
}

function pake(): Extract<ClientMessage, { type: "pake" }> {
  return { type: "pake", sid: "sid", data: "share" };
}

function confirm(): Extract<ClientMessage, { type: "confirm" }> {
  return { type: "confirm", sid: "sid", tag: "tag" };
}

function pairRequest(): Extract<ClientMessage, { type: "pair-request" }> {
  return {
    type: "pair-request",
    sid: "sid",
    manifest: { fileCount: 1, totalBytes: 1, files: [{ id: 0, name: "encrypted-0", size: 1 }] },
    sealedManifest: "sealed"
  };
}

function offer(): Extract<ClientMessage, { type: "signal" }> {
  return { type: "signal", sid: "sid", signal: { kind: "offer", sdp: "v=0\r\n", auth: "auth" } };
}

function answer(): Extract<ClientMessage, { type: "signal" }> {
  return { type: "signal", sid: "sid", signal: { kind: "answer", sdp: "v=0\r\n", auth: "auth" } };
}

function candidate(): Extract<ClientMessage, { type: "signal" }> {
  return {
    type: "signal",
    sid: "sid",
    signal: {
      kind: "candidate",
      candidate: { candidate: "candidate:0 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      auth: "auth"
    }
  };
}

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  const bodyStart = findFunctionBodyStart(source, start + signature.length - 1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not extract ${name} body.`);
}

function findFunctionBodyStart(source: string, index: number): number {
  let parenDepth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (char === "{" && parenDepth === 0) return cursor;
  }
  throw new Error("Could not find function body.");
}
