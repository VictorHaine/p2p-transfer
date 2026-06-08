import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("signaling server issues session ICE config only after receiver pair acceptance", () => {
  const connectBody = extractFunctionBody(serverSource, "connect");
  const relayBody = extractFunctionBody(serverSource, "relay");

  assert.match(securityPolicy, /TURN REST credentials must only be issued on the WebSocket path after a receiver-originated `pair-accept` passes relay role and phase policy/);
  assert.match(securityPolicy, /clients authenticate that decision end-to-end with the PAKE-derived signal-auth key before starting ICE, but the server must not learn that key/);
  assert.match(securityPolicy, /must not learn that key, decrypt the manifest, or claim server-side cryptographic proof of accept authenticity or manifest decryption/);
  assert.match(readme, /Clients verify that accept decision end-to-end with the PAKE-derived signal-auth key before starting ICE; the server must not learn that key, cannot verify the accept cryptographically, and does not decrypt the manifest/);
  assert.doesNotMatch(readme, /server only verifies the authenticated accept message/);
  assert.doesNotMatch(readme, /clients receive short-lived credentials only after the receiver accepts the transfer, which requires successful PAKE confirmation and sealed-manifest decryption first/);
  assert.doesNotMatch(connectBody, /\bsendIceConfig\(/);
  assert.match(
    relayBody,
    /message\.type === "pair-accept"[\s\S]*!sendIceConfig\(session\.sender\) \|\| !send\(target, message as ServerMessage\)[\s\S]*relayDeliveryFailed\(session, peer, target, "peer unavailable"\)[\s\S]*!sendIceConfig\(session\.receiver\)[\s\S]*closeSessionPeers\(session, "receiver unavailable"\)[\s\S]*applyRelayPhase\(session, peer, message\)/
  );
  assert.doesNotMatch(relayBody, /message\.type === "confirm"[\s\S]*sendIceConfig\(/);
});

test("unauthenticated ICE lookups cannot consume accepted-session TURN issuance quota", () => {
  const sendIceConfigBody = extractFunctionBody(serverSource, "sendIceConfig");
  const httpRateLimitBody = extractFunctionBody(serverSource, "hitIceConfigHttpRateLimit");

  assert.match(serverSource, /const iceHttpRateLimits = new Map<string, number\[\]>\(\)/);
  assert.match(serverSource, /const turnIssueRateLimits = new Map<string, number\[\]>\(\)/);
  assert.match(httpRateLimitBody, /hitIceConfigRateLimit\(iceHttpRateLimits, requestIp\(req\)\)/);
  assert.match(sendIceConfigBody, /hitIceConfigRateLimit\(turnIssueRateLimits, peer\.ip\)/);
  assert.match(sendIceConfigBody, /iceServersForUnauthenticatedRequest\(serverConfig\)/);
  assert.match(sendIceConfigBody, /return send\(peer, \{ type: "ice-config", iceServers \}\)/);
  assert.doesNotMatch(sendIceConfigBody, /\biceHttpRateLimits\b/);
});

test("restored receiver registrations fail closed when the receiver cannot be notified", () => {
  const restoreBody = extractFunctionBody(serverSource, "restoreWaitingReceiver");
  const sendRestoredBody = extractFunctionBody(serverSource, "sendRestoredRegistration");

  assert.match(restoreBody, /sendRestoredRegistration\(session, existing\.expiresAt\)/);
  assert.match(restoreBody, /sendRestoredRegistration\(session, session\.codeExpiresAt\)/);
  assert.match(sendRestoredBody, /send\(session\.receiver, \{ type: "registered", code: session\.code, expiresInSec: remainingExpirySeconds\(expiresAt, Date\.now\(\)\) \}\)/);
  assert.match(sendRestoredBody, /codes\.get\(session\.code\)/);
  assert.match(sendRestoredBody, /codes\.delete\(session\.code\)/);
  assert.match(sendRestoredBody, /clearPeerSessionState\(session\.receiver\)/);
  assert.match(sendRestoredBody, /closePeerAndRelease\(session\.receiver, "receiver unavailable"\)/);
});

test("receiver join send failure clears stale receiver rendezvous state", () => {
  const connectBody = extractFunctionBody(serverSource, "connect");
  const failedJoin = /if \(!send\(waiting\.receiver, \{ type: "peer-joined", sid \}\)\) \{([\s\S]*?)\n\s+\}/.exec(connectBody)?.[1] ?? "";

  assert.match(failedJoin, /sessions\.delete\(sid\)/);
  assert.match(failedJoin, /clearPeerSessionState\(peer\)/);
  assert.match(failedJoin, /clearPeerSessionState\(waiting\.receiver\)/);
  assert.match(failedJoin, /closePeerAndRelease\(waiting\.receiver, "receiver unavailable"\)/);
  assert.match(failedJoin, /fail\(peer, "peer_unavailable", "Receiver is no longer connected\."\)/);
  assert.doesNotMatch(failedJoin, /delete waiting\.receiver\.sid/);
});

test("receiver retry does not re-acknowledge expired waiting codes", () => {
  const retryBody = extractFunctionBody(serverSource, "retryReceiver");

  assert.match(securityPolicy, /retry\/restoration paths must not re-acknowledge expired receiver rendezvous registrations/);
  assert.match(retryBody, /waitingReceiverAvailable\(waiting\.expiresAt, Date\.now\(\), peer\.ws\.readyState, peer\.ws\.OPEN\)/);
  assert.match(retryBody, /codes\.delete\(code\)/);
  assert.match(retryBody, /clearPeerSessionState\(peer\)/);
  assert.match(retryBody, /fail\(peer, "expired", "Code expired before a sender connected\."\)/);
  assert.match(retryBody, /closePeerAndRelease\(peer, "expired"\)/);
  assert.match(retryBody, /send\(peer, \{ type: "registered", code, expiresInSec: remainingExpirySeconds\(waiting\.expiresAt, Date\.now\(\)\) \}\)/);
});

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
