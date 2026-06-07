import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../src/shared/constants.js";

type ServerEvent = { type?: string; sid?: string; code?: string; message?: string; [key: string]: unknown };

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
  }

  assert.doesNotMatch(serverOutput.text(), /taxes\.pdf|sender-share|receiver-share|12345678/);
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

function sendJson(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
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
