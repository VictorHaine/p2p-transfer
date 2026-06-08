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
  assert.match(securityPolicy, /the production server must fail closed on missing or invalid asset manifests/);
  assert.match(readme, /Production builds inject SRI into the browser JS\/CSS tags, emit `dist-web\/asset-manifest\.json`/);
  for (const candidate of [serverSource, distServerSource]) {
    assert.match(candidate, /loadCheckedWebAssetManifest\(webRoot, production\)/);
    assert.match(candidate, /verifyWebAssetIntegrity\(webAssetManifest, root, realFilePath, staticFile\.body\)/);
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

test("built production server refuses tampered browser assets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-"));
  const copiedWebRoot = path.join(tmp, "dist-web");
  const port = 31_000 + randomInt(1_000);
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcessWithoutNullStreams | undefined;

  try {
    await fs.cp(path.resolve("dist-web"), copiedWebRoot, { recursive: true });
    const manifest = await readManifest(copiedWebRoot);
    const assetPath = Object.keys(manifest.files).find((candidate) => candidate.endsWith(".js"));
    assert(assetPath);
    await fs.appendFile(path.join(copiedWebRoot, `.${assetPath}`), "\n// tampered\n");

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

test("production server refuses web roots without the generated asset manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-web-integrity-missing-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><title>missing manifest</title>", "utf8");
    await assert.rejects(() => loadWebAssetManifest(tmp, true), /web asset manifest is invalid/);
    assert.equal(await loadWebAssetManifest(tmp, false), undefined);
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
