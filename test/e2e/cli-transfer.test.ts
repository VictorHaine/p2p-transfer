import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";

test("CLI transfers a file through the built signaling server with secure session output", async () => {
  const root = process.cwd();
  const port = 19_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn("node", ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

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

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-e2e-"));
    const source = path.join(tmp, "source.txt");
    const out = path.join(tmp, "out");
    await fs.mkdir(out);
    await fs.writeFile(source, "secure e2e transfer\n");

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    const receiver = spawn("node", ["dist-node/cli/index.js", "--server", serverUrl, "--json", "recv", "--code", "12345678-apple-anchor", "--yes", "--out", out], { cwd: root });
    await waitForOutput(receiver, /"registered"/);

    const sender = spawn("node", ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", "12345678-apple-anchor", source], { cwd: root });
    const [senderResult, receiverResult] = await Promise.all([collectExit(sender), collectExit(receiver)]);

    assert.equal(senderResult.code, 0, senderResult.stderr);
    assert.equal(receiverResult.code, 0, receiverResult.stderr);
    assert.match(senderResult.stdout, /"secure_session"/);
    assert.match(receiverResult.stdout, /"secure_session"/);
    assert.match(senderResult.stdout, /"sent"/);
    assert.match(receiverResult.stdout, /"received"/);
    assert.equal(await fs.readFile(path.join(out, "source.txt"), "utf8"), "secure e2e transfer\n");
  } finally {
    server.kill();
  }
});

function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 10_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (pattern.test(text)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited before ${pattern}: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function collectExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
