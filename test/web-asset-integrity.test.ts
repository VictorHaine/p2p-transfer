import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadWebAssetManifest, verifyWebAssetIntegrity } from "../src/server/web-asset-integrity.js";

type WebAssetManifestFile = {
  version: 1;
  algorithm: "sha256";
  files: Record<string, { bytes: number; sha256: string; sri: string }>;
};

test("browser asset integrity is wired into build and server policy", () => {
  const packageJson = JSON.parse(readUtf8("package.json")) as { scripts?: Record<string, string> };
  const buildScript = packageJson.scripts?.build ?? "";
  const securityPolicy = readUtf8("SECURITY.md");
  const readme = readUtf8("README.md");
  const serverSource = readUtf8("src/server/index.ts");
  const distServerSource = readUtf8("dist-node/server/index.js");

  assert.match(buildScript, /vite build && node scripts\/write-web-asset-manifest\.mjs/);
  assert.match(securityPolicy, /production browser builds must inject Subresource Integrity attributes/);
  assert.match(securityPolicy, /public deployments must no-follow-open/);
  assert.match(securityPolicy, /then fail closed on missing or invalid asset manifests/);
  assert.match(securityPolicy, /exclusive no-follow creation/);
  assert.match(securityPolicy, /no-follow-open, exact-size read, fatal-UTF-8-decode, and pre\/post-read identity-check/);
  assert.match(securityPolicy, /verify every manifest-listed asset before startup completes/);
  assert.match(readme, /Production builds inject SRI into the browser JS\/CSS tags and emit `dist-web\/asset-manifest\.json`/);
  assert.match(readme, /Public deployment server runs refuse to serve HTML\/JS\/CSS bytes that do not match that manifest/);
  assert.match(readUtf8("scripts/write-web-asset-manifest.mjs"), /O_CREAT \| fsConstants\.O_EXCL \| fsConstants\.O_NOFOLLOW/);
  for (const candidate of [serverSource, distServerSource]) {
    assert.match(candidate, /loadCheckedWebAssetManifest\(webRoot, hardenedDeployment\)/);
    assert.match(candidate, /verifyWebAssetIntegrity\(webAssetManifest, root, realFilePath, staticFile\.body\)/);
  }
  for (const candidate of [readUtf8("src/server/web-asset-integrity.ts"), readUtf8("dist-node/server/web-asset-integrity.js")]) {
    assert.match(candidate, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
    assert.match(candidate, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW \| fsConstants\.O_NONBLOCK/);
    assert.match(candidate, /const body = await readExactFile\(handle, stat\.size\)/);
    assert.match(candidate, /if \(!sameFile\(stat, afterRead\)\)\s*throw new Error\("web asset manifest is invalid"\)/);
    assert.match(candidate, /await verifyManifestAssets\(webRoot, manifest\)/);
    assert.match(candidate, /for \(const assetPath of manifest\.files\.keys\(\)\)/);
  }
});

test("browser build emits SRI-backed asset manifest matching dist-web bytes", async () => {
  const webRoot = path.resolve("dist-web");
  const manifest = await readManifest(webRoot);
  const indexHtml = await fs.readFile(path.join(webRoot, "index.html"), "utf8");
  const paths = Object.keys(manifest.files).sort();

  assert.equal(manifest.version, 1);
  assert.equal(manifest.algorithm, "sha256");
  assert(paths.includes("/index.html"));
  assert(paths.some((assetPath) => assetPath.endsWith(".js")));

  for (const assetPath of paths) {
    assert.match(assetPath, /^\/(?:index\.html|assets\/[^/]+\.(?:js|css))$/);
    const body = await fs.readFile(path.join(webRoot, `.${assetPath}`));
    const expected = digestBody(body);
    assert.deepEqual(manifest.files[assetPath], expected);
    if (assetPath.endsWith(".js") || assetPath.endsWith(".css")) {
      assert(indexHtml.includes(`"${assetPath}"`));
      assert(indexHtml.includes(` integrity="${expected.sri}"`));
    }
  }
});

test("server integrity verifier rejects modified browser assets", async () => {
  const webRoot = path.resolve("dist-web");
  const manifest = await loadWebAssetManifest(webRoot, true);
  assert(manifest);
  const root = await fs.realpath(webRoot);
  const assetPath = [...manifest.files.keys()].find((candidate) => candidate.endsWith(".js"));
  assert(assetPath);
  const realFilePath = await fs.realpath(path.join(webRoot, `.${assetPath}`));
  const body = await fs.readFile(realFilePath);

  verifyWebAssetIntegrity(manifest, root, realFilePath, body);
  assert.throws(() => verifyWebAssetIntegrity(manifest, root, realFilePath, Buffer.concat([body, Buffer.from("\n// tampered\n")])), /static asset integrity check failed/);
});

test("built production server refuses browser assets tampered before startup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-"));
  const copiedWebRoot = path.join(tmp, "dist-web");
  const port = 31_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;

  try {
    await fs.cp(path.resolve("dist-web"), copiedWebRoot, { recursive: true });
    const manifest = await readManifest(copiedWebRoot);
    const assetPath = Object.keys(manifest.files).find((candidate) => candidate.endsWith(".js"));
    assert(assetPath);
    await fs.appendFile(path.join(copiedWebRoot, `.${assetPath}`), "\n// tampered\n");

    const server = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...testChildEnv(tmp),
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        ALLOWED_ORIGINS: origin,
        SIGNALING_TOPOLOGY: "single-instance",
        ALLOW_INSECURE_ORIGINS: "true",
        WEB_ROOT: copiedWebRoot
      }
    });
    const output = collectOutput(server);

    assert.equal(await waitForProcessExit(server), 1);
    await output.done;
    assert.match(output.text(), /ff signaling server startup failed: web root/);
    assert.doesNotMatch(output.text(), /assets\/index|tampered|Error:| at |stack|dist-web/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("built production server refuses browser assets tampered after startup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-live-"));
  const copiedWebRoot = path.join(tmp, "dist-web");
  const port = 32_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcessWithoutNullStreams | undefined;

  try {
    await fs.cp(path.resolve("dist-web"), copiedWebRoot, { recursive: true });
    const manifest = await readManifest(copiedWebRoot);
    const assetPath = Object.keys(manifest.files).find((candidate) => candidate.endsWith(".js"));
    assert(assetPath);

    server = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...testChildEnv(tmp),
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        ALLOWED_ORIGINS: origin,
        SIGNALING_TOPOLOGY: "single-instance",
        ALLOW_INSECURE_ORIGINS: "true",
        WEB_ROOT: copiedWebRoot
      }
    });
    const output = collectOutput(server);

    await waitForOutput(server, /listening/);
    await fs.appendFile(path.join(copiedWebRoot, `.${assetPath}`), "\n// tampered\n");
    const response = await fetch(`http://127.0.0.1:${port}${assetPath}`, { headers: { Origin: origin } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });

    server.kill();
    await output.done;
  } finally {
    server?.kill();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("hardened server refuses web roots without the generated asset manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-missing-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><title>missing manifest</title>", "utf8");
    await assert.rejects(() => loadWebAssetManifest(tmp, true), /web asset manifest is invalid/);
    assert.equal(await loadWebAssetManifest(tmp, false), undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("hardened server refuses malformed UTF-8 asset manifests", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-utf8-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><title>bad utf8 manifest</title>", "utf8");
    await fs.writeFile(path.join(tmp, "asset-manifest.json"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(() => loadWebAssetManifest(tmp, true), /web asset manifest is invalid/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("built non-loopback server refuses web roots without the generated asset manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-public-missing-"));
  const port = 33_000 + randomInt(1_000);
  const origin = "https://files.example";

  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><title>missing manifest</title>", "utf8");
    const server = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...testChildEnv(tmp),
        PORT: String(port),
        HOST: "0.0.0.0",
        ALLOWED_ORIGINS: origin,
        SIGNALING_TOPOLOGY: "single-instance",
        WEB_ROOT: tmp
      }
    });
    const output = collectOutput(server);

    assert.equal(await waitForProcessExit(server), 1);
    await output.done;
    assert.match(output.text(), /ff signaling server startup failed: web root/);
    assert.doesNotMatch(output.text(), /Error:| at |stack|asset-manifest|missing manifest/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("built loopback server with public origin refuses web roots without the generated asset manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-proxy-missing-"));
  const port = 34_000 + randomInt(1_000);
  const origin = "https://files.example";

  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><title>missing manifest</title>", "utf8");
    const server = spawn(process.execPath, ["dist-node/server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...testChildEnv(tmp),
        PORT: String(port),
        HOST: "127.0.0.1",
        ALLOWED_ORIGINS: origin,
        SIGNALING_TOPOLOGY: "single-instance",
        WEB_ROOT: tmp
      }
    });
    const output = collectOutput(server);

    assert.equal(await waitForProcessExit(server), 1);
    await output.done;
    assert.match(output.text(), /ff signaling server startup failed: web root/);
    assert.doesNotMatch(output.text(), /Error:| at |stack|asset-manifest|missing manifest/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function readManifest(webRoot: string): Promise<WebAssetManifestFile> {
  return JSON.parse(await fs.readFile(path.join(webRoot, "asset-manifest.json"), "utf8")) as WebAssetManifestFile;
}

function digestBody(body: Buffer): { bytes: number; sha256: string; sri: string } {
  const hash = createHash("sha256").update(body).digest();
  return {
    bytes: body.byteLength,
    sha256: hash.toString("hex"),
    sri: `sha256-${hash.toString("base64")}`
  };
}

function testChildEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: requiredEnv("PATH"),
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

function collectOutput(child: ChildProcessWithoutNullStreams): { done: Promise<void>; text: () => string } {
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  return {
    done: new Promise((resolve) => child.on("close", () => resolve())),
    text: () => Buffer.concat(chunks).toString("utf8")
  };
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.on("close", (code) => resolve(code)));
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5_000;
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  while (Date.now() < deadline) {
    if (pattern.test(output)) return;
    if (child.exitCode !== null) throw new Error(`Server exited before expected output: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for server output: ${output}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for server tests.`);
  return value;
}

function readUtf8(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}
