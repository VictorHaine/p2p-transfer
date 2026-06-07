import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { chromium, type Locator, type Page } from "playwright";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM ?? findChromium();

test("browser sender interoperates with CLI receiver", { skip: chromiumPath ? false : "No Chromium executable found" }, async () => {
  const root = process.cwd();
  const port = 20_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-browser-cli-"));
  const childEnv = testChildEnv(tmp);
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
    const source = path.join(tmp, "source.txt");
    const out = path.join(tmp, "out");
    await fs.mkdir(out);
    await fs.writeFile(source, "browser to cli secure transfer\n");

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    const receiver = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "recv", "--code", "12345678-apple-anchor", "--yes", "--out", out], { cwd: root, env: childEnv });
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-cli-browser-"));
  const childEnv = testChildEnv(tmp);
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
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

    const sender = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", code!, source], { cwd: root, env: childEnv });
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

test("CLI sender interoperates with browser folder-only receiver", { skip: chromiumPath ? false : "No Chromium executable found" }, async () => {
  const root = process.cwd();
  const port = 22_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-cli-browser-folder-"));
  const childEnv = testChildEnv(tmp);
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
    const source = path.join(tmp, "source.txt");
    const payload = "cli to browser folder secure transfer\n";
    await fs.writeFile(source, payload);

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    browser = await chromium.launch(chromiumLaunchOptions());
    const page = await browser.newPage();
    await installFolderPickerMock(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    assert.deepEqual(await folderPickerProbe(page), { hasMock: true, pickerType: "function", hasGetFileHandle: true });
    await page.locator("#serverUrl").fill(serverUrl);
    await page.locator("#folderOnly").check();
    await page.locator("#receiveButton").click();
    await page.locator("#codeBox").waitFor({ state: "visible", timeout: 30_000 });
    const code = (await page.locator("#codeBox").textContent())?.trim();
    assert.match(code ?? "", /^[0-9]{8}-[a-z]+-[a-z]+$/);

    const sender = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", code!, source], { cwd: root, env: childEnv });
    const senderDone = collectExit(sender);
    await page.locator("#folderButton").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#acceptButton").waitFor({ state: "hidden", timeout: 30_000 });
    await page.locator("#folderButton").click();
    await expectText(page.locator("#recvStatus"), "Done");

    const senderResult = await senderDone;
    assert.equal(senderResult.code, 0, senderResult.stderr);
    assert.match(senderResult.stdout, /"secure_session"/);
    const folder = await folderPickerSnapshot(page);
    const entries = Object.entries(folder.files);
    assert.equal(entries.length, 1);
    assert.match(entries[0]![0], /^source \(ff-[a-f0-9]{32}\)\.txt$/);
    assert.equal(entries[0]![1], payload);
    assert.equal(folder.pickerCalls, 2);
    assert.deepEqual(folder.partFiles, []);
    assert.equal(folder.removed.some((name) => /\.part$/.test(name)), true);
  } finally {
    await browser?.close();
    server.kill();
  }
});

test("browser folder receiver resumes after a failed partial write", { skip: chromiumPath ? false : "No Chromium executable found" }, async () => {
  const root = process.cwd();
  const port = 23_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-cli-browser-resume-"));
  const childEnv = testChildEnv(tmp);
  const server = spawn(process.execPath, ["dist-node/server/index.js"], {
    cwd: root,
    env: { ...childEnv, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ALLOWED_ORIGINS: origin, SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForOutput(server, /listening/);
    const source = path.join(tmp, "resume.txt");
    const payload = "browser resume integrity chunk\n".repeat(3_000);
    await fs.writeFile(source, payload);

    const serverUrl = `ws://127.0.0.1:${port}/v1/ws`;
    browser = await chromium.launch(chromiumLaunchOptions());
    const page = await browser.newPage();
    await installFolderPickerMock(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator("#serverUrl").fill(serverUrl);
    await page.locator("#folderOnly").check();

    await setFolderMockFailure(page, 1);
    await page.locator("#receiveButton").click();
    await page.locator("#codeBox").waitFor({ state: "visible", timeout: 30_000 });
    const firstCode = (await page.locator("#codeBox").textContent())?.trim();
    assert.match(firstCode ?? "", /^[0-9]{8}-[a-z]+-[a-z]+$/);
    const failedSender = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", firstCode!, source], { cwd: root, env: childEnv });
    const failedSenderDone = collectExit(failedSender);
    await page.locator("#resumeButton").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#resumeButton").click();
    const failedSenderResult = await failedSenderDone;
    assert.notEqual(failedSenderResult.code, 0);
    await waitForReceiveIdle(page);
    const partial = await folderPickerSnapshot(page);
    assert.equal(partial.partFiles.length, 1);
    assert.ok(partial.byteLengths[partial.partFiles[0]!]! > 0);

    await setFolderMockFailure(page, null);
    await page.locator("#receiveButton").click();
    const secondCode = await waitForNewCode(page, firstCode!);
    assert.match(secondCode ?? "", /^[0-9]{8}-[a-z]+-[a-z]+$/);
    assert.notEqual(secondCode, firstCode);
    const resumedSender = spawn(process.execPath, ["dist-node/cli/index.js", "--server", serverUrl, "--json", "send", secondCode!, source], { cwd: root, env: childEnv });
    const resumedSenderDone = collectExit(resumedSender);
    await page.locator("#resumeButton").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#resumeButton").click();
    await expectText(page.locator("#recvStatus"), "Done");

    const resumedSenderResult = await resumedSenderDone;
    assert.equal(resumedSenderResult.code, 0, resumedSenderResult.stderr);
    assert.match(resumedSenderResult.stdout, /"secure_session"/);
    const folder = await folderPickerSnapshot(page);
    const entries = Object.entries(folder.files);
    assert.equal(entries.length, 1);
    assert.match(entries[0]![0], /^resume \(ff-[a-f0-9]{32}\)\.txt$/);
    assert.equal(entries[0]![1], payload);
    assert.deepEqual(folder.partFiles, []);
    assert.equal(folder.removed.some((name) => name === partial.partFiles[0]), true);
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

async function installFolderPickerMock(page: Page): Promise<void> {
  await page.addInitScript({
    content: `
(() => {
    const files = new Map();
    const removed = [];
    let pickerCalls = 0;
    let failAfterPartBytes = null;

    class MockFileHandle {
      constructor(name) {
        this.name = name;
      }

      async getFile() {
        const bytes = files.get(this.name) ?? new Uint8Array();
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return new File([copy], this.name);
      }

      async createWritable(options) {
        if (!options?.keepExistingData) files.set(this.name, new Uint8Array());
        let position = files.get(this.name)?.byteLength ?? 0;
        return {
          write: async (value) => {
            if (value && typeof value === "object" && "type" in value) {
              const command = value;
              if (command.type === "truncate" && typeof command.size === "number") {
                const current = files.get(this.name) ?? new Uint8Array();
                const next = new Uint8Array(command.size);
                next.set(current.subarray(0, Math.min(current.byteLength, command.size)));
                files.set(this.name, next);
                position = Math.min(position, command.size);
                return;
              }
              if (command.type === "seek" && typeof command.position === "number") {
                position = command.position;
                return;
              }
            }
            const source = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await value.arrayBuffer());
            const current = files.get(this.name) ?? new Uint8Array();
            const next = new Uint8Array(Math.max(current.byteLength, position + source.byteLength));
            next.set(current);
            next.set(source, position);
            files.set(this.name, next);
            position += source.byteLength;
            if (this.name.endsWith(".part") && failAfterPartBytes !== null && position >= failAfterPartBytes) {
              failAfterPartBytes = null;
              throw new Error("mock partial write failure");
            }
          },
          close: async () => {},
          abort: async () => {}
        };
      }
    }

    const directory = {
      async getFileHandle(name, options) {
        if (!files.has(name)) {
          if (!options?.create) throw new DOMException("Not found", "NotFoundError");
          files.set(name, new Uint8Array());
        }
        return new MockFileHandle(name);
      },
      async removeEntry(name) {
        if (!files.delete(name)) throw new DOMException("Not found", "NotFoundError");
        removed.push(name);
      }
    };

    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => directory
    });
    window.showDirectoryPicker = async () => {
      pickerCalls += 1;
      return directory;
    };
    Object.defineProperty(window, "__ffTestFs", {
      configurable: true,
      value: {
        snapshot: () => {
          const decoder = new TextDecoder();
          const fileEntries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
          return {
            files: Object.fromEntries(fileEntries.map(([name, bytes]) => [name, decoder.decode(bytes)])),
            byteLengths: Object.fromEntries(fileEntries.map(([name, bytes]) => [name, bytes.byteLength])),
            partFiles: fileEntries.map(([name]) => name).filter((name) => name.endsWith(".part")),
            removed: [...removed],
            pickerCalls
          };
        },
        setFailAfterPartBytes: (bytes) => {
          failAfterPartBytes = bytes;
        }
      }
    });
})();
`
  });
}

type FolderSnapshot = { files: Record<string, string>; byteLengths: Record<string, number>; partFiles: string[]; removed: string[]; pickerCalls: number };

function folderPickerSnapshot(page: Page): Promise<FolderSnapshot> {
  return page.evaluate(() => (window as unknown as { __ffTestFs: { snapshot: () => FolderSnapshot } }).__ffTestFs.snapshot());
}

function setFolderMockFailure(page: Page, bytes: number | null): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __ffTestFs: { setFailAfterPartBytes: (bytes: number | null) => void } }).__ffTestFs.setFailAfterPartBytes(value);
  }, bytes);
}

function folderPickerProbe(page: Page): Promise<{ hasMock: boolean; pickerType: string; hasGetFileHandle: boolean }> {
  return page.evaluate(async () => {
    const probeWindow = window as unknown as {
      __ffTestFs?: unknown;
      showDirectoryPicker?: () => Promise<{ getFileHandle?: unknown }>;
    };
    const hasMock = Boolean(probeWindow.__ffTestFs);
    const directory = hasMock ? await probeWindow.showDirectoryPicker?.() : undefined;
    return { hasMock, pickerType: typeof probeWindow.showDirectoryPicker, hasGetFileHandle: typeof directory?.getFileHandle === "function" };
  });
}

async function waitForReceiveIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#receiveButton");
    return Boolean(button && !button.disabled);
  }, undefined, { timeout: 30_000 });
}

async function waitForNewCode(page: Page, oldCode: string): Promise<string> {
  await page.waitForFunction((previous) => {
    const text = document.querySelector("#codeBox")?.textContent?.trim();
    return Boolean(text && text !== previous);
  }, oldCode, { timeout: 30_000 });
  return (await page.locator("#codeBox").textContent())!.trim();
}

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
