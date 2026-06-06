import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { optionalOrigin, probeErrorMessage, readBoundedResponseText, requiredUrl } from "../scripts/probe-http.mjs";

const execFileAsync = promisify(execFile);
const probeScript = new URL("../scripts/probe-http.mjs", import.meta.url);

test("HTTP probe reports invalid URLs with probe-owned errors", async () => {
  const result = await runProbe({
    PROBE_URL: "http://[not-ip]/healthz",
    PROBE_STATUS: "200"
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /HTTP probe failed:/);
  assert.match(result.stderr, /PROBE_URL must be a valid URL/);
  assert.doesNotMatch(result.stderr, /probe-http\.mjs|TypeError|SyntaxError/);
});

test("HTTP probe bounds URL-like environment values by UTF-8 bytes", () => {
  assert.throws(() => requiredUrl(`http://127.0.0.1/${"😀".repeat(512)}`), /non-empty bounded URL/);
  assert.throws(() => optionalOrigin(`http://${"😀".repeat(512)}.localhost`), /bounded origin/);
});

test("HTTP probe bounds every environment value before field parsing", async () => {
  const result = await runProbe({
    PROBE_URL: "http://127.0.0.1:1/healthz",
    PROBE_STATUS: "2".repeat(2_049)
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PROBE_STATUS must be a NUL-free string under 2048 UTF-8 bytes\./);
});

test("HTTP probe runtime failures do not echo raw probe URLs or stack traces", async () => {
  const result = await runProbe({
    PROBE_URL: "http://127.0.0.1:1/secret-token?api_key=hidden",
    PROBE_STATUS: "200"
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /HTTP probe failed:/);
  assert.doesNotMatch(result.stderr, /secret-token|api_key|hidden|probe-http\.mjs\s*:/);
});

test("HTTP probe error renderer suppresses URL and path shaped runtime evidence", () => {
  assert.equal(probeErrorMessage(new Error("connect failed for http://127.0.0.1:8787/secret-token?api_key=hidden")), "HTTP probe failed with an internal error.");
  assert.equal(probeErrorMessage(new Error("open /private/tmp/p2p-transfer/secret failed")), "HTTP probe failed with an internal error.");
  assert.equal(probeErrorMessage(new Error("open C:\\Users\\victor\\secret failed")), "HTTP probe failed with an internal error.");
  assert.equal(probeErrorMessage(new Error("expected HTTP 200 from probe target, got 500")), "expected HTTP 200 from probe target, got 500");
});

test("HTTP probe rejects invalid UTF-8 response bodies deterministically", async () => {
  const response = new Response(new Uint8Array([0xff]));
  await assert.rejects(() => readBoundedResponseText(response, 8_192), /HTTP probe response is not valid UTF-8/);
});

test("HTTP probe response reader rejects malformed byte caps before reading", async () => {
  const response = new Response("ff transfer");

  await assert.rejects(
    () => readBoundedResponseText(response, Number.NaN),
    /Invalid HTTP probe response byte limit\./
  );
});

test("HTTP probe accepts bounded successful responses", async () => {
  const response = new Response("ff transfer");
  assert.equal(await readBoundedResponseText(response, 8_192), "ff transfer");
});

async function runProbe(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [probeScript.pathname], {
      env: { ...process.env, ...env },
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: 200_000
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
