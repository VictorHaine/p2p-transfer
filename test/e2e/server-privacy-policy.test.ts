import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import WebSocket from "ws";
import { MAX_FILE_BYTES, MAX_FILES_PER_SESSION, PROTOCOL_VERSION, RECEIVER_MAX_PREPAIR_ATTEMPTS, SIGNALING_MAX_BAD_MESSAGES, SIGNALING_MAX_CONNECTION_ATTEMPTS_PER_MINUTE, STATIC_MAX_REQUESTS_PER_MINUTE } from "../../src/shared/constants.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/shared/package-info.js";

type ServerEvent = { type?: string; sid?: string; code?: string; message?: string; [key: string]: unknown };

test("built production server version endpoint does not expose exact package fingerprint", async () => {
  const root = process.cwd();
  const port = 27_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-version-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  try {
    await waitForOutput(server, /listening/);
    const response = await fetch(`http://127.0.0.1:${port}/v1/version`, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    assert.deepEqual(body, { protocolVersion: PROTOCOL_VERSION });
    assert.equal(bodyText.includes(PACKAGE_NAME), false);
    assert.equal(bodyText.includes(PACKAGE_VERSION), false);
  } finally {
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }
});

test("built signaling server rate-limits short-lived websocket upgrade churn", async () => {
  const root = process.cwd();
  const port = 28_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-ws-churn-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  try {
    await waitForOutput(server, /listening/);
    for (let index = 0; index < SIGNALING_MAX_CONNECTION_ATTEMPTS_PER_MINUTE; index += 1) {
      const ws = await connectWs(serverUrl, origin);
      ws.close();
      await waitForWsClose(ws);
    }
    await assert.rejects(() => connectWs(serverUrl, origin), /Unexpected server response|Server sent no subprotocol|Timed out connecting WebSocket/);
  } finally {
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }
});

test("built signaling server rate-limits unauthenticated static requests before disk work", async () => {
  const root = process.cwd();
  const port = 29_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-static-rate-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  try {
    await waitForOutput(server, /listening/);
    for (let index = 0; index < STATIC_MAX_REQUESTS_PER_MINUTE; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/static-rate-${index}`, { headers: { Origin: origin } });
      assert.notEqual(response.status, 429);
      await response.arrayBuffer();
    }
    const limited = await fetch(`http://127.0.0.1:${port}/static-rate-limited`, { headers: { Origin: origin } });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
  } finally {
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }
});

test("built signaling server rate-limits unauthenticated control endpoints", async () => {
  const root = process.cwd();
  const port = 30_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-control-rate-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  try {
    await waitForOutput(server, /listening/);
    for (let index = 0; index < STATIC_MAX_REQUESTS_PER_MINUTE; index += 1) {
      const pathName = index % 2 === 0 ? "/healthz" : "/v1/version";
      const response = await fetch(`http://127.0.0.1:${port}${pathName}`, { headers: { Origin: origin } });
      assert.notEqual(response.status, 429);
      await response.arrayBuffer();
    }
    const limited = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Origin: origin } });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
  } finally {
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }
});

test("built signaling server rejects unredacted pair requests without forwarding or logging plaintext metadata", async () => {
  const root = process.cwd();
  const port = 20_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-privacy-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let receiver: WebSocket | undefined;
  let sender: WebSocket | undefined;
  try {
    await waitForOutput(server, /listening/);
    receiver = await connectWs(serverUrl, origin);
    sendJson(receiver, { type: "register", role: "receiver", code: "12345678", protocolVersion: PROTOCOL_VERSION });
    assert.equal((await waitForServerEvent(receiver, "registered")).code, "12345678");

    sender = await connectWs(serverUrl, origin);
    sendJson(sender, { type: "connect", role: "sender", code: "12345678", protocolVersion: PROTOCOL_VERSION });
    const receiverJoined = await waitForServerEvent(receiver, "peer-joined");
    const senderJoined = await waitForServerEvent(sender, "peer-joined");
    assert.equal(senderJoined.sid, receiverJoined.sid);
    const sid = String(senderJoined.sid);

    sendJson(sender, { type: "pake", sid, data: "sender-share" });
    assert.equal((await waitForServerEvent(receiver, "pake", sid)).type, "pake");
    sendJson(receiver, { type: "pake", sid, data: "receiver-share" });
    assert.equal((await waitForServerEvent(sender, "pake", sid)).type, "pake");
    sendJson(sender, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(receiver, "confirm", sid)).type, "confirm");
    sendJson(receiver, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(sender, "confirm", sid)).type, "confirm");

    sendJson(sender, {
      type: "pair-request",
      sid,
      manifest: { fileCount: 1, totalBytes: 11, files: [{ id: 0, name: "taxes.pdf", size: 11 }] },
      sealedManifest: Buffer.alloc(20).toString("base64")
    });

    const senderError = await waitForServerEvent(sender, "error");
    assert.equal(senderError.message, "Pair request manifest must be redacted.");
    const receiverEvent = await waitForAnyServerEvent(receiver, sid);
    assert.equal(receiverEvent.type, "peer-left");
    assert.notEqual(receiverEvent.type, "pair-request");
  } finally {
    receiver?.terminate();
    sender?.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /taxes\.pdf|sender-share|receiver-share|12345678/);
});

test("built signaling server rejects public pair request MIME metadata without forwarding or logging it", async () => {
  const root = process.cwd();
  const port = 26_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345683";
  const leakedMime = "application/pdf";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-public-mime-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let receiver: WebSocket | undefined;
  let sender: WebSocket | undefined;
  try {
    await waitForOutput(server, /listening/);
    receiver = await connectWs(serverUrl, origin);
    sendJson(receiver, { type: "register", role: "receiver", code, protocolVersion: PROTOCOL_VERSION });
    assert.equal((await waitForServerEvent(receiver, "registered")).code, code);

    sender = await connectWs(serverUrl, origin);
    sendJson(sender, { type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
    const receiverJoined = await waitForServerEvent(receiver, "peer-joined");
    const senderJoined = await waitForServerEvent(sender, "peer-joined");
    assert.equal(senderJoined.sid, receiverJoined.sid);
    const sid = String(senderJoined.sid);

    sendJson(sender, { type: "pake", sid, data: "sender-share" });
    assert.equal((await waitForServerEvent(receiver, "pake", sid)).type, "pake");
    sendJson(receiver, { type: "pake", sid, data: "receiver-share" });
    assert.equal((await waitForServerEvent(sender, "pake", sid)).type, "pake");
    sendJson(sender, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(receiver, "confirm", sid)).type, "confirm");
    sendJson(receiver, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(sender, "confirm", sid)).type, "confirm");

    sendJson(sender, {
      type: "pair-request",
      sid,
      manifest: { fileCount: 1, totalBytes: 11, files: [{ id: 0, name: "encrypted-0", size: 11, mime: leakedMime }] },
      sealedManifest: Buffer.alloc(20).toString("base64")
    });

    const senderError = await waitForServerEvent(sender, "error");
    assert.equal(senderError.message, "Pair request manifest must be redacted.");
    const receiverEvent = await waitForAnyServerEvent(receiver, sid);
    assert.equal(receiverEvent.type, "peer-left");
    assert.notEqual(receiverEvent.type, "pair-request");
  } finally {
    receiver?.terminate();
    sender?.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /application\/pdf|sender-share|receiver-share|12345683/);
});

test("built signaling server exhausts receive codes after invalid pre-pair sender attempts", async () => {
  const root = process.cwd();
  const port = 21_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345679";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-prepair-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let receiver: WebSocket | undefined;
  const senders: WebSocket[] = [];
  try {
    await waitForOutput(server, /listening/);
    receiver = await connectWs(serverUrl, origin);
    sendJson(receiver, { type: "register", role: "receiver", code, protocolVersion: PROTOCOL_VERSION });
    assert.equal((await waitForServerEvent(receiver, "registered")).code, code);

    for (let attempt = 1; attempt <= RECEIVER_MAX_PREPAIR_ATTEMPTS; attempt += 1) {
      const sender = await connectWs(serverUrl, origin);
      senders.push(sender);
      sendJson(sender, { type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
      const receiverJoined = await waitForServerEvent(receiver, "peer-joined");
      const senderJoined = await waitForServerEvent(sender, "peer-joined");
      assert.equal(senderJoined.sid, receiverJoined.sid);
      const sid = String(senderJoined.sid);

      sendJson(sender, { type: "pair-accept", sid, auth: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
      const senderError = await waitForServerEvent(sender, "error");
      assert.equal(senderError.code, "bad_message");

      if (attempt < RECEIVER_MAX_PREPAIR_ATTEMPTS) {
        assert.equal((await waitForServerEvent(receiver, "registered")).code, code);
      } else {
        const receiverError = await waitForServerEvent(receiver, "error");
        assert.equal(receiverError.code, "expired");
        assert.equal(receiverError.message, "Receive code expired after too many invalid pairing attempts.");
      }
    }

    const lateSender = await connectWs(serverUrl, origin);
    senders.push(lateSender);
    sendJson(lateSender, { type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
    const lateError = await waitForServerEvent(lateSender, "error");
    assert.equal(lateError.code, "code_not_found");
  } finally {
    receiver?.terminate();
    for (const sender of senders) sender.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /12345679|Receive code expired after too many invalid pairing attempts|pair-accept/);
});

test("built signaling server sanitizes peer-controlled bye reasons before forwarding", async () => {
  const root = process.cwd();
  const port = 22_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345680";
  const secretReason = "secret-token-from-local-path";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-bye-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let receiver: WebSocket | undefined;
  let sender: WebSocket | undefined;
  try {
    await waitForOutput(server, /listening/);
    receiver = await connectWs(serverUrl, origin);
    sendJson(receiver, { type: "register", role: "receiver", code, protocolVersion: PROTOCOL_VERSION });
    assert.equal((await waitForServerEvent(receiver, "registered")).code, code);

    sender = await connectWs(serverUrl, origin);
    sendJson(sender, { type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
    const receiverJoined = await waitForServerEvent(receiver, "peer-joined");
    const senderJoined = await waitForServerEvent(sender, "peer-joined");
    assert.equal(senderJoined.sid, receiverJoined.sid);
    const sid = String(senderJoined.sid);

    sendJson(sender, { type: "bye", sid, reason: secretReason });
    const peerLeft = await waitForServerEvent(receiver, "peer-left", sid);
    assert.notEqual(peerLeft.reason, secretReason);
    assert.equal(peerLeft.reason, "closed");
  } finally {
    receiver?.terminate();
    sender?.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /12345680|secret-token-from-local-path/);
});

test("built signaling server sanitizes paired bye reasons before forwarding", async () => {
  const root = process.cwd();
  const port = 23_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345681";
  const secretReason = "secret-token-after-accept";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-paired-bye-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let receiver: WebSocket | undefined;
  let sender: WebSocket | undefined;
  try {
    await waitForOutput(server, /listening/);
    receiver = await connectWs(serverUrl, origin);
    sendJson(receiver, { type: "register", role: "receiver", code, protocolVersion: PROTOCOL_VERSION });
    assert.equal((await waitForServerEvent(receiver, "registered")).code, code);

    sender = await connectWs(serverUrl, origin);
    sendJson(sender, { type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
    const receiverJoined = await waitForServerEvent(receiver, "peer-joined");
    const senderJoined = await waitForServerEvent(sender, "peer-joined");
    assert.equal(senderJoined.sid, receiverJoined.sid);
    const sid = String(senderJoined.sid);

    sendJson(sender, { type: "pake", sid, data: "sender-share" });
    assert.equal((await waitForServerEvent(receiver, "pake", sid)).type, "pake");
    sendJson(receiver, { type: "pake", sid, data: "receiver-share" });
    assert.equal((await waitForServerEvent(sender, "pake", sid)).type, "pake");
    sendJson(sender, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(receiver, "confirm", sid)).type, "confirm");
    sendJson(receiver, { type: "confirm", sid, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(sender, "confirm", sid)).type, "confirm");

    sendJson(sender, {
      type: "pair-request",
      sid,
      manifest: constantPublicManifest(),
      sealedManifest: Buffer.alloc(20).toString("base64")
    });
    assert.equal((await waitForServerEvent(receiver, "pair-request", sid)).type, "pair-request");
    sendJson(receiver, { type: "pair-accept", sid, auth: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await waitForServerEvent(sender, "pair-accept", sid)).type, "pair-accept");

    sendJson(sender, { type: "bye", sid, reason: secretReason });
    const peerLeft = await waitForServerEvent(receiver, "peer-left", sid);
    assert.notEqual(peerLeft.reason, secretReason);
    assert.equal(peerLeft.reason, "bye");
  } finally {
    receiver?.terminate();
    sender?.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /12345681|secret-token-after-accept/);
});

test("built signaling server ignores late frames after a close decision", async () => {
  const root = process.cwd();
  const port = 24_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const code = "12345682";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-late-frame-"));
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(tmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const serverOutput = collectOutput(server);

  let peer: WebSocket | undefined;
  try {
    await waitForOutput(server, /listening/);
    peer = await connectWs(serverUrl, origin);
    const messages: ServerEvent[] = [];
    peer.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerEvent);
    });

    for (let index = 0; index < SIGNALING_MAX_BAD_MESSAGES; index += 1) {
      sendJson(peer, { type: "register", role: "receiver", code, protocolVersion: "bad-version" });
    }
    sendJson(peer, { type: "register", role: "receiver", code, protocolVersion: PROTOCOL_VERSION });
    await waitForWsClose(peer);

    assert.equal(messages.filter((message) => message.type === "error" && message.code === "bad_message").length, SIGNALING_MAX_BAD_MESSAGES);
    assert.equal(messages.some((message) => message.type === "registered"), false);
  } finally {
    peer?.terminate();
    server.kill();
    await serverOutput.done;
    await removeTestTemp(tmp);
  }

  assert.doesNotMatch(serverOutput.text(), /12345682|bad-version/);
});

test("built signaling server fatal listen errors do not print stacks or arbitrary exception text", async () => {
  const root = process.cwd();
  const port = 25_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-fatal-log-"));
  const firstTmp = path.join(tmp, "first");
  const secondTmp = path.join(tmp, "second");
  await fs.mkdir(firstTmp);
  await fs.mkdir(secondTmp);
  const firstServer = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: {
      ...testChildEnv(firstTmp),
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: origin,
      SIGNALING_TOPOLOGY: "single-instance",
      ALLOW_INSECURE_ORIGINS: "true"
    }
  });
  const firstOutput = collectOutput(firstServer);
  let secondServer: ChildProcessWithoutNullStreams | undefined;
  let secondOutput: ReturnType<typeof collectOutput> | undefined;

  try {
    await waitForOutput(firstServer, /listening/);
    secondServer = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: root,
      env: {
        ...testChildEnv(secondTmp),
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        ALLOWED_ORIGINS: origin,
        SIGNALING_TOPOLOGY: "single-instance",
        ALLOW_INSECURE_ORIGINS: "true"
      }
    });
    secondOutput = collectOutput(secondServer);
    const exitCode = await waitForProcessExit(secondServer);
    assert.equal(exitCode, 1);
  } finally {
    firstServer.kill();
    await firstOutput.done;
    await secondOutput?.done;
    await removeTestTemp(tmp);
  }

  const output = secondOutput?.text() ?? "";
  assert.match(output, /ff signaling server failed: EADDRINUSE listen\n/);
  assert.doesNotMatch(output, /Error:| at |stack|listen EADDRINUSE: address already in use|127\.0\.0\.1|\d{2,5}|ALLOWED_ORIGINS|SIGNALING_TOPOLOGY/);
});

test("built signaling server startup failures do not print stacks or raw configuration evidence", async () => {
  const root = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-server-startup-log-"));
  const secretWebRoot = path.join(tmp, "secret-web-root-token");

  try {
    const badConfig = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: root,
      env: {
        ...testChildEnv(tmp),
        PORT: "8787",
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        SIGNALING_TOPOLOGY: "single-instance"
      }
    });
    const badConfigOutput = collectOutput(badConfig);
    assert.equal(await waitForProcessExit(badConfig), 1);
    await badConfigOutput.done;
    const configText = badConfigOutput.text();
    assert.match(configText, /ff signaling server startup failed: configuration/);
    assert.doesNotMatch(configText, /Error:| at |stack|index\.(?:ts|js):|loadServerConfig|SIGNALING_TOPOLOGY|NODE_ENV/);

    const badWebRoot = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: root,
      env: {
        ...testChildEnv(tmp),
        PORT: "8787",
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "http://127.0.0.1:8787",
        SIGNALING_TOPOLOGY: "single-instance",
        ALLOW_INSECURE_ORIGINS: "true",
        WEB_ROOT: secretWebRoot
      }
    });
    const badWebRootOutput = collectOutput(badWebRoot);
    assert.equal(await waitForProcessExit(badWebRoot), 1);
    await badWebRootOutput.done;
    const webRootText = badWebRootOutput.text();
    assert.match(webRootText, /ff signaling server startup failed: web root/);
    assert.doesNotMatch(webRootText, /Error:| at |stack|index\.(?:ts|js):|realpath|secret-web-root-token/);
    assert.equal(webRootText.includes(tmp), false);
  } finally {
    await removeTestTemp(tmp);
  }
});

function testChildEnv(tmp: string): NodeJS.ProcessEnv {
  const pathValue = requiredEnv("PATH");
  const env: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: path.join(tmp, "home"),
    USERPROFILE: path.join(tmp, "home"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp
  };
  if (process.platform === "win32") {
    env.SystemRoot = requiredEnv("SystemRoot");
    env.WINDIR = requiredEnv("WINDIR");
  }
  return env;
}

function requiredEnv(name: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length === 0 || descriptor.value.includes("\u0000")) {
    throw new Error(`Test environment is missing safe ${name}.`);
  }
  return descriptor.value;
}

function collectOutput(child: ChildProcessWithoutNullStreams): { done: Promise<void>; text: () => string } {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  return {
    done: new Promise((resolve) => child.once("exit", () => resolve())),
    text: () => output
  };
}

function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 10_000);
    const onData = (chunk: Buffer) => {
      if (!pattern.test(chunk.toString())) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited before ${pattern}: ${code}`));
    });
  });
}

function connectWs(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out connecting WebSocket."));
    }, 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForWsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close."));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for process exit."));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function removeTestTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function sendJson(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function constantPublicManifest(): ServerEvent {
  return {
    fileCount: MAX_FILES_PER_SESSION,
    totalBytes: MAX_FILE_BYTES * MAX_FILES_PER_SESSION,
    files: Array.from({ length: MAX_FILES_PER_SESSION }, (_, id) => ({ id, name: `encrypted-${id}`, size: MAX_FILE_BYTES }))
  };
}

function waitForServerEvent(ws: WebSocket, type: string, sid?: string): Promise<ServerEvent> {
  return waitForAnyServerEvent(ws, sid, (event) => event.type === type);
}

function waitForAnyServerEvent(ws: WebSocket, sid?: string, predicate: (event: ServerEvent) => boolean = () => true): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for server event."));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (sid !== undefined && event.sid !== sid) return;
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before expected event."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}
