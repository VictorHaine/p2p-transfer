import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { chromium, type Locator } from "playwright";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium();

test("browser sender interoperates with CLI receiver", { skip: chromiumPath ? false : "No Chromium executable found" }, async () => {
  const root = process.cwd();
  const port = 20_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn("node", ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-browser-cli-"));
    const source = path.join(tmp, "source.txt");
    const out = path.join(tmp, "out");
    await fs.mkdir(out);
    await fs.writeFile(source, "browser to cli secure transfer\n");

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    const receiver = spawn("node", ["dist-node/cli/index.js", "--server", serverUrl, "--json", "recv", "--code", "12345678-apple-anchor", "--yes", "--out", out], { cwd: root });
    const receiverDone = collectExit(receiver);
    await waitForOutput(receiver, /"registered"/);

    browser = await chromium.launch(chromiumLaunchOptions());
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator("#serverUrl").fill(serverUrl);
    await page.locator("#sendCode").fill("12345678-apple-anchor");
    await page.locator("#fileInput").setInputFiles(source);
    await page.locator('button[type="submit"]').click();
    await expectText(page.locator("#sendStatus"), "Done");

    const receiverResult = await receiverDone;
    assert.equal(receiverResult.code, 0, receiverResult.stderr);
    assert.match(receiverResult.stdout, /"secure_session"/);
    assert.equal(await fs.readFile(path.join(out, "source.txt"), "utf8"), "browser to cli secure transfer\n");
  } finally {
    await browser?.close();
    server.kill();
  }
});

test("CLI sender interoperates with browser receiver", { skip: chromiumPath ? false : "No Chromium executable found" }, async () => {
  const root = process.cwd();
  const port = 21_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn("node", ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-cli-browser-"));
    const source = path.join(tmp, "source.txt");
    const received = path.join(tmp, "received.txt");
    await fs.writeFile(source, "cli to browser secure transfer\n");

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    browser = await chromium.launch(chromiumLaunchOptions());
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator("#serverUrl").fill(serverUrl);
    await page.locator("#receiveButton").click();
    await page.locator("#codeBox").waitFor({ state: "visible", timeout: 30_000 });
    const code = (await page.locator("#codeBox").textContent())?.trim();
    assert.match(code ?? "", /^[0-9]{8}-[a-z]+-[a-z]+$/);

    const sender = spawn("node", ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", code!, source], { cwd: root });
    const senderDone = collectExit(sender);
    await page.locator("#acceptButton").waitFor({ state: "visible", timeout: 30_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await page.locator("#acceptButton").click();
    const download = await downloadPromise;
    await download.saveAs(received);
    await expectText(page.locator("#recvStatus"), "Done");

    const senderResult = await senderDone;
    assert.equal(senderResult.code, 0, senderResult.stderr);
    assert.match(senderResult.stdout, /"secure_session"/);
    assert.equal(await fs.readFile(received, "utf8"), "cli to browser secure transfer\n");
  } finally {
    await browser?.close();
    server.kill();
  }
});

function findChromium(): string | undefined {
  for (const bin of ["chromium", "google-chrome", "chrome"]) {
    const result = spawnSync("which", [bin], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return undefined;
}

async function expectText(locator: Locator, text: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await locator.textContent()) === text) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await locator.textContent(), text);
}

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
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, stdout: "", stderr: "" });
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

function chromiumLaunchOptions() {
  return chromiumPath === undefined ? { headless: true } : { executablePath: chromiumPath, headless: true };
}
