import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { SignalingClient, SignalingError, SignalingWaitTimeoutError, waitForMessage } from "../src/cli/signaling.js";
import { SignalingWaitTimeoutError as DistSignalingWaitTimeoutError, waitForMessage as distWaitForMessage } from "../dist-node/cli/signaling.js";
import { establishKeys } from "../src/cli/secure.js";
import { SIGNALING_CLOSE_GRACE_MS, SIGNALING_MAX_BUFFERED_BYTES } from "../src/shared/constants.js";
import type { ClientMessage, ServerMessage } from "../src/shared/messages.js";
import { finishPake, ownPakeShareB64, parsePakeShareMessage, sessionConfirmTag, startPake } from "../src/shared/security.js";

const cliSecureSource = fs.readFileSync(new URL("../src/cli/secure.ts", import.meta.url), "utf8");
const cliIndexSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const cliSignalingSource = fs.readFileSync(new URL("../src/cli/signaling.ts", import.meta.url), "utf8");
const distCliSignalingSource = fs.readFileSync(new URL("../dist-node/cli/signaling.js", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("waitForMessage resolves the requested validated server message", async () => {
  const client = new EventEmitter();
  const wait = waitForMessage(client as never, "registered", 50);
  client.emit("message", { type: "registered", code: "12345678", expiresInSec: 600 } satisfies ServerMessage);
  assert.deepEqual(await wait, { type: "registered", code: "12345678", expiresInSec: 600 });
});

test("waitForMessage ignores wrong-session frames when a sid is required", async () => {
  const client = new EventEmitter();
  const wait = waitForMessage(client as never, "pake", 50, "sid-good");
  client.emit("message", { type: "peer-left", sid: "sid-other", reason: "noise" } satisfies ServerMessage);
  client.emit("message", { type: "pake", sid: "sid-other", data: "wrong" } satisfies ServerMessage);
  client.emit("message", { type: "pake", sid: "sid-good", data: "right" } satisfies ServerMessage);
  assert.deepEqual(await wait, { type: "pake", sid: "sid-good", data: "right" });
});

test("waitForMessage ignores stale peer-left frames while waiting for restored registration", async () => {
  const client = new EventEmitter();
  const wait = waitForMessage(client as never, "registered", 50);
  client.emit("message", { type: "peer-left", sid: "old-sid", reason: "invalid sender pre-pair message" } satisfies ServerMessage);
  client.emit("message", { type: "registered", code: "12345678", expiresInSec: 599 } satisfies ServerMessage);
  assert.deepEqual(await wait, { type: "registered", code: "12345678", expiresInSec: 599 });
});

test("waitForMessage rejects same-session peer-left when a sid is required", async () => {
  const client = new EventEmitter();
  const wait = waitForMessage(client as never, "pake", 50, "sid-good");
  client.emit("message", { type: "peer-left", sid: "sid-good", reason: "attacker supplied text" } satisfies ServerMessage);
  await assert.rejects(wait, (error) => error instanceof Error && error.message === "Peer disconnected.");
});

test("waitForMessage rejects on signaling close, socket error, and protocol error", async () => {
  const closed = new EventEmitter();
  const closeWait = waitForMessage(closed as never, "registered", 50);
  closed.emit("close");
  await assert.rejects(closeWait, /closed/);

  const errored = new EventEmitter();
  const errorWait = waitForMessage(errored as never, "registered", 50);
  errored.emit("socket-error", new Error("socket exploded"));
  await assert.rejects(errorWait, /socket exploded/);

  const malformed = new EventEmitter();
  const malformedWait = waitForMessage(malformed as never, "registered", 50);
  malformed.emit("protocol-error", new Error("Malformed signaling server message."));
  await assert.rejects(malformedWait, /Malformed signaling/);
});

test("waitForMessage exposes typed timeout errors for classification without message access", async () => {
  const client = new EventEmitter();
  await assert.rejects(
    waitForMessage(client as never, "ice-config", 1),
    (error) => error instanceof SignalingWaitTimeoutError && error.type === "ice-config" && error.message === "Timed out waiting for ice-config"
  );

  const distClient = new EventEmitter();
  await assert.rejects(
    distWaitForMessage(distClient as never, "ice-config", 1),
    (error) => error instanceof DistSignalingWaitTimeoutError && error.type === "ice-config" && error.message === "Timed out waiting for ice-config"
  );
});

test("waitForMessage preserves signaling error codes for retry decisions", async () => {
  const client = new EventEmitter();
  const wait = waitForMessage(client as never, "registered", 50);
  client.emit("message", { type: "error", code: "code_taken", message: "attacker supplied server text" } satisfies ServerMessage);
  await assert.rejects(
    wait,
    (error) => error instanceof SignalingError && error.code === "code_taken" && error.message === "That receive code is already waiting for a sender."
  );
});

test("waitForMessage cancellation removes every signaling listener", async () => {
  const client = new EventEmitter();
  const abort = new AbortController();
  const wait = waitForMessage(client as never, "pake", 50_000, "sid", abort.signal);

  assert.equal(client.listenerCount("message"), 1);
  assert.equal(client.listenerCount("close"), 1);
  assert.equal(client.listenerCount("socket-error"), 1);
  assert.equal(client.listenerCount("protocol-error"), 1);

  abort.abort();
  await assert.rejects(wait, /Cancelled waiting for pake/);
  assert.equal(client.listenerCount("message"), 0);
  assert.equal(client.listenerCount("close"), 0);
  assert.equal(client.listenerCount("socket-error"), 0);
  assert.equal(client.listenerCount("protocol-error"), 0);
});

test("waitForMessage rejects malformed runtime wait parameters before timers", async () => {
  assert.match(securityPolicy, /exported CLI signaling wait helpers must reject invalid message types, malformed timeout values, malformed session ids, malformed abort signals, and malformed emitted message records/);
  let coerced = false;
  const typeLike = {
    toString() {
      coerced = true;
      return "registered";
    }
  };
  const timeoutLike = {
    valueOf() {
      coerced = true;
      return 50;
    }
  };
  const signalLike = {
    get aborted() {
      coerced = true;
      return false;
    },
    addEventListener() {
      coerced = true;
    },
    removeEventListener() {
      coerced = true;
    }
  };

  for (const wait of [waitForMessage, distWaitForMessage]) {
    const badTypeClient = new EventEmitter();
    await assert.rejects(() => wait(badTypeClient as never, typeLike as never, 50), /message type/);
    assert.equal(badTypeClient.listenerCount("message"), 0);

    const badTimeoutClient = new EventEmitter();
    await assert.rejects(() => wait(badTimeoutClient as never, "registered", timeoutLike as never), /timeout/);
    assert.equal(badTimeoutClient.listenerCount("message"), 0);

    await assert.rejects(() => wait(new EventEmitter() as never, "registered", 0), /timeout/);
    await assert.rejects(() => wait(new EventEmitter() as never, "registered", 300_001), /timeout/);

    const badSidClient = new EventEmitter();
    await assert.rejects(() => wait(badSidClient as never, "pake", 50, "../bad"), /session id/);
    assert.equal(badSidClient.listenerCount("message"), 0);

    const badSignalClient = new EventEmitter();
    await assert.rejects(() => wait(badSignalClient as never, "registered", 50, undefined, signalLike as never), /abort signal/);
    assert.equal(badSignalClient.listenerCount("message"), 0);
  }

  assert.equal(coerced, false);
  for (const source of [cliSignalingSource, distCliSignalingSource]) {
    assert.match(source, /WAIT_SESSION_ID/);
    assert.match(source, /WAIT_MESSAGE_TYPES/);
    assert.match(source, /function waitMessageType/);
    assert.match(source, /function waitTimeout/);
    assert.match(source, /function waitSessionId/);
    assert.match(source, /function waitAbortSignal/);
    assert.match(source, /typeof timeoutMs !== "number"/);
    assert.match(source, /timeoutMs > PAIR_TIMEOUT_MS/);
  }
});

test("waitForMessage ignores malformed emitted messages without invoking getters", async () => {
  assert.match(securityPolicy, /malformed emitted message records before timers, field reads, or error interpolation/);
  for (const wait of [waitForMessage, distWaitForMessage]) {
    const client = new EventEmitter();
    const pending = wait(client as never, "registered", 50);
    let getterReads = 0;
    const hostileMessage: Record<string, unknown> = {};
    for (const key of ["sid", "type", "code", "message"]) {
      Object.defineProperty(hostileMessage, key, {
        enumerable: true,
        get() {
          getterReads += 1;
          return key === "type" ? "error" : "code_taken";
        }
      });
    }

    client.emit("message", hostileMessage);
    client.emit("message", { type: "registered", code: "12345678", expiresInSec: 600 } satisfies ServerMessage);
    assert.deepEqual(await pending, { type: "registered", code: "12345678", expiresInSec: 600 });
    assert.equal(getterReads, 0);
  }

  for (const source of [cliSignalingSource, distCliSignalingSource]) {
    assert.match(source, /if \(!isServerMessage\(message\)\)/);
    assert.match(source, /const onMessage = \(message/);
  }
});

test("browser signaling waits revalidate emitted messages before field reads", () => {
  assert.match(securityPolicy, /browser signaling wait helpers must reject invalid message types, malformed timeout values, malformed session ids, and malformed abort signals before timers\/listeners/);
  assert.match(webSource, /const BROWSER_WAIT_MESSAGE_TYPES = new Set<ServerMessage\["type"\]>/);
  assert.match(webSource, /const BROWSER_WAIT_SESSION_ID = \/\^\[A-Za-z0-9_-\]\{1,128\}\$\//);
  assert.match(webSource, /const waitType = browserWaitMessageType\(type\);/);
  assert.match(webSource, /const waitTimeoutMs = browserWaitTimeout\(timeoutMs\);/);
  assert.match(webSource, /const waitSid = browserWaitSid\(sid\);/);
  assert.match(webSource, /const waitSignal = browserWaitAbortSignal\(signal\);/);
  assert.match(webSource, /const timer = setTimeout\(\(\) => \{[\s\S]*Timed out waiting for \$\{waitType\}[\s\S]*\}, waitTimeoutMs\);/);
  assert.match(webSource, /signaling\.on\(waitType, onType\);/);
  assert.match(webSource, /function browserWaitMessageType\(type: unknown\): ServerMessage\["type"\]/);
  assert.match(webSource, /function browserWaitTimeout\(timeoutMs: unknown\): number/);
  assert.match(webSource, /function browserWaitSid\(sid: unknown\): string \| undefined/);
  assert.match(webSource, /function browserWaitAbortSignal\(signal: unknown\): AbortSignal \| undefined/);
  assert.match(webSource, /const onIceConfig = \(message: BrowserSignalingEvent\) => \{\n      if \(!isServerMessage\(message\)\) return;/);
  assert.match(webSource, /const onType = \(message: BrowserSignalingEvent\) => \{\n      if \(!isServerMessage\(message\)\) return;/);
  assert.match(webSource, /const onPeerLeft = \(message: BrowserSignalingEvent\) => \{\n      if \(!isServerMessage\(message\)\) return;/);
  assert.match(webSource, /const onPairReject = \(message: BrowserSignalingEvent\) => \{\n      if \(!isServerMessage\(message\)\) return;/);
  assert.match(distWebBundle, /new Set\(\[`registered`,`peer-joined`,`pake`,`confirm`,`pair-request`,`pair-accept`,`pair-reject`,`signal`,`peer-left`,`ice-config`,`error`\]\)/);
  assert.match(distWebBundle, /Browser signaling wait message type is invalid/);
  assert.match(distWebBundle, /Browser signaling wait timeout is invalid/);
  assert.match(distWebBundle, /Browser signaling wait session id is invalid/);
  assert.match(distWebBundle, /Browser signaling wait abort signal is invalid/);
  assert.match(distWebBundle, /type===`ice-config`/);
  assert.match(distWebBundle, /type===\w+/);
  assert.match(distWebBundle, /Peer disconnected/);
});

test("CLI pair decision and ICE listeners revalidate emitted messages before field reads", () => {
  assert.match(securityPolicy, /client event listeners for ICE config, pair decisions, and WebRTC signaling must revalidate emitted signaling records before any field reads/);
  assert.match(cliIndexSource, /import \{ isServerMessage, type FileManifest/);
  assert.match(cliIndexSource, /signaling\.on\("ice-config", \(message: unknown\) => \{[\s\S]*if \(!isServerMessage\(message\)\) return;[\s\S]*if \(message\.type === "ice-config"\) iceServers = cloneIceServers\(message\.iceServers\);[\s\S]*\}\);/);
  assert.match(cliIndexSource, /const onMessage = \(message: unknown\) => \{\n      if \(!isServerMessage\(message\)\) return;/);
  assert.match(distCliIndexSource(), /import \{ isServerMessage \} from "\.\.\/shared\/messages\.js";/);
  assert.match(distCliIndexSource(), /signaling\.on\("ice-config", \(message\) => \{[\s\S]*if \(!isServerMessage\(message\)\)[\s\S]*return;[\s\S]*if \(message\.type === "ice-config"\)[\s\S]*iceServers = cloneIceServers\(message\.iceServers\);[\s\S]*\}\);/);
  assert.match(distCliIndexSource(), /const onMessage = \(message\) => \{\n\s+if \(!isServerMessage\(message\)\)\n\s+return;/);
});

test("signaling clients reject early socket close during connection setup", () => {
  assert.match(cliSignalingSource, /const onClose = \(\) => fail\(new Error\("Signaling socket closed before connection opened\."\)\)/);
  assert.match(cliSignalingSource, /ws\.once\("close", onClose\)/);
  assert.match(cliSignalingSource, /ws\?\.off\("close", onClose\)/);
  assert.match(webSource, /this\.ws\.onclose = \(\) => \{[\s\S]*fail\(new Error\("Signaling socket closed before connection opened\."\)\);[\s\S]*\};/);
});

test("browser signaling detaches connection setup handlers after success or failure", () => {
  assert.match(webSource, /const cleanupConnect = \(\) => \{[\s\S]*clearTimeout\(timer\);[\s\S]*this\.ws\.onopen = null;[\s\S]*\};/);
  assert.match(webSource, /const detachFailedConnect = \(\) => \{[\s\S]*cleanupConnect\(\);[\s\S]*this\.ws\.onerror = null;[\s\S]*this\.ws\.onclose = null;[\s\S]*this\.ws\.onmessage = null;[\s\S]*\};/);
  assert.match(webSource, /const succeed = \(\) => \{[\s\S]*cleanupConnect\(\);[\s\S]*this\.ws\.onerror = \(\) => \{[\s\S]*Signaling socket error\.[\s\S]*\};[\s\S]*this\.ws\.onclose = \(\) => \{[\s\S]*signaling_closed[\s\S]*\};[\s\S]*resolve\(\);[\s\S]*\};/);
  assert.match(webSource, /const fail = \(error: Error\) => \{[\s\S]*detachFailedConnect\(\);[\s\S]*this\.closeSocketAfterFailedOpen\(\);[\s\S]*reject\(error\);[\s\S]*\};/);
});

test("CLI signaling installs runtime handlers only after connection setup succeeds", () => {
  assert.match(cliSignalingSource, /const detachFailedConnect = \(\) => \{[\s\S]*cleanupConnect\(\);[\s\S]*ws\?\.off\("message", onMessage\);[\s\S]*ws\?\.off\("close", onRuntimeClose\);[\s\S]*ws\?\.off\("error", onRuntimeError\);[\s\S]*\};/);
  assert.match(cliSignalingSource, /const succeed = \(\) => \{[\s\S]*cleanupConnect\(\);[\s\S]*ws\?\.on\("message", onMessage\);[\s\S]*ws\?\.on\("close", onRuntimeClose\);[\s\S]*ws\?\.on\("error", onRuntimeError\);[\s\S]*resolve\(\);[\s\S]*\};/);
  assert.match(cliSignalingSource, /const fail = \(error: Error\) => \{[\s\S]*detachFailedConnect\(\);[\s\S]*this\.closeSocketAfterFailedConnect\(ws\);[\s\S]*reject\(error\);[\s\S]*\};/);
  assert.equal(cliSignalingSource.indexOf('ws?.on("message", onMessage)'), cliSignalingSource.lastIndexOf('ws?.on("message", onMessage)'));
  assert.equal(cliSignalingSource.indexOf('ws?.on("close", onRuntimeClose)'), cliSignalingSource.lastIndexOf('ws?.on("close", onRuntimeClose)'));
  assert.equal(cliSignalingSource.indexOf('ws?.on("error", onRuntimeError)'), cliSignalingSource.lastIndexOf('ws?.on("error", onRuntimeError)'));
});

test("CLI signaling clients reject connect reuse while a socket is active", async () => {
  assert.match(securityPolicy, /CLI signaling clients must reject `connect\(\)` reuse while a socket is active or closing/);
  const connectBody = extractFunctionBody(cliSignalingSource, "connect");
  assert.match(connectBody, /if \(this\.disposed\) return Promise\.reject\(new Error\("signaling client is closed"\)\)/);
  assert.match(connectBody, /if \(this\.ws && this\.ws\.readyState !== WebSocket\.CLOSED\)/);
  assert.match(connectBody, /signaling client already has an active socket/);
  assert.match(distCliSignalingSource, /connect\(\) \{[\s\S]*if \(this\.disposed\)[\s\S]*signaling client is closed[\s\S]*this\.ws && this\.ws\.readyState !== WebSocket\.CLOSED[\s\S]*signaling client already has an active socket/);

  const client = new SignalingClient("ws://127.0.0.1:8787/v1/ws");
  Object.assign(client as unknown as { ws: unknown }, { ws: { readyState: 1 } });
  await assert.rejects(() => client.connect(), /already has an active socket/);

  Object.assign(client as unknown as { ws: unknown }, { ws: { readyState: 2 } });
  await assert.rejects(() => client.connect(), /already has an active socket/);

  Object.assign(client as unknown as { disposed: boolean; ws: unknown }, { disposed: true, ws: { readyState: 3 } });
  await assert.rejects(() => client.connect(), /signaling client is closed/);
});

test("CLI signaling failed connects self-close because callers cannot clean them up", () => {
  const connectBody = extractFunctionBody(cliSignalingSource, "connect");
  const failedConnectCleanupBody = extractFunctionBody(cliSignalingSource, "closeSocketAfterFailedConnect");

  assert.match(securityPolicy, /CLI signaling connection failures before `connect\(\)` resolves must close, dispose, keep a temporary no-op error sink for late WebSocket errors, and force-terminate their own WebSocket/);
  assert.match(connectBody, /const fail = \(error: Error\) => \{[\s\S]*detachFailedConnect\(\);[\s\S]*this\.closeSocketAfterFailedConnect\(ws\);[\s\S]*reject\(error\);[\s\S]*\};/);
  assert.match(failedConnectCleanupBody, /ws\.readyState === WebSocket\.CLOSED/);
  assert.match(failedConnectCleanupBody, /this\.armLateSocketErrorSink\(ws\)[\s\S]*ws\.close\(\)/);
  assert.match(failedConnectCleanupBody, /ws\.close\(\)/);
  assert.match(failedConnectCleanupBody, /setTimeout\(\(\) => \{[\s\S]*if \(ws\.readyState !== WebSocket\.CLOSED\) ws\.terminate\(\)/);
  assert.match(failedConnectCleanupBody, /unrefTimer\(timer\)/);
  assert.match(failedConnectCleanupBody, /this\.dispose\(\);[\s\S]*this\.armLateSocketErrorSink\(ws\)/);
  assert.match(cliSignalingSource, /const ignoreLateSocketError = \(\) => \{\};/);
  assert.match(cliSignalingSource, /private armLateSocketErrorSink\(ws: WebSocket\): void \{[\s\S]*ws\.on\("error", ignoreLateSocketError\);[\s\S]*ws\.once\("close", \(\) => \{[\s\S]*ws\.off\("error", ignoreLateSocketError\);/);
  assert.match(distCliSignalingSource, /const ignoreLateSocketError = \(\) => \{ \};/);
  assert.match(distCliSignalingSource, /this\.armLateSocketErrorSink\(ws\);[\s\S]*ws\.close\(\);[\s\S]*this\.dispose\(\);[\s\S]*this\.armLateSocketErrorSink\(ws\);/);
  assert.match(distCliSignalingSource, /armLateSocketErrorSink\(ws\) \{[\s\S]*ws\.on\("error", ignoreLateSocketError\);[\s\S]*ws\.once\("close", \(\) => \{[\s\S]*ws\.off\("error", ignoreLateSocketError\);/);
});

test("CLI signaling failed-open sockets absorb late error events until close", () => {
  const client = new SignalingClient("ws://127.0.0.1:8787/v1/ws");
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    close: () => void;
    terminate: () => void;
  };
  let closed = false;
  let terminated = false;
  ws.readyState = 1;
  ws.close = () => {
    closed = true;
    ws.readyState = 2;
  };
  ws.terminate = () => {
    terminated = true;
    ws.readyState = 3;
  };
  Object.assign(client as unknown as { ws: unknown }, { ws });

  (client as unknown as { closeSocketAfterFailedConnect: (socket: unknown) => void }).closeSocketAfterFailedConnect(ws);

  assert.equal(closed, true);
  assert.equal(terminated, false);
  assert.equal(ws.listenerCount("error"), 1);
  assert.doesNotThrow(() => ws.emit("error", new Error("late socket failure")));
  ws.readyState = 3;
  ws.emit("close");
  assert.equal(ws.listenerCount("error"), 0);
});

test("CLI signaling close handshakes are bounded by forced termination", () => {
  assert.equal(SIGNALING_CLOSE_GRACE_MS, 5_000);
  assert.match(securityPolicy, /CLI signaling WebSocket close handshakes must also use an unrefed termination grace period/);
  assert.match(cliSignalingSource, /private closeTimer\?: ReturnType<typeof setTimeout>/);
  assert.match(cliSignalingSource, /const timer = setTimeout\(\(\) => \{[\s\S]*this\.close\(\);[\s\S]*fail\(new Error\("Timed out connecting to signaling server\."\)\);[\s\S]*\}, CONNECT_TIMEOUT_MS\);/);
  assert.match(cliSignalingSource, /ws\.on\("close", \(\) => \{[\s\S]*if \(this\.ws === ws\) this\.clearCloseTimer\(\);[\s\S]*\}\);/);
  assert.match(cliSignalingSource, /const onRuntimeClose = \(\) => \{[\s\S]*this\.clearCloseTimer\(\);[\s\S]*this\.emit\("close"\);[\s\S]*\};/);
  const closeBody = extractFunctionBody(cliSignalingSource, "close");
  assert.match(closeBody, /ws\.close\(\)/);
  assert.match(closeBody, /this\.scheduleCloseTermination\(ws\)/);
  const scheduleBody = extractFunctionBody(cliSignalingSource, "scheduleCloseTermination");
  assert.match(scheduleBody, /setTimeout\(\(\) => \{[\s\S]*if \(this\.ws === ws && ws\.readyState !== WebSocket\.CLOSED\) ws\.terminate\(\)/);
  assert.match(scheduleBody, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(scheduleBody, /unrefTimer\(this\.closeTimer\)/);
});

test("CLI signaling close disposes handlers and buffered peer data", () => {
  assert.match(securityPolicy, /CLI signaling sockets must clear runtime handlers, listener sets, cached ICE config, and buffered early WebRTC signals after close/);
  assert.match(cliSignalingSource, /private disposed = false;/);
  assert.match(cliSignalingSource, /const onRuntimeClose = \(\) => \{[\s\S]*this\.clearCloseTimer\(\);[\s\S]*this\.emit\("close"\);[\s\S]*this\.dispose\(\);[\s\S]*\};/);
  assert.match(cliSignalingSource, /if \(this\.disposed\) throw new Error\("signaling socket is closed"\);/);
  assert.match(cliSignalingSource, /if \(this\.disposed\) return \[\];[\s\S]*return this\.earlySignals\.drain\(\);/);
  const closeBody = extractFunctionBody(cliSignalingSource, "close");
  assert.match(closeBody, /if \(this\.disposed\) return/);
  assert.match(closeBody, /this\.dispose\(\)/);
  const disposeBody = extractFunctionBody(cliSignalingSource, "dispose");
  assert.match(disposeBody, /this\.disposed = true/);
  assert.match(disposeBody, /this\.clearCloseTimer\(\)/);
  assert.match(disposeBody, /delete this\.latestIceServers/);
  assert.match(disposeBody, /this\.earlySignals\.drain\(\)/);
  assert.match(disposeBody, /this\.removeAllListeners\(\)/);
  assert.match(disposeBody, /this\.ws\?\.removeAllListeners\("message"\)/);
  assert.match(disposeBody, /this\.ws\?\.removeAllListeners\("error"\)/);
  assert.match(disposeBody, /this\.ws\?\.removeAllListeners\("close"\)/);
});

test("signaling clients expose defensive ICE server snapshots", () => {
  assert.match(securityPolicy, /signaling clients must store and return defensive ICE server snapshots/);
  assert.match(cliSignalingSource, /import \{ cloneIceServers \} from "\.\.\/shared\/ice\.js";/);
  assert.match(cliSignalingSource, /if \(parsed\.type === "ice-config"\) this\.latestIceServers = cloneIceServers\(parsed\.iceServers\)/);
  assert.match(cliSignalingSource, /currentIceServers\(\): RTCIceServer\[\] \| undefined \{[\s\S]*if \(this\.disposed\) return undefined;[\s\S]*return this\.latestIceServers \? cloneIceServers\(this\.latestIceServers\) : undefined;/);
  assert.match(webSource, /import \{ cloneIceServers \} from "\.\.\/shared\/ice\.js";/);
  assert.match(webSource, /if \(parsed\.type === "ice-config"\) this\.latestIceServers = cloneIceServers\(parsed\.iceServers\)/);
  assert.match(webSource, /currentIceServers\(\): RTCIceServer\[\] \| undefined \{[\s\S]*if \(this\.disposed\) return undefined;[\s\S]*return this\.latestIceServers \? cloneIceServers\(this\.latestIceServers\) : undefined;/);
});

test("client connection setup clones ICE server lists before WebRTC use", () => {
  assert.match(securityPolicy, /CLI and browser connection setup must clone default and received ICE server lists before handing them to WebRTC/);
  assert.match(securityPolicy, /CLI and browser clients must expose an explicit way to ignore signaling-provided ICE server hints/);
  assert.match(cliIndexSource, /import \{ cloneIceServers \} from "\.\.\/shared\/ice\.js";/);
  assert.match(cliIndexSource, /\.option\("--no-server-ice", "ignore signaling-provided ICE servers and use built-in public STUN only"\)/);
  assert.match(cliIndexSource, /function shouldUseServerIce\(options: CommonOptions\): boolean \{[\s\S]*return options\.serverIce !== false;[\s\S]*\}/);
  assert.match(cliIndexSource, /let iceServers = cloneIceServers\(DEFAULT_ICE_SERVERS\);/);
  assert.match(cliIndexSource, /const useServerIce = shouldUseServerIce\(options\);[\s\S]*if \(useServerIce\) \{[\s\S]*if \(message\.type === "ice-config"\) iceServers = cloneIceServers\(message\.iceServers\);/);
  assert.match(cliIndexSource, /getIceServersAfterAccept\(signaling, iceServers, useServerIce\)/);
  assert.match(cliIndexSource, /if \(!useServerIce\) return cloneIceServers\(fallback\);/);
  assert.match(cliIndexSource, /return cloneIceServers\(\(await waitForMessage\(signaling, "ice-config", ICE_CONFIG_GRACE_MS\)\)\.iceServers\);/);
  assert.match(cliIndexSource, /return cloneIceServers\(fallback\);/);
  assert.match(webSource, /<input id="serverIce" type="checkbox" checked \/>/);
  assert.match(webSource, /const serverIce = byId<HTMLInputElement>\("serverIce"\);/);
  assert.match(webSource, /function shouldUseBrowserServerIce\(\): boolean \{[\s\S]*return serverIce\.checked;[\s\S]*\}/);
  assert.match(webSource, /await getIceServers\(signaling, shouldUseBrowserServerIce\(\)\)/);
  assert.match(webSource, /if \(!useServerIce\) return cloneIceServers\(DEFAULT_ICE_SERVERS\);/);
  assert.match(webSource, /serverIce\.disabled = busy;/);
  assert.match(webSource, /resolve\(cloneIceServers\(message\.iceServers\)\);/);
  assert.match(webSource, /resolve\(cloneIceServers\(DEFAULT_ICE_SERVERS\)\);/);
});

test("generic restored-registration waits do not treat stale peer-left as fatal", () => {
  assert.match(cliSignalingSource, /message\.type === "peer-left" && waitSid !== undefined/);
  assert.match(webSource, /if \(waitSid === undefined \|\| !\("sid" in message\) \|\| message\.sid !== waitSid\) return;/);
});

test("SignalingClient fails closed when outbound buffering is already excessive", () => {
  const client = new SignalingClient("ws://127.0.0.1:8787/v1/ws");
  let closed = false;
  let sent = false;
  Object.assign(client as unknown as { ws: unknown }, {
    ws: {
      readyState: 1,
      bufferedAmount: SIGNALING_MAX_BUFFERED_BYTES + 1,
      send() {
        sent = true;
      },
      close() {
        closed = true;
      },
      terminate() {
        closed = true;
      }
    }
  });

  assert.throws(() => client.send({ type: "bye", reason: "cancelled" }), /backpressure/);
  assert.equal(sent, false);
  assert.equal(closed, true);
});

test("SignalingClient closes when a send pushes outbound buffering over the cap", () => {
  const client = new SignalingClient("ws://127.0.0.1:8787/v1/ws");
  let closed = false;
  let sent = false;
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send() {
      sent = true;
      ws.bufferedAmount = SIGNALING_MAX_BUFFERED_BYTES + 1;
    },
    close() {
      closed = true;
    },
    terminate() {
      closed = true;
    }
  };
  Object.assign(client as unknown as { ws: unknown }, { ws });

  assert.throws(() => client.send({ type: "bye", reason: "cancelled" }), /backpressure/);
  assert.equal(sent, true);
  assert.equal(closed, true);
});

test("establishKeys does not drop an early peer confirmation frame", async () => {
  const sid = "early-confirm";
  const code = "123456-apple-anchor";
  const sender = startPake("sender", code, sid);
  const senderShare = ownPakeShareB64(sender);
  let senderSas = "";
  const signaling = new (class extends EventEmitter {
    send(message: ClientMessage): void {
      if (message.type !== "pake") return;
      void (async () => {
        const senderKeys = await finishPake(sender, parsePakeShareMessage(message.data));
        senderSas = senderKeys.sas;
        this.emitServer({ type: "confirm", sid, tag: sessionConfirmTag(senderKeys.signalAuthKey, sid, "sender") });
        this.emitServer({ type: "pake", sid, data: JSON.stringify({ t: "cpace-share", share: senderShare }) });
      })();
    }

    emitServer(message: ServerMessage): void {
      this.emit("message", message);
      this.emit(message.type, message);
    }
  })();

  const receiverKeys = await establishKeys(signaling as never, sid, "receiver", code);
  assert.equal(receiverKeys.sas, senderSas);
});

test("establishKeys cancels armed PAKE waiters when sending the local share fails", async () => {
  const signaling = new (class extends EventEmitter {
    send(): void {
      throw new Error("send failed");
    }
  })();

  await assert.rejects(() => establishKeys(signaling as never, "send-fail", "sender", "123456-apple-anchor"), /send failed/);
  assert.equal(signaling.listenerCount("message"), 0);
  assert.equal(signaling.listenerCount("close"), 0);
  assert.equal(signaling.listenerCount("socket-error"), 0);
  assert.equal(signaling.listenerCount("protocol-error"), 0);
});

test("PAKE waiters are armed before sending the local PAKE share", () => {
  assertPakeWaitersBeforeSend(cliSecureSource, "waitForMessage");
  assertPakeWaitersBeforeSend(webSource, "waitFor");
  assert.match(cliSecureSource, /new AbortController\(\)/);
  assert.match(cliSecureSource, /waitForMessage\(signaling, "pake", CONNECT_TIMEOUT_MS, sid, waitAbort\.signal\)/);
  assert.match(cliSecureSource, /waitAbort\.abort\(\)/);
  assert.match(webSource, /new AbortController\(\)/);
  assert.match(webSource, /waitFor\(signaling, "pake", CONNECT_TIMEOUT_MS, sid, waitAbort\.signal\)/);
  assert.match(webSource, /waitAbort\.abort\(\)/);
});

function assertPakeWaitersBeforeSend(source: string, waitFunction: string): void {
  const peerWait = source.indexOf(`peerWait = ${waitFunction}(signaling, "pake"`);
  const confirmWait = source.indexOf(`confirmWait = ${waitFunction}(signaling, "confirm"`);
  const send = source.indexOf('signaling.send({ type: "pake"');
  const awaitPeer = source.indexOf("const peer = await peerWait");

  assert.notEqual(peerWait, -1);
  assert.notEqual(confirmWait, -1);
  assert.notEqual(send, -1);
  assert.notEqual(awaitPeer, -1);
  assert.equal(peerWait < send, true);
  assert.equal(confirmWait < send, true);
  assert.equal(send < awaitPeer, true);
}

function extractFunctionBody(source: string, name: string): string {
  const signature = name === "connect" ? `${name}(): Promise<void>` : name === "close" ? `${name}(): void` : `private ${name}(`;
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

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const jsFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
  assert.equal(jsFiles.length, 1);
  return fs.readFileSync(new URL(jsFiles[0]!, assetsDir), "utf8");
}

function distCliIndexSource(): string {
  return fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
}
