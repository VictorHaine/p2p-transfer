import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";

const CHILD_EXIT_TIMEOUT_MS = 15_000;
const CHILD_KILL_GRACE_MS = 3_000;

test("CLI transfers a file through the built signaling server with secure session output", async () => {
  const root = process.cwd();
  const port = 19_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-e2e-"));
  const childEnv = testChildEnv(tmp);
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });
  let receiver: ChildProcessWithoutNullStreams | undefined;
  let sender: ChildProcessWithoutNullStreams | undefined;

  try {
    await waitForOutput(server, /listening/);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ff transfer/);
    const missingAsset = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);

    const source = path.join(tmp, "source.txt");
    const out = path.join(tmp, "out");
    await fs.mkdir(out);
    await fs.writeFile(source, "secure e2e transfer\n");

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    receiver = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "recv", "--code", "12345678-apple-anchor", "--yes", "--out", out], { cwd: root, env: childEnv });
    await waitForOutput(receiver, /"registered"/);

    sender = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", "12345678-apple-anchor", source], { cwd: root, env: childEnv });
    const [senderResult, receiverResult] = await Promise.all([
      waitForExitWithOutput(sender, "sender", CHILD_EXIT_TIMEOUT_MS),
      waitForExitWithOutput(receiver, "receiver", CHILD_EXIT_TIMEOUT_MS)
    ]);

    assert.equal(senderResult.code, 0, exitSummary(senderResult));
    assert.equal(receiverResult.code, 0, exitSummary(receiverResult));
    assert.match(senderResult.stdout, /"secure_session"/);
    assert.match(receiverResult.stdout, /"secure_session"/);
    assert.match(senderResult.stdout, /"sent"/);
    assert.match(receiverResult.stdout, /"received"/);
    assert.equal(await fs.readFile(path.join(out, "source.txt"), "utf8"), "secure e2e transfer\n");
  } finally {
    if (sender) await terminateChildAndWait(sender);
    if (receiver) await terminateChildAndWait(receiver);
    await terminateChildAndWait(server);
    await removeTestTemp(tmp);
  }
});

test("CLI local-private-mode redacts transfer metadata during a real transfer", async () => {
  const root = process.cwd();
  const port = 17_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-e2e-redacted-transfer-"));
  const out = path.join(tmp, "out");
  const code = "12345684-apple-anchor";
  const source = path.join(tmp, "private-tax-form.pdf");
  await fs.mkdir(out);
  await fs.writeFile(source, "redacted cli transfer\n");
  const childEnv = {
    ...testChildEnv(tmp),
    FF_PRIVATE_RECEIVE_CODE: code,
    FF_PRIVATE_SEND_CODE: code,
    FF_PRIVATE_RECEIVE_OUT: out,
    FF_PRIVATE_SIGNALING_SERVER: `ws://127.0.0.1:${port}/v1/ws`
  };
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });
  let receiver: ChildProcessWithoutNullStreams | undefined;
  let sender: ChildProcessWithoutNullStreams | undefined;

  try {
    await waitForOutput(server, /listening/);
    receiver = spawn(process.execPath, ["dist-node/cli/index.js", "--server-env", "FF_PRIVATE_SIGNALING_SERVER", "--json", "--local-private-mode", "recv", "--code-env", "FF_PRIVATE_RECEIVE_CODE", "--out-env", "FF_PRIVATE_RECEIVE_OUT", "--yes"], {
      cwd: root,
      env: childEnv
    });
    const receiverDone = waitForExitWithOutput(receiver, "receiver", CHILD_EXIT_TIMEOUT_MS);
    await waitForOutput(receiver, /"registered"/);

    sender = spawn(process.execPath, ["dist-node/cli/index.js", "--server-env", "FF_PRIVATE_SIGNALING_SERVER", "--json", "--local-private-mode", "send", "--code-env", "FF_PRIVATE_SEND_CODE", "--files-stdin"], {
      cwd: root,
      env: childEnv
    });
    sender.stdin.end(`${source}\n`);
    const [senderResult, receiverResult] = await Promise.all([waitForExitWithOutput(sender, "sender", CHILD_EXIT_TIMEOUT_MS), receiverDone]);

    assert.equal(senderResult.code, 0, exitSummary(senderResult));
    assert.equal(receiverResult.code, 0, exitSummary(receiverResult));
    const combinedOutput = `${senderResult.stdout}\n${senderResult.stderr}\n${receiverResult.stdout}\n${receiverResult.stderr}`;
    assert.match(senderResult.stdout, /"manifestRedacted":true/);
    assert.match(receiverResult.stdout, /"manifestRedacted":true/);
    assert.match(senderResult.stdout, /"sasRedacted":true/);
    assert.match(receiverResult.stdout, /"sasRedacted":true/);
    assert.doesNotMatch(combinedOutput, /12345684|apple-anchor|private-tax-form|\.pdf|"files"|"fileCount"|"totalBytes"|"bytes"|[0-9]+ file\(s\)/);

    const receivedNames = await fs.readdir(out);
    assert.equal(receivedNames.length, 1);
    assert.match(receivedNames[0] ?? "", /^ff-[a-f0-9]+$/);
    assert.equal(await fs.readFile(path.join(out, receivedNames[0]!), "utf8"), "redacted cli transfer\n");
  } finally {
    if (sender) await terminateChildAndWait(sender);
    if (receiver) await terminateChildAndWait(receiver);
    await terminateChildAndWait(server);
    await removeTestTemp(tmp);
  }
});

test("CLI supplied receive code is redacted from registered JSON output", async () => {
  const root = process.cwd();
  const port = 18_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-e2e-registered-redaction-"));
  const out = path.join(tmp, "out");
  const childEnv = { ...testChildEnv(tmp), FF_PRIVATE_RECEIVE_CODE: "12345678-apple-anchor" };
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });
  let receiver: ChildProcessWithoutNullStreams | undefined;

  try {
    await fs.mkdir(out);
    await waitForOutput(server, /listening/);
    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    receiver = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "recv", "--code-env", "FF_PRIVATE_RECEIVE_CODE", "--yes", "--out", out], { cwd: root, env: childEnv });
    const receiverDone = waitForExitWithOutput(receiver, "receiver", CHILD_EXIT_TIMEOUT_MS);
    await waitForOutput(receiver, /"registered"/);
    terminateChild(receiver);
    const receiverResult = await receiverDone;
    const registered = receiverResult.stdout
      .split(/\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "registered");
    assert.deepEqual(registered, { event: "registered", codeSupplied: true, rendezvousRedacted: true, expiresInSec: 600 });
    assert.doesNotMatch(receiverResult.stdout, /12345678|apple-anchor/);
  } finally {
    if (receiver) await terminateChildAndWait(receiver);
    await terminateChildAndWait(server);
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

function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      rejectOnce(new Error(`Timed out waiting for ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (pattern.test(text)) {
        resolveOnce();
      }
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectOnce(new Error(`Process exited before ${pattern}: ${exitStatus({ label: "process", code, signal, stdout, stderr })}`));
    };
    const onError = (error: Error) => {
      rejectOnce(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

type ChildResult = { label: string; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function waitForExitWithOutput(child: ChildProcessWithoutNullStreams, label: string, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const resolveOnce = (result: ChildResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      rejectOnce(new Error(`Timed out waiting for ${label} exit.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      resolveOnce({ label, code, signal, stdout, stderr });
    };
    const onError = (error: Error) => {
      rejectOnce(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
  killTimer.unref();
}

async function terminateChildAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  terminateChild(child);
  await waitForProcessExit(child, CHILD_KILL_GRACE_MS + 2_000).catch(() => undefined);
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for process exit."));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function removeTestTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function exitSummary(result: ChildResult): string {
  return `${exitStatus(result)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function exitStatus(result: Pick<ChildResult, "label" | "code" | "signal" | "stdout" | "stderr">): string {
  return `${result.label} exited with code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}`;
}
