import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import {
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_CLOSE_GRACE_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_HEADERS_COUNT,
  HTTP_REQUEST_TIMEOUT_MS,
  SIGNALING_MAX_CONNECTION_ATTEMPTS_PER_MINUTE,
  STATIC_MAX_REQUESTS_PER_MINUTE
} from "../src/shared/constants.js";
import { applyHttpServerHardening } from "../src/server/http-hardening.js";
import { applyHttpServerHardening as distApplyHttpServerHardening } from "../dist-node/server/http-hardening.js";

const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const distServerSource = fs.readFileSync(new URL("../dist-node/server/index.js", import.meta.url), "utf8");
const httpHardeningSource = fs.readFileSync(new URL("../src/server/http-hardening.ts", import.meta.url), "utf8");
const distHttpHardeningSource = fs.readFileSync(new URL("../dist-node/server/http-hardening.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

const httpHardeningKeys = ["headersTimeout", "requestTimeout", "keepAliveTimeout", "maxHeadersCount"] as const;

test("http server hardening sets strict production socket limits", () => {
  const server = http.createServer();
  applyHttpServerHardening(server);
  assert.equal(server.headersTimeout, HTTP_HEADERS_TIMEOUT_MS);
  assert.equal(server.requestTimeout, HTTP_REQUEST_TIMEOUT_MS);
  assert.equal(server.keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT_MS);
  assert.equal(server.maxHeadersCount, HTTP_MAX_HEADERS_COUNT);
  server.close();

  const distServer = http.createServer();
  distApplyHttpServerHardening(distServer);
  assert.equal(distServer.headersTimeout, HTTP_HEADERS_TIMEOUT_MS);
  assert.equal(distServer.requestTimeout, HTTP_REQUEST_TIMEOUT_MS);
  assert.equal(distServer.keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT_MS);
  assert.equal(distServer.maxHeadersCount, HTTP_MAX_HEADERS_COUNT);
  distServer.close();
});

test("http server hardening rejects malformed server-like runtime values", () => {
  assert.match(securityPolicy, /HTTP server hardening helpers must require own writable data properties/);
  for (const helper of [applyHttpServerHardening, distApplyHttpServerHardening]) {
    let invokedAccessor = false;
    const hostileAccessorServer: Record<string, unknown> = {};
    for (const key of httpHardeningKeys) {
      Object.defineProperty(hostileAccessorServer, key, {
        enumerable: true,
        get() {
          invokedAccessor = true;
          return 0;
        },
        set() {
          invokedAccessor = true;
        }
      });
    }
    assert.throws(() => helper(hostileAccessorServer as never), /HTTP server is invalid/);
    assert.equal(invokedAccessor, false);

    assert.throws(() => helper({} as never), /HTTP server is invalid/);

    const frozenServer = {
      headersTimeout: 0,
      requestTimeout: 0,
      keepAliveTimeout: 0,
      maxHeadersCount: 0
    };
    Object.defineProperty(frozenServer, "headersTimeout", {
      value: 0,
      writable: false,
      enumerable: true,
      configurable: true
    });
    assert.throws(() => helper(frozenServer as never), /HTTP server is invalid/);

    const fakeServer = {
      headersTimeout: 0,
      requestTimeout: 0,
      keepAliveTimeout: 0,
      maxHeadersCount: 0
    };
    assert.doesNotThrow(() => helper(fakeServer as never));
    assert.equal(fakeServer.headersTimeout, HTTP_HEADERS_TIMEOUT_MS);
    assert.equal(fakeServer.requestTimeout, HTTP_REQUEST_TIMEOUT_MS);
    assert.equal(fakeServer.keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(fakeServer.maxHeadersCount, HTTP_MAX_HEADERS_COUNT);
  }

  for (const source of [httpHardeningSource, distHttpHardeningSource]) {
    assert.match(source, /function setServerHardeningNumber/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(server, key\)/);
    assert.match(source, /Object\.defineProperty\(server, key/);
    assert.doesNotMatch(source, /server\.headersTimeout =/);
    assert.doesNotMatch(source, /server\.requestTimeout =/);
    assert.doesNotMatch(source, /server\.keepAliveTimeout =/);
    assert.doesNotMatch(source, /server\.maxHeadersCount =/);
  }
});

test("unsupported HTTP methods are not kept alive", () => {
  const methodNotAllowed = extractFunctionBody(serverSource, "methodNotAllowed");
  assert.match(methodNotAllowed, /connection:\s+"close"/);
});

test("JSON HTTP errors are not kept alive", () => {
  assert.match(securityPolicy, /JSON HTTP error responses must explicitly close the connection/);
  for (const source of [serverSource, distServerSource]) {
    const jsonBody = extractFunctionBody(source, "json");
    assert.match(jsonBody, /\.\.\.errorConnectionHeader\(status\)/);
    const errorConnectionHeader = extractFunctionBody(source, "errorConnectionHeader");
    assert.match(errorConnectionHeader, /status >= 200 && status < 300/);
    assert.match(errorConnectionHeader, /connection:\s+"close"/);
  }
});

test("websocket peers are heartbeat-terminated to release stale capacity", () => {
  assert.equal(SIGNALING_HEARTBEAT_INTERVAL_MS, 30_000);
  assert.match(securityPolicy, /signaling WebSockets must use an application heartbeat/);
  assert.match(serverSource, /awaitingHeartbeatPong: boolean/);
  assert.match(serverSource, /const peersBySocket = new Map<WebSocket, Peer>\(\)/);
  assert.match(serverSource, /ws\.on\("pong", \(\) => \{[\s\S]*peer\.awaitingHeartbeatPong = false;/);
  assert.match(serverSource, /const heartbeatInterval = setInterval\(\(\) => \{[\s\S]*heartbeatPeer\(peer\)/);
  assert.match(serverSource, /heartbeatInterval\.unref\(\)/);
  const stopTimersBody = extractFunctionBody(serverSource, "stopLifecycleTimers");
  assert.match(stopTimersBody, /clearInterval\(heartbeatInterval\)/);
  const releaseBody = extractFunctionBody(serverSource, "releaseActiveConnection");
  assert.match(releaseBody, /peersBySocket\.delete\(peer\.ws\)/);
  const heartbeatBody = extractFunctionBody(serverSource, "heartbeatPeer");
  assert.match(heartbeatBody, /peer\.awaitingHeartbeatPong/);
  assert.match(heartbeatBody, /cleanupPeer\(peer, "heartbeat_timeout"\)/);
  assert.match(heartbeatBody, /releaseActiveConnection\(peer\)/);
  assert.match(heartbeatBody, /peer\.ws\.terminate\(\)/);
  assert.match(heartbeatBody, /peer\.ws\.ping\(\)/);
  assert.match(heartbeatBody, /cleanupPeer\(peer, "heartbeat_error"\)/);
});

test("unauthenticated server surfaces rate-limit connection churn and static HTTP work", () => {
  assert.equal(SIGNALING_MAX_CONNECTION_ATTEMPTS_PER_MINUTE, 120);
  assert.equal(STATIC_MAX_REQUESTS_PER_MINUTE, 300);
  assert.match(securityPolicy, /WebSocket upgrade attempts, including malformed or disallowed `Host`\/`Origin` attempts, must hit a per-IP fixed-window limiter before origin policy checks or connection state acceptance/);
  assert.match(securityPolicy, /unauthenticated HTTP requests, including malformed or disallowed `Host`\/`Origin` attempts, static requests, and JSON control-plane requests such as `\/healthz` and `\/v1\/version`, must hit a per-IP fixed-window limiter before CORS\/origin policy checks/);
  assert.match(serverSource, /const staticHttpRateLimits = new Map<string, number\[\]>\(\)/);
  assert.match(serverSource, /const websocketConnectionRateLimits = new Map<string, number\[\]>\(\)/);
  assert.match(serverSource, /const server = http\.createServer\(\(req, res\) => \{[\s\S]*if \(!hitStaticHttpRateLimit\(req\)\) return json\(res, 429, \{ error: "rate_limited" \}, \{\}\);[\s\S]*const cors = requestCorsHeaders\(req\)/);
  assert.doesNotMatch(serverSource, /origin_forbidden[\s\S]{0,240}hitStaticHttpRateLimit\(req\)/);
  assert.match(serverSource, /const verifyOrigin: VerifyClientCallbackSync = \(\{ req \}\) => \{[\s\S]*if \(!hitWebSocketConnectionRateLimit\(req\)\) return false;[\s\S]*const authority = requestHostAuthority\(req\)/);
  assert.doesNotMatch(serverSource, /originAllowedForRequest\(origin, allowedOrigins, authority\) && hitWebSocketConnectionRateLimit\(req\)/);
  assert.match(serverSource, /hitFixedWindowRateLimit\(staticHttpRateLimits, requestIp\(req\), Date\.now\(\), 60_000, STATIC_MAX_REQUESTS_PER_MINUTE\)/);
  assert.match(serverSource, /hitFixedWindowRateLimit\(websocketConnectionRateLimits, requestIp\(req\), Date\.now\(\), 60_000, SIGNALING_MAX_CONNECTION_ATTEMPTS_PER_MINUTE\)/);
  assert.match(serverSource, /pruneFixedWindowRateLimits\(staticHttpRateLimits, now, 60_000\)/);
  assert.match(serverSource, /pruneFixedWindowRateLimits\(websocketConnectionRateLimits, now, 60_000\)/);
  assert.match(distServerSource, /staticHttpRateLimits/);
  assert.match(distServerSource, /websocketConnectionRateLimits/);
});

test("production version endpoint exposes protocol compatibility only", () => {
  assert.match(securityPolicy, /production `\/v1\/version` responses must expose only protocol compatibility/);
  assert.match(serverSource, /return json\(res, 200, versionResponse\(\), cors\)/);
  assert.match(serverSource, /function versionResponse\(\): \{ protocolVersion: number; name\?: string; version\?: string \} \{[\s\S]*if \(production\) return \{ protocolVersion: PROTOCOL_VERSION \};[\s\S]*return \{ protocolVersion: PROTOCOL_VERSION, name: PACKAGE_NAME, version: PACKAGE_VERSION \};[\s\S]*\}/);
  assert.match(distServerSource, /function versionResponse\(\) \{[\s\S]*if \(production\)[\s\S]*return \{ protocolVersion: PROTOCOL_VERSION \};[\s\S]*return \{ protocolVersion: PROTOCOL_VERSION, name: PACKAGE_NAME, version: PACKAGE_VERSION \};[\s\S]*\}/);
});

test("server lifecycle intervals stop on shutdown and fatal errors", () => {
  assert.match(securityPolicy, /shutdown and fatal-error paths must clear server lifecycle intervals/);
  assert.match(securityPolicy, /fatal-error summaries must read error fields through own data descriptors/);
  assert.match(securityPolicy, /server startup failures must write the sanitized startup failure line synchronously before exiting/);
  assert.match(securityPolicy, /server shutdown and fatal-error close callbacks must set `process\.exitCode`/);
  const startupFailureBody = extractFunctionBody(serverSource, "startupFailure");
  assert.match(startupFailureBody, /writeSync\(2, `ff signaling server startup failed: \$\{scope\} \$\{startupErrorSummary\(error\)\}\\n`\)/);
  assert.doesNotMatch(startupFailureBody, /console\.error/);
  assert.match(serverSource, /const expiryInterval = setInterval\(\(\) => \{/);
  assert.match(serverSource, /expiryInterval\.unref\(\)/);
  const stopTimersBody = extractFunctionBody(serverSource, "stopLifecycleTimers");
  assert.match(stopTimersBody, /clearInterval\(heartbeatInterval\)/);
  assert.match(stopTimersBody, /clearInterval\(expiryInterval\)/);
  const shutdownBody = extractFunctionBody(serverSource, "shutdown");
  assert.match(shutdownBody, /stopLifecycleTimers\(\)/);
  assert.match(shutdownBody, /const forceExit = scheduleForcedProcessExit\(0\)/);
  assert.match(shutdownBody, /server\.close\(\(closeError\) => finishProcessAfterServerClose\(0, forceExit, closeError\)\)/);
  assert.doesNotMatch(shutdownBody, /server\.close\(\(\) => process\.exit/);
  assert.doesNotMatch(shutdownBody, /clearInterval\(heartbeatInterval\)/);
  const fatalBody = extractFunctionBody(serverSource, "fatalServerError");
  assert.match(fatalBody, /stopLifecycleTimers\(\)/);
  assert.match(fatalBody, /shutdownStarted = true/);
  assert.match(fatalBody, /for \(const client of wss\.clients\) closeWebSocketForShutdown\(client\)/);
  assert.match(fatalBody, /const forceExit = scheduleForcedProcessExit\(1\)/);
  assert.match(fatalBody, /server\.close\(\(closeError\) => finishProcessAfterServerClose\(1, forceExit, closeError\)\)/);
  assert.doesNotMatch(fatalBody, /server\.close\(\(\) => process\.exit/);
  const forcedExitBody = extractFunctionBody(serverSource, "scheduleForcedProcessExit");
  const finishBody = extractFunctionBody(serverSource, "finishProcessAfterServerClose");
  const distForcedExitBody = extractFunctionBody(distServerSource, "scheduleForcedProcessExit");
  const distFinishBody = extractFunctionBody(distServerSource, "finishProcessAfterServerClose");
  for (const body of [forcedExitBody, distForcedExitBody]) {
    assert.match(body, /process\.exitCode = code/);
    assert.match(body, /for \(const client of wss\.clients\)[\s\S]*client\.terminate\(\)/);
    assert.match(body, /process\.exit\(code\)/);
    assert.match(body, /SHUTDOWN_GRACE_MS/);
    assert.doesNotMatch(body, /\.unref\(\)/);
  }
  for (const body of [finishBody, distFinishBody]) {
    assert.match(body, /clearTimeout\(forceExit\)/);
    assert.match(body, /process\.exitCode = code/);
    assert.match(body, /ownErrorData\(error, "code"\) !== "ERR_SERVER_NOT_RUNNING"/);
    assert.doesNotMatch(body, /process\.exit\(/);
  }
  const errorSummaryBody = extractFunctionBody(serverSource, "operationalErrorSummary");
  const distErrorSummaryBody = extractFunctionBody(distServerSource, "operationalErrorSummary");
  for (const body of [errorSummaryBody, distErrorSummaryBody]) {
    assert.match(body, /ownErrorData\(error, "code"\)/);
    assert.match(body, /ownErrorData\(error, "syscall"\)/);
    assert.doesNotMatch(body, /ownErrorData\(error, "address"\)/);
    assert.doesNotMatch(body, /ownErrorData\(error, "port"\)/);
    assert.match(body, /ownErrorData\(error, "name"\)/);
    assert.doesNotMatch(body, /error\.name/);
    assert.doesNotMatch(body, /nodeError\./);
  }
  assert.match(serverSource, /function ownErrorData/);
  assert.match(distServerSource, /function ownErrorData/);
  assert.match(serverSource, /Object\.getOwnPropertyDescriptor\(error, key\)/);
  assert.match(distServerSource, /Object\.getOwnPropertyDescriptor\(error, key\)/);
});

test("server-initiated websocket closes are bounded by forced termination", () => {
  assert.equal(SIGNALING_CLOSE_GRACE_MS, 5_000);
  assert.match(securityPolicy, /every server-initiated signaling WebSocket close handshake must go through the bounded close helper with a short termination grace period and must release active-connection accounting immediately without cancelling forced termination/);
  assert.match(serverSource, /closeTimer\?: ReturnType<typeof setTimeout>/);
  assert.match(serverSource, /type ReleaseActiveConnectionOptions = \{[\s\S]*keepCloseTimer\?: boolean;[\s\S]*\}/);
  assert.match(serverSource, /function releaseActiveConnection\(peer: Peer, options\?: ReleaseActiveConnectionOptions\)/);
  const releaseBody = extractFunctionBody(serverSource, "releaseActiveConnection");
  assert.match(releaseBody, /if \(!options\?\.keepCloseTimer\) clearCloseTimer\(peer\)/);
  const closeAndReleaseBody = extractFunctionBody(serverSource, "closePeerAndRelease");
  assert.match(closeAndReleaseBody, /closePeer\(peer, reason\)/);
  assert.match(closeAndReleaseBody, /releaseActiveConnection\(peer, \{ keepCloseTimer: true \}\)/);
  const closeWithCodeAndReleaseBody = extractFunctionBody(serverSource, "closePeerWithCodeAndRelease");
  assert.match(closeWithCodeAndReleaseBody, /closePeerWithCode\(peer, code, reason\)/);
  assert.match(closeWithCodeAndReleaseBody, /releaseActiveConnection\(peer, \{ keepCloseTimer: true \}\)/);
  const closeBody = extractFunctionBody(serverSource, "closePeer");
  assert.match(closeBody, /closePeerWithCode\(peer, 1000, reason\)/);
  const closeWithCodeBody = extractFunctionBody(serverSource, "closePeerWithCode");
  assert.match(closeWithCodeBody, /peer\.ws\.readyState === peer\.ws\.CLOSING/);
  assert.match(closeWithCodeBody, /peer\.ws\.close\(code, websocketCloseReason\(wireCloseReason\(code, reason\)\)\)/);
  const wireReasonBody = extractFunctionBody(serverSource, "wireCloseReason");
  assert.match(wireReasonBody, /return "policy violation"/);
  assert.match(wireReasonBody, /return "closed"/);
  assert.doesNotMatch(wireReasonBody, /return _?reason/);
  assert.match(closeWithCodeBody, /scheduleCloseTermination\(peer\)/);
  const shutdownCloseBody = extractFunctionBody(serverSource, "closeWebSocketForShutdown");
  assert.match(shutdownCloseBody, /const peer = peersBySocket\.get\(client\)/);
  assert.match(shutdownCloseBody, /closePeerWithCode\(peer, 1001, "server shutdown"\)/);
  assert.match(shutdownCloseBody, /scheduleStandaloneCloseTermination\(client\)/);
  const standaloneScheduleBody = extractFunctionBody(serverSource, "scheduleStandaloneCloseTermination");
  assert.match(standaloneScheduleBody, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(standaloneScheduleBody, /if \(client\.readyState !== client\.CLOSED\) client\.terminate\(\)/);
  assert.match(standaloneScheduleBody, /timer\.unref\(\)/);
  const directServerInitiatedCloseCalls = [...serverSource.matchAll(/(?:peer\.ws|entry\.receiver\.ws|ws)\.close\(/g)].map((match) => match[0]);
  assert.deepEqual(directServerInitiatedCloseCalls, ["peer.ws.close("]);
  assert.match(serverSource, /closePeerWithCodeAndRelease\(peer, 1008, "connection limit"\)/);
  assert.match(serverSource, /closePeerWithCodeAndRelease\(peer, 1008, "idle signaling connection"\)/);
  assert.match(serverSource, /closePeerAndRelease\(entry\.receiver, "expired"\)/);
  assert.match(serverSource, /closePeerWithCodeAndRelease\(peer, 1008, "too many malformed messages"\)/);
  assert.match(serverSource, /closePeerWithCodeAndRelease\(peer, 1008, "signaling message rate limit"\)/);
  const scheduleBody = extractFunctionBody(serverSource, "scheduleCloseTermination");
  assert.match(scheduleBody, /if \(peer\.closeTimer\) return/);
  assert.match(scheduleBody, /setTimeout\(\(\) => \{[\s\S]*if \(peer\.ws\.readyState !== peer\.ws\.CLOSED\) peer\.ws\.terminate\(\)/);
  assert.match(scheduleBody, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(scheduleBody, /peer\.closeTimer\.unref\(\)/);

  const distReleaseBody = extractFunctionBody(distServerSource, "releaseActiveConnection");
  assert.match(distReleaseBody, /keepCloseTimer/);
  assert.match(distReleaseBody, /clearCloseTimer\(peer\)/);
  const distCloseAndReleaseBody = extractFunctionBody(distServerSource, "closePeerAndRelease");
  assert.match(distCloseAndReleaseBody, /closePeer\(peer, reason\)/);
  assert.match(distCloseAndReleaseBody, /releaseActiveConnection\(peer, \{ keepCloseTimer: true \}\)/);
  const distCloseWithCodeAndReleaseBody = extractFunctionBody(distServerSource, "closePeerWithCodeAndRelease");
  assert.match(distCloseWithCodeAndReleaseBody, /closePeerWithCode\(peer, code, reason\)/);
  assert.match(distCloseWithCodeAndReleaseBody, /releaseActiveConnection\(peer, \{ keepCloseTimer: true \}\)/);
  const distCloseWithCodeBody = extractFunctionBody(distServerSource, "closePeerWithCode");
  assert.match(distCloseWithCodeBody, /peer\.ws\.readyState === peer\.ws\.CLOSING/);
  assert.match(distCloseWithCodeBody, /peer\.ws\.close\(code, websocketCloseReason\(wireCloseReason\(code, reason\)\)\)/);
  assert.match(distCloseWithCodeBody, /scheduleCloseTermination\(peer\)/);
  const distStandaloneScheduleBody = extractFunctionBody(distServerSource, "scheduleStandaloneCloseTermination");
  assert.match(distStandaloneScheduleBody, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(distStandaloneScheduleBody, /if \(client\.readyState !== client\.CLOSED\)[\s\S]*client\.terminate\(\)/);
  const distScheduleBody = extractFunctionBody(distServerSource, "scheduleCloseTermination");
  assert.match(distScheduleBody, /if \(peer\.closeTimer\)[\s\S]*return/);
  assert.match(distScheduleBody, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(distScheduleBody, /peer\.closeTimer\.unref\(\)/);
});

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
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
  throw new Error(`Could not extract ${name} body.`);
}
