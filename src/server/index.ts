#!/usr/bin/env node
import http from "node:http";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from "ws";
import {
  CODE_TTL_MS,
  PROTOCOL_VERSION,
  SIGNALING_MAX_BAD_MESSAGES,
  SIGNALING_MAX_BUFFERED_BYTES,
  SIGNALING_CLOSE_GRACE_MS,
  SIGNALING_IDLE_TIMEOUT_MS,
  SIGNALING_MAX_CONNECTIONS_PER_IP,
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_MAX_MESSAGES_PER_MINUTE,
  SIGNALING_MAX_PAYLOAD_BYTES,
  SIGNALING_MAX_SESSIONS,
  SIGNALING_MAX_WAITING_CODES,
  STATIC_MAX_FILE_BYTES
} from "../shared/constants.js";
import { assertManifestWithinLimits } from "../shared/limits.js";
import {
  isClientMessage,
  isProtocolSupported,
  parseJsonTextFrame,
  serializeMessage,
  type ClientMessage,
  type ErrorCode,
  type FileManifest,
  type ServerMessage
} from "../shared/messages.js";
import { isValidRendezvous, normalizeCode } from "../shared/wordlist.js";
import { canCreateSession, canRegisterWaitingCode, staticFileWithinLimit } from "./capacity.js";
import { websocketCloseReason } from "./close-reason.js";
import { corsHeaders, iceServersForRequest, iceServersForUnauthenticatedRequest, loadServerConfig, originAllowedForRequest } from "./config.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../shared/package-info.js";
import { applyHttpServerHardening } from "./http-hardening.js";
import {
  applyRelayPhase,
  otherSessionPeerId,
  publicPairRequestManifestIsRedacted,
  receiverCanRetryPrePair,
  relayAllowedForPhase,
  relayAllowedForRole,
  senderDisconnectCanRestoreReceiver,
  sessionBeforePairAcceptance,
  sessionPeerId,
  type SessionPeerId
} from "./policy.js";
import { canRestorePrePairCode, consumePrePairAttempt, initialPrePairAttempts } from "./prepair-attempts.js";
import { hitFixedWindowRateLimit, hitIceConfigRateLimit, pruneFixedWindowRateLimits, recordFixedWindowHit } from "./rate-limit.js";
import { requestBaseUrl, requestHostAuthority, requestMethod, requestOriginHeader, requestRemoteAddress, requestUrl } from "./request-headers.js";
import { securityHeaders } from "./security-headers.js";
import { initialSessionExpiresAt, nextSessionExpiresAt, remainingExpirySeconds } from "./session-expiry.js";
import { canServeIndexFallback, isMissingStaticPathError, isPathInsideRoot, staticUrlPathToRelative } from "./static-path.js";
import { waitingCodeOwnedBy, waitingReceiverAvailable } from "./waiting.js";
import { signalingBackpressureExceeded } from "./ws-backpressure.js";

type Peer = {
  id: string;
  ws: WebSocket;
  ip: string;
  role?: "sender" | "receiver";
  sid?: string;
  code?: string;
  badMessages: number;
  messageTimes: number[];
  idleTimer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
  awaitingHeartbeatPong: boolean;
  connectionReleased: boolean;
};

type WaitingCode = {
  code: string;
  receiver: Peer;
  expiresAt: number;
  remainingPrePairAttempts: number;
};

type Session = {
  sid: string;
  code: string;
  codeExpiresAt: number;
  sender: Peer;
  receiver: Peer;
  expiresAt: number;
  senderPakeSeen: boolean;
  receiverPakeSeen: boolean;
  senderConfirmed: boolean;
  receiverConfirmed: boolean;
  pairRequested: boolean;
  pairDecided: boolean;
  offerSeen: boolean;
  answerSeen: boolean;
  senderCandidateCount: number;
  receiverCandidateCount: number;
  remainingPrePairAttempts: number;
};

const serverConfig = loadServerConfig();
const { port, host, webRoot, allowedOrigins, browserAllowAnyWss, browserAllowLoopbackWs } = serverConfig;
const realWebRoot = fs.realpath(webRoot).catch(() => webRoot);
const codes = new Map<string, WaitingCode>();
const sessions = new Map<string, Session>();
const rateLimits = new Map<string, number[]>();
const iceHttpRateLimits = new Map<string, number[]>();
const turnIssueRateLimits = new Map<string, number[]>();
const activeConnections = new Map<string, number>();
const peersBySocket = new Map<WebSocket, Peer>();
const SESSION_ID_LENGTH = 32;
const SHUTDOWN_GRACE_MS = 5_000;
let fatalErrorSeen = false;
let shutdownStarted = false;

const server = http.createServer((req, res) => {
  const cors = requestCorsHeaders(req);
  if (cors === null) return json(res, 403, { error: "origin_forbidden" }, {});
  const url = parseRequestUrl(req);
  if (!url) return json(res, 400, { error: "bad_request" }, cors);
  if (requestMethod(req) !== "GET") return methodNotAllowed(res, cors);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true }, cors);
  if (url.pathname === "/v1/version") {
    return json(res, 200, { protocolVersion: PROTOCOL_VERSION, name: PACKAGE_NAME, version: PACKAGE_VERSION }, cors);
  }
  if (url.pathname === "/v1/ice") {
    if (!hitIceConfigHttpRateLimit(req)) return json(res, 429, { error: "rate_limited" }, cors);
    return json(res, 200, { iceServers: iceServersForUnauthenticatedRequest(serverConfig) }, cors);
  }
  serveStatic(url.pathname, res).catch((error) => staticFailure(res, cors, error));
});
applyHttpServerHardening(server);

const verifyOrigin: VerifyClientCallbackSync = ({ req }) => {
  const authority = requestHostAuthority(req);
  if (authority === null || requestBaseUrl(req) === null) return false;
  const origin = requestOriginHeader(req);
  return origin !== null && originAllowedForRequest(origin, allowedOrigins, authority);
};

const wss = new WebSocketServer({
  server,
  path: "/v1/ws",
  maxPayload: SIGNALING_MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
  verifyClient: verifyOrigin
});

server.on("error", fatalServerError);
wss.on("error", fatalServerError);
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

wss.on("connection", (ws, req) => {
  const peer: Peer = {
    id: nanoid(10),
    ws,
    ip: requestRemoteAddress(req),
    badMessages: 0,
    messageTimes: [],
    awaitingHeartbeatPong: false,
    connectionReleased: false
  };

  peersBySocket.set(ws, peer);
  addActiveConnection(peer);
  ws.on("close", () => {
    releaseActiveConnection(peer);
    cleanupPeer(peer, "disconnected");
  });
  ws.on("error", () => {
    cleanupPeer(peer, "socket_error");
    releaseActiveConnection(peer);
  });
  ws.on("pong", () => {
    peer.awaitingHeartbeatPong = false;
  });
  if ((activeConnections.get(peer.ip) ?? 0) > SIGNALING_MAX_CONNECTIONS_PER_IP) {
    fail(peer, "rate_limited", "Too many concurrent signaling connections.");
    closePeerWithCode(peer, 1008, "connection limit");
    return;
  }
  peer.idleTimer = setTimeout(() => {
    if (!peer.role && !peer.sid && !peer.code) closePeerWithCode(peer, 1008, "idle signaling connection");
  }, SIGNALING_IDLE_TIMEOUT_MS);
  peer.idleTimer.unref();

  ws.on("message", (data, isBinary) => {
    if (!peerAcceptsClientMessages(peer)) return;
    if (!hitMessageLimit(peer)) return;
    const parsed = parseJsonTextFrame(data, isBinary);
    if (!isClientMessage(parsed)) return badMessage(peer, "Malformed signaling message.");
    handleMessage(peer, parsed);
  });

});

const heartbeatInterval = setInterval(() => {
  for (const peer of peersBySocket.values()) heartbeatPeer(peer);
}, SIGNALING_HEARTBEAT_INTERVAL_MS);
heartbeatInterval.unref();

const expiryInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      send(entry.receiver, { type: "error", code: "expired", message: "Code expired before a sender connected." });
      clearPeerSessionState(entry.receiver);
      closePeer(entry.receiver, "expired");
      codes.delete(code);
    }
  }
  for (const [sid, session] of sessions) {
    if (session.expiresAt <= now) {
      if (sessionBeforePairAcceptance(session) && session.codeExpiresAt > now && session.receiver.ws.readyState === session.receiver.ws.OPEN) {
        restoreWaitingReceiver(session, "expired", true);
      } else {
        notifyPeerLeft(session, undefined, "expired");
        sessions.delete(sid);
        closeSessionPeers(session, "expired");
      }
    }
  }
  pruneFixedWindowRateLimits(rateLimits, now, 60_000);
  pruneFixedWindowRateLimits(iceHttpRateLimits, now, 60_000);
  pruneFixedWindowRateLimits(turnIssueRateLimits, now, 60_000);
}, 15_000);
expiryInterval.unref();

server.listen(port, host, () => {
  console.log(`ff signaling server listening on http://${host}:${port}`);
});

function fatalServerError(error: Error): void {
  if (fatalErrorSeen) return;
  fatalErrorSeen = true;
  shutdownStarted = true;
  stopLifecycleTimers();
  console.error("ff signaling server failed:", operationalErrorSummary(error));
  for (const client of wss.clients) closeWebSocketForShutdown(client);
  const forceExit = scheduleForcedProcessExit(1);
  server.close((closeError) => finishProcessAfterServerClose(1, forceExit, closeError));
}

function operationalErrorSummary(error: Error): string {
  const parts = [ownErrorData(error, "code"), ownErrorData(error, "syscall"), ownErrorData(error, "address"), ownErrorData(error, "port")].filter(
    (part) => typeof part === "string" || typeof part === "number"
  );
  const name = ownErrorData(error, "name");
  return parts.length > 0 ? parts.join(" ") : typeof name === "string" && name.length > 0 ? name : "Error";
}

function ownErrorData(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopLifecycleTimers();
  console.log(`ff signaling server shutting down on ${signal}`);
  for (const client of wss.clients) closeWebSocketForShutdown(client);
  const forceExit = scheduleForcedProcessExit(0);
  server.close((closeError) => finishProcessAfterServerClose(0, forceExit, closeError));
}

function stopLifecycleTimers(): void {
  clearInterval(heartbeatInterval);
  clearInterval(expiryInterval);
}

function scheduleForcedProcessExit(code: number): ReturnType<typeof setTimeout> {
  process.exitCode = code;
  return setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    process.exit(code);
  }, SHUTDOWN_GRACE_MS);
}

function finishProcessAfterServerClose(code: number, forceExit: ReturnType<typeof setTimeout>, error?: Error): void {
  clearTimeout(forceExit);
  if (error && ownErrorData(error, "code") !== "ERR_SERVER_NOT_RUNNING") {
    console.error("ff signaling server close failed:", operationalErrorSummary(error));
    process.exitCode = 1;
    return;
  }
  process.exitCode = code;
}

function closeWebSocketForShutdown(client: WebSocket): void {
  const peer = peersBySocket.get(client);
  if (peer) {
    closePeerWithCode(peer, 1001, "server shutdown");
    return;
  }
  try {
    client.close(1001, "server shutdown");
    scheduleStandaloneCloseTermination(client);
  } catch {
    client.terminate();
  }
}

function handleMessage(peer: Peer, message: ClientMessage): void {
  switch (message.type) {
    case "register":
      return register(peer, message);
    case "connect":
      return connect(peer, message);
    case "pake":
    case "confirm":
    case "pair-request":
    case "pair-accept":
    case "pair-reject":
    case "signal":
      return relay(peer, message);
    case "bye":
      if (message.reason === "prepair_retry" && retryReceiver(peer)) return;
      cleanupPeer(peer, peerVisibleByeReason(message.reason));
      return closePeer(peer, "bye");
  }
}

function peerVisibleByeReason(reason: string | undefined): string {
  if (reason === "complete") return "complete";
  if (reason === "cancelled") return "cancelled";
  return "bye";
}

function register(peer: Peer, message: Extract<ClientMessage, { type: "register" }>): void {
  if (!hitRateLimit(peer)) return;
  if (peer.sid) return fail(peer, "bad_message", "Peer is already paired.");
  if (peer.role === "sender") return fail(peer, "bad_message", "Peer is already registered as a sender.");
  if (!isProtocolSupported(message.protocolVersion)) {
    return fail(peer, "bad_protocol", `Only protocolVersion ${PROTOCOL_VERSION} is supported.`);
  }
  const code = normalizeCode(message.code);
  if (!isValidRendezvous(code)) return fail(peer, "bad_message", "Rendezvous id is invalid.");
  const existingCode = codes.get(code);
  const replacingClaimedCode = waitingCodeOwnedBy(existingCode, peer.id);
  const now = Date.now();
  if (replacingClaimedCode && existingCode) {
    if (!waitingReceiverAvailable(existingCode.expiresAt, now, peer.ws.readyState, peer.ws.OPEN)) {
      codes.delete(code);
      clearPeerSessionState(peer);
      fail(peer, "expired", "Code expired before a sender connected.");
      closePeer(peer, "expired");
      return;
    }
    peer.role = "receiver";
    peer.code = code;
    clearIdleTimer(peer);
    send(peer, { type: "registered", code, expiresInSec: remainingExpirySeconds(existingCode.expiresAt, now) });
    return;
  }
  if (existingCode && !replacingClaimedCode) return fail(peer, "code_taken", "That code is already waiting for a sender.");
  const replacingPreviousOwnCode = Boolean(peer.code && peer.code !== code && waitingCodeOwnedBy(codes.get(peer.code), peer.id));
  const replacingOwnCode = replacingPreviousOwnCode;
  if (!canRegisterWaitingCode(codes.size, SIGNALING_MAX_WAITING_CODES, replacingOwnCode)) {
    return fail(peer, "rate_limited", "Signaling server is at capacity. Try again shortly.");
  }
  if (replacingPreviousOwnCode && peer.code) codes.delete(peer.code);

  peer.role = "receiver";
  peer.code = code;
  clearIdleTimer(peer);
  codes.set(code, { code, receiver: peer, expiresAt: now + CODE_TTL_MS, remainingPrePairAttempts: initialPrePairAttempts() });
  send(peer, { type: "registered", code, expiresInSec: Math.floor(CODE_TTL_MS / 1000) });
}

function connect(peer: Peer, message: Extract<ClientMessage, { type: "connect" }>): void {
  if (!hitRateLimit(peer)) return;
  if (peer.sid) return fail(peer, "bad_message", "Peer is already paired.");
  if (peer.role === "receiver") return fail(peer, "bad_message", "Peer is already registered as a receiver.");
  if (!isProtocolSupported(message.protocolVersion)) {
    return fail(peer, "bad_protocol", `Only protocolVersion ${PROTOCOL_VERSION} is supported.`);
  }
  const code = normalizeCode(message.code);
  if (!isValidRendezvous(code)) return fail(peer, "bad_message", "Rendezvous id is invalid.");
  const waiting = codes.get(code);
  if (!waiting) return fail(peer, "code_not_found", "No receiver is waiting for that code.");
  if (!waitingReceiverAvailable(waiting.expiresAt, Date.now(), waiting.receiver.ws.readyState, waiting.receiver.ws.OPEN)) {
    codes.delete(code);
    clearPeerSessionState(waiting.receiver);
    fail(waiting.receiver, "expired", "Code expired before a sender connected.");
    closePeer(waiting.receiver, "expired");
    return fail(peer, "code_not_found", "No receiver is waiting for that code.");
  }
  if (!canRestorePrePairCode(waiting.remainingPrePairAttempts)) {
    codes.delete(code);
    clearPeerSessionState(waiting.receiver);
    fail(waiting.receiver, "expired", "Receive code expired after too many invalid pairing attempts.");
    closePeer(waiting.receiver, "too many invalid pairing attempts");
    return fail(peer, "code_not_found", "No receiver is waiting for that code.");
  }
  if (waiting.receiver.id === peer.id) return badMessage(peer, "Cannot connect to your own receiver code.");
  if (!canCreateSession(sessions.size, SIGNALING_MAX_SESSIONS)) {
    return fail(peer, "rate_limited", "Signaling server is at capacity. Try again shortly.");
  }
  const remainingPrePairAttempts = consumePrePairAttempt(waiting.remainingPrePairAttempts);
  codes.delete(code);
  if (peer.code && codes.get(peer.code)?.receiver.id === peer.id) codes.delete(peer.code);

  const sid = nanoid(SESSION_ID_LENGTH);
  peer.role = "sender";
  peer.sid = sid;
  peer.code = code;
  clearIdleTimer(peer);
  waiting.receiver.sid = sid;
  const session: Session = {
    sid,
    code,
    codeExpiresAt: waiting.expiresAt,
    sender: peer,
    receiver: waiting.receiver,
    expiresAt: initialSessionExpiresAt(Date.now()),
    senderPakeSeen: false,
    receiverPakeSeen: false,
    senderConfirmed: false,
    receiverConfirmed: false,
    pairRequested: false,
    pairDecided: false,
    offerSeen: false,
    answerSeen: false,
    senderCandidateCount: 0,
    receiverCandidateCount: 0,
    remainingPrePairAttempts
  };
  sessions.set(sid, session);
  if (!send(waiting.receiver, { type: "peer-joined", sid })) {
    sessions.delete(sid);
    clearPeerSessionState(peer);
    clearPeerSessionState(waiting.receiver);
    closePeer(waiting.receiver, "receiver unavailable");
    fail(peer, "peer_unavailable", "Receiver is no longer connected.");
    return;
  }
  if (!send(peer, { type: "peer-joined", sid })) {
    restoreWaitingReceiver(session, "sender unavailable", true);
  }
}

function relay(peer: Peer, message: Extract<ClientMessage, { sid: string }>): void {
  const session = sessions.get(message.sid);
  if (!session) return fail(peer, "session_not_found", "Session is no longer active.");
  if (session.sender.id !== peer.id && session.receiver.id !== peer.id) {
    return fail(peer, "session_not_found", "Session is no longer active.");
  }
  if (message.type === "pair-request" && !manifestWithinLimits(message.manifest)) {
    return rejectRelayMessage(session, peer, "Manifest exceeds transfer limits.");
  }
  if (message.type === "pair-request" && !publicPairRequestManifestIsRedacted(message.manifest)) {
    return rejectRelayMessage(session, peer, "Pair request manifest must be redacted.");
  }
  if (!relayAllowedForRole(session, peer, message)) {
    return rejectRelayMessage(session, peer, "Message is not valid for this peer role.");
  }
  if (!relayAllowedForPhase(session, peer, message)) {
    return rejectRelayMessage(session, peer, "Message is not valid in this session phase.");
  }
  const target = session.sender.id === peer.id ? session.receiver : session.sender;
  const terminalReject = message.type === "pair-reject";
  if (target.ws.readyState !== target.ws.OPEN) {
    return relayDeliveryFailed(session, peer, target, terminalReject ? "pair rejected" : "peer unavailable", !terminalReject);
  }
  if (message.type === "pair-accept") {
    if (!sendIceConfig(session.sender) || !send(target, message as ServerMessage)) return relayDeliveryFailed(session, peer, target, "peer unavailable");
    if (!sendIceConfig(session.receiver)) {
      closeSessionPeers(session, "receiver unavailable");
      return;
    }
    applyRelayPhase(session, peer, message);
    session.expiresAt = nextSessionExpiresAt(session.expiresAt, Date.now(), message);
    return;
  }
  if (!send(target, message as ServerMessage)) {
    return relayDeliveryFailed(session, peer, target, terminalReject ? "pair rejected" : "peer unavailable", !terminalReject);
  }
  applyRelayPhase(session, peer, message);
  session.expiresAt = nextSessionExpiresAt(session.expiresAt, Date.now(), message);
  if (message.type === "pair-reject") {
    sessions.delete(session.sid);
    closeSessionPeers(session, "pair rejected");
  }
}

function rejectRelayMessage(session: Session, peer: Peer, message: string): void {
  if (senderDisconnectCanRestoreReceiver(session, peer)) {
    fail(peer, "bad_message", message);
    restoreWaitingReceiver(session, "invalid sender pre-pair message", true);
    return;
  }
  badMessage(peer, message);
}

function relayDeliveryFailed(session: Session, peer: Peer, target: Peer, reason: string, restoreReceiverOnSenderFailure = true): void {
  fail(peer, "peer_unavailable", "Peer is no longer connected.");
  const targetPeerId = sessionPeerId(session, target);
  if (restoreReceiverOnSenderFailure && targetPeerId === "sender" && sessionBeforePairAcceptance(session)) {
    restoreWaitingReceiver(session, reason, true);
    return;
  }
  endSession(session, reason, targetPeerId ?? undefined);
}

function cleanupPeer(peer: Peer, reason: string): void {
  if (peer.code && codes.get(peer.code)?.receiver.id === peer.id) codes.delete(peer.code);
  if (!peer.sid) return;
  const session = sessions.get(peer.sid);
  if (!session) return;
  if (senderDisconnectCanRestoreReceiver(session, peer)) {
    restoreWaitingReceiver(session, "disconnected", true);
    return;
  }
  const peerId = sessionPeerId(session, peer);
  if (!peerId) return;
  endSession(session, reason, peerId);
}

function retryReceiver(peer: Peer): boolean {
  if (!peer.sid) {
    const code = peer.code;
    const waiting = code ? codes.get(code) : undefined;
    if (code && waiting?.receiver.id === peer.id) {
      if (!waitingReceiverAvailable(waiting.expiresAt, Date.now(), peer.ws.readyState, peer.ws.OPEN)) {
        codes.delete(code);
        clearPeerSessionState(peer);
        fail(peer, "expired", "Code expired before a sender connected.");
        closePeer(peer, "expired");
        return true;
      }
      send(peer, { type: "registered", code, expiresInSec: remainingExpirySeconds(waiting.expiresAt, Date.now()) });
      return true;
    }
    return false;
  }
  const session = sessions.get(peer.sid);
  if (!session || !receiverCanRetryPrePair(session, peer)) return false;
  restoreWaitingReceiver(session, "receiver retry", false);
  return true;
}

function restoreWaitingReceiver(session: Session, reason: string, notifyReceiver: boolean): void {
  const existing = codes.get(session.code);
  if (existing) {
    sessions.delete(session.sid);
    if (existing.receiver.id === session.receiver.id) {
      clearPeerSessionState(session.sender);
      delete session.receiver.sid;
      session.receiver.role = "receiver";
      session.receiver.code = session.code;
      existing.remainingPrePairAttempts = Math.min(existing.remainingPrePairAttempts, session.remainingPrePairAttempts);
      if (!canRestorePrePairCode(existing.remainingPrePairAttempts)) {
        expireReceiverAfterPrePairAttempts(session, existing);
        return;
      }
      if (notifyReceiver) notifyPeerLeft(session, session.sender, reason);
      closePeer(session.sender, reason);
      sendRestoredRegistration(session, existing.expiresAt);
      return;
    }
    notifyPeerLeft(session, undefined, "rendezvous_conflict");
    closeSessionPeers(session, "rendezvous conflict");
    return;
  }
  sessions.delete(session.sid);
  clearPeerSessionState(session.sender);
  delete session.receiver.sid;
  session.receiver.role = "receiver";
  session.receiver.code = session.code;
  if (!canRestorePrePairCode(session.remainingPrePairAttempts)) {
    expireReceiverAfterPrePairAttempts(session);
    return;
  }
  codes.set(session.code, { code: session.code, receiver: session.receiver, expiresAt: session.codeExpiresAt, remainingPrePairAttempts: session.remainingPrePairAttempts });
  if (notifyReceiver) notifyPeerLeft(session, session.sender, reason);
  closePeer(session.sender, reason);
  sendRestoredRegistration(session, session.codeExpiresAt);
}

function expireReceiverAfterPrePairAttempts(session: Session, existing?: WaitingCode): void {
  if (existing) codes.delete(existing.code);
  clearPeerSessionState(session.sender);
  clearPeerSessionState(session.receiver);
  fail(session.receiver, "expired", "Receive code expired after too many invalid pairing attempts.");
  closePeer(session.sender, "too many invalid pairing attempts");
  closePeer(session.receiver, "too many invalid pairing attempts");
}

function sendRestoredRegistration(session: Session, expiresAt: number): void {
  if (send(session.receiver, { type: "registered", code: session.code, expiresInSec: remainingExpirySeconds(expiresAt, Date.now()) })) return;
  const waiting = codes.get(session.code);
  if (waiting?.receiver.id === session.receiver.id) codes.delete(session.code);
  clearPeerSessionState(session.receiver);
  closePeer(session.receiver, "receiver unavailable");
}

function addActiveConnection(peer: Peer): void {
  activeConnections.set(peer.ip, (activeConnections.get(peer.ip) ?? 0) + 1);
}

function releaseActiveConnection(peer: Peer): void {
  if (peer.connectionReleased) return;
  peer.connectionReleased = true;
  peersBySocket.delete(peer.ws);
  clearIdleTimer(peer);
  clearCloseTimer(peer);
  const count = activeConnections.get(peer.ip) ?? 0;
  count <= 1 ? activeConnections.delete(peer.ip) : activeConnections.set(peer.ip, count - 1);
}

function clearIdleTimer(peer: Peer): void {
  if (!peer.idleTimer) return;
  clearTimeout(peer.idleTimer);
  delete peer.idleTimer;
}

function clearCloseTimer(peer: Peer): void {
  if (!peer.closeTimer) return;
  clearTimeout(peer.closeTimer);
  delete peer.closeTimer;
}

function notifyPeerLeft(session: Session, leaving: Peer | undefined, reason: string): void {
  for (const peer of [session.sender, session.receiver]) {
    if (leaving && peer.id === leaving.id) continue;
    send(peer, { type: "peer-left", sid: session.sid, reason });
  }
}

function endSession(session: Session, reason: string, leavingPeerId?: SessionPeerId): void {
  sessions.delete(session.sid);
  const leaving = leavingPeerId ? session[leavingPeerId] : undefined;
  const remaining = leavingPeerId ? session[otherSessionPeerId(leavingPeerId)] : undefined;
  notifyPeerLeft(session, leaving, reason);
  clearPeerSessionState(session.sender);
  clearPeerSessionState(session.receiver);
  if (remaining) closePeer(remaining, reason);
}

function closeSessionPeers(session: Session, reason: string): void {
  sessions.delete(session.sid);
  clearPeerSessionState(session.sender);
  clearPeerSessionState(session.receiver);
  closePeer(session.sender, reason);
  closePeer(session.receiver, reason);
}

function clearPeerSessionState(peer: Peer): void {
  delete peer.sid;
  delete peer.code;
  delete peer.role;
}

function closePeer(peer: Peer, reason: string): void {
  closePeerWithCode(peer, 1000, reason);
}

function closePeerWithCode(peer: Peer, code: number, reason: string): void {
  if (peer.ws.readyState === peer.ws.OPEN || peer.ws.readyState === peer.ws.CONNECTING || peer.ws.readyState === peer.ws.CLOSING) {
    try {
      peer.ws.close(code, websocketCloseReason(reason));
      scheduleCloseTermination(peer);
    } catch {
      peer.ws.terminate();
    }
  }
}

function scheduleCloseTermination(peer: Peer): void {
  if (peer.closeTimer) return;
  peer.closeTimer = setTimeout(() => {
    delete peer.closeTimer;
    if (peer.ws.readyState !== peer.ws.CLOSED) peer.ws.terminate();
  }, SIGNALING_CLOSE_GRACE_MS);
  peer.closeTimer.unref();
}

function scheduleStandaloneCloseTermination(client: WebSocket): void {
  const timer = setTimeout(() => {
    if (client.readyState !== client.CLOSED) client.terminate();
  }, SIGNALING_CLOSE_GRACE_MS);
  timer.unref();
}

function heartbeatPeer(peer: Peer): void {
  if (peer.ws.readyState !== peer.ws.OPEN) return;
  if (peer.awaitingHeartbeatPong) {
    cleanupPeer(peer, "heartbeat_timeout");
    releaseActiveConnection(peer);
    peer.ws.terminate();
    return;
  }
  peer.awaitingHeartbeatPong = true;
  try {
    peer.ws.ping();
  } catch {
    cleanupPeer(peer, "heartbeat_error");
    releaseActiveConnection(peer);
    peer.ws.terminate();
  }
}

function peerAcceptsClientMessages(peer: Peer): boolean {
  return peer.ws.readyState === peer.ws.OPEN && !peer.closeTimer && !peer.connectionReleased;
}

function send(peer: Peer, message: ServerMessage): boolean {
  if (peer.ws.readyState !== peer.ws.OPEN) return false;
  if (signalingBackpressureExceeded(peer.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
    closePeerForSendFailure(peer, "signaling backpressure");
    return false;
  }
  try {
    peer.ws.send(serializeMessage(message));
    if (signalingBackpressureExceeded(peer.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
      closePeerForSendFailure(peer, "signaling backpressure");
      return false;
    }
    return true;
  } catch {
    closePeerForSendFailure(peer, "send_error");
    return false;
  }
}

function closePeerForSendFailure(peer: Peer, reason: string): void {
  cleanupPeer(peer, reason);
  closePeer(peer, reason);
}

function fail(peer: Peer, code: ErrorCode, message: string): void {
  send(peer, { type: "error", code, message });
}

function sendIceConfig(peer: Peer): boolean {
  const iceServers = hitIceConfigRateLimit(turnIssueRateLimits, peer.ip) ? iceServersForRequest(serverConfig) : iceServersForUnauthenticatedRequest(serverConfig);
  return send(peer, { type: "ice-config", iceServers });
}

function badMessage(peer: Peer, message: string): void {
  if (rejectMalformedPrePairSenderMessage(peer, message)) return;
  peer.badMessages += 1;
  fail(peer, "bad_message", message);
  if (peer.badMessages >= SIGNALING_MAX_BAD_MESSAGES) closePeerWithCode(peer, 1008, "too many malformed messages");
}

function rejectMalformedPrePairSenderMessage(peer: Peer, message: string): boolean {
  const session = peer.sid ? sessions.get(peer.sid) : undefined;
  if (!session || !senderDisconnectCanRestoreReceiver(session, peer)) return false;
  fail(peer, "bad_message", message);
  restoreWaitingReceiver(session, "invalid sender pre-pair message", true);
  return true;
}

function hitRateLimit(peer: Peer): boolean {
  const now = Date.now();
  if (hitFixedWindowRateLimit(rateLimits, peer.ip, now, 60_000, 60)) return true;
  fail(peer, "rate_limited", "Too many attempts. Try again shortly.");
  return false;
}

function hitIceConfigHttpRateLimit(req: http.IncomingMessage): boolean {
  return hitIceConfigRateLimit(iceHttpRateLimits, requestIp(req));
}

function hitMessageLimit(peer: Peer): boolean {
  const now = Date.now();
  const result = recordFixedWindowHit(peer.messageTimes, now, 60_000, SIGNALING_MAX_MESSAGES_PER_MINUTE);
  peer.messageTimes = result.hits;
  if (result.allowed) return true;
  fail(peer, "rate_limited", "Too many signaling messages. Try again shortly.");
  closePeerWithCode(peer, 1008, "signaling message rate limit");
  return false;
}

function json(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
    ...securityHeaders(false)
  });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res: http.ServerResponse, extraHeaders: Record<string, string>): void {
  res.writeHead(405, {
    allow: "GET",
    connection: "close",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
    ...securityHeaders(false)
  });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}

function requestCorsHeaders(req: http.IncomingMessage): Record<string, string> | null {
  const origin = requestOriginHeader(req);
  if (origin === null) return null;
  if (origin !== undefined && !originAllowedForRequest(origin, allowedOrigins, requestHostAuthority(req))) return null;
  return corsHeaders(origin, allowedOrigins);
}

function requestIp(req: http.IncomingMessage): string {
  return requestRemoteAddress(req);
}

function parseRequestUrl(req: http.IncomingMessage): URL | null {
  return requestUrl(req);
}

async function serveStatic(urlPath: string, res: http.ServerResponse): Promise<void> {
  const relative = staticRelativePath(urlPath);
  const candidate = path.resolve(webRoot, relative);
  if (!isPathInsideRoot(webRoot, candidate)) throw staticHttpError(404);
  let filePath = candidate;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch (error) {
    if (!isMissingStaticPathError(error)) throw staticHttpError(500);
    if (!canServeIndexFallback(relative)) throw staticHttpError(404);
    filePath = path.join(webRoot, "index.html");
  }
  const [root, realFilePath] = await Promise.all([realWebRoot, fs.realpath(filePath)]);
  if (!isPathInsideRoot(root, realFilePath)) throw staticHttpError(404);
  const body = await readStaticFile(realFilePath);
  const type = contentType(realFilePath);
  const isHtml = type.startsWith("text/html;");
  res.writeHead(200, {
    "content-type": type,
    "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
    ...securityHeaders(isHtml, { allowAnyWss: browserAllowAnyWss, allowLoopbackWs: browserAllowLoopbackWs })
  });
  res.end(body);
}

function staticRelativePath(urlPath: string): string {
  try {
    return staticUrlPathToRelative(urlPath);
  } catch {
    throw staticHttpError(404);
  }
}

function staticFailure(res: http.ServerResponse, extraHeaders: Record<string, string>, error: unknown): void {
  const status = staticHttpStatus(error);
  json(res, status, { error: status === 404 ? "not_found" : "internal_error" }, extraHeaders);
}

function staticHttpError(status: 404 | 500): Error & { staticHttpStatus: 404 | 500 } {
  const error = new Error("static request failed") as Error & { staticHttpStatus: 404 | 500 };
  error.staticHttpStatus = status;
  return error;
}

function staticHttpStatus(error: unknown): 404 | 500 {
  if (typeof error !== "object" || error === null) return 500;
  const descriptor = Object.getOwnPropertyDescriptor(error, "staticHttpStatus");
  return descriptor && "value" in descriptor && descriptor.value === 404 ? 404 : 500;
}

async function readStaticFile(filePath: string): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await fs.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !staticFileWithinLimit(stat.size, STATIC_MAX_FILE_BYTES)) throw new Error("static asset exceeds maximum size");
    return await readBoundedFile(handle, STATIC_MAX_FILE_BYTES);
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const scratch = Buffer.alloc(64 * 1024);
  let total = 0;
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(scratch, 0, scratch.length, position);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (!staticFileWithinLimit(total, maxBytes)) throw new Error("static asset exceeds maximum size");
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function manifestWithinLimits(manifest: FileManifest): boolean {
  try {
    assertManifestWithinLimits(manifest);
    return true;
  } catch {
    return false;
  }
}
