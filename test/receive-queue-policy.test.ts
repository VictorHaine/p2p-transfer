import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliTransferSource = fs.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const distCliTransferSource = fs.readFileSync(new URL("../dist-node/cli/transfer.js", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("receiver transfer handlers serialize async control and bulk DataChannel work on one transfer queue", () => {
  for (const source of [cliTransferSource, webSource]) {
    assert.match(source, /let receiveQueue: Promise<void> = Promise\.resolve\(\)/);
    assert.match(source, /let queuedReceiveBytes = 0;/);
    assert.match(source, /let queuedReceiveMessages = 0;/);
    assert.match(source, /queuedReceiveBytes \+ byteLength > RECEIVE_QUEUE_MAX_BYTES \|\| queuedReceiveMessages \+ 1 > RECEIVE_QUEUE_MAX_MESSAGES/);
    assert.match(source, /new Error\("Receive queue backpressure exceeded\."\)/);
    assert.match(source, /receiveQueue = receiveQueue\.then\(runTask, runTask\)/);
    assert.match(source, /queuedReceiveBytes -= byteLength;/);
    assert.match(source, /queuedReceiveMessages -= 1;/);
    assert.match(source, /control\.onmessage = \(event\) => enqueueReceiveTask\(event\.data, \(\) => handleControlMessage\(event\.data\)\)/);
    assert.match(source, /bulk\.onmessage = \(event\) => enqueueReceiveTask\(event\.data, \(\) => handleBulkMessage\(event\.data\)\)/);
    assert.doesNotMatch(source, /let controlQueue: Promise<void>/);
    assert.doesNotMatch(source, /let bulkQueue: Promise<void>/);
  }
});

test("receiver transfer queue admission accounts for queued bytes and unsupported payloads", () => {
  assert.match(securityPolicy, /queued receiver DataChannel handlers must cap queued message count and queued byte length before entering the async transfer queue/);
  assert.match(cliTransferSource, /typeof data === "string"[\s\S]*Buffer\.byteLength\(data, "utf8"\)/);
  assert.match(webSource, /typeof data === "string"[\s\S]*new TextEncoder\(\)\.encode\(data\)\.byteLength/);
  for (const source of [cliTransferSource, webSource]) {
    assert.match(source, /function receiveQueueByteLength\(data: unknown\): number/);
    assert.match(source, /data instanceof ArrayBuffer && Object\.getPrototypeOf\(data\) === ArrayBuffer\.prototype[\s\S]*return data\.byteLength/);
    assert.match(source, /data instanceof Uint8Array && isCanonicalDataChannelBytes\(data\)[\s\S]*TYPED_ARRAY_BYTE_LENGTH_GETTER\?\.call\(data\)/);
    assert.doesNotMatch(source, /ArrayBuffer\.isView\(data\)/);
    assert.match(source, /data instanceof Blob[\s\S]*Number\.isFinite\(data\.size\) \? data\.size : RECEIVE_QUEUE_MAX_BYTES \+ 1/);
    assert.match(source, /return RECEIVE_QUEUE_MAX_BYTES \+ 1;/);
  }
});

test("queued receiver transfer handlers stop after completion", () => {
  assert.match(securityPolicy, /queued receiver DataChannel handlers must stop after transfer completion as well as failure/);
  for (const source of [cliTransferSource, webSource]) {
    const controlHandler = extractFunctionBody(source, "handleControlMessage");
    const bulkHandler = extractFunctionBody(source, "handleBulkMessage");
    assert.match(controlHandler, /if \(failed \|\| completed\) return;/);
    assert.match(bulkHandler, /if \(failed \|\| completed\) return;/);
    assert.doesNotMatch(controlHandler, /if \(failed\) return;/);
    assert.doesNotMatch(bulkHandler, /if \(failed\) return;/);
  }

  assert.match(distCliTransferSource, /const handleControlMessage = async \(data\) => \{\n\s+if \(failed \|\| completed\)\n\s+return;/);
  assert.match(distCliTransferSource, /const handleBulkMessage = async \(data\) => \{\n\s+if \(failed \|\| completed\)\n\s+return;/);
  assert.doesNotMatch(distCliTransferSource, /const handle(?:Control|Bulk)Message = async \(data\) => \{\n\s+if \(failed\)\n\s+return;/);
  assert.match(distWebBundle, /if\(!\(\w+\|\|\w+\)\)\{/);
  assert.match(distWebBundle, /handleBulkMessage|Unsupported chunk data|Unexpected Blob chunk/);
  assert.doesNotMatch(distWebBundle, /if\(!\w+\)\{\w+\(\);try\{/);
});

test("sender acknowledgement handlers serialize async control DataChannel work", () => {
  for (const source of [cliTransferSource, webSource]) {
    assert.match(source, /let senderControlQueue: Promise<void> = Promise\.resolve\(\)/);
    assert.match(source, /senderControlQueue = senderControlQueue\.then\(task, task\)/);
    assert.match(source, /control\.onmessage = async \(event\) => \{[\s\S]*enqueueSenderControl\(\(\) => handleSenderControl\(event\.data\)\)/);
  }
});

test("queued sender acknowledgement handlers stop after completion", () => {
  assert.match(securityPolicy, /queued sender acknowledgement handlers and channel-close handlers must stop after transfer completion/);
  for (const source of [cliTransferSource, webSource]) {
    const senderBody = extractFunctionBody(source, source === cliTransferSource ? "sendFiles" : "sendBrowserFiles", "async function");
    const failSenderBody = extractFunctionBody(source, "failSender");
    const senderHandlerBody = extractFunctionBody(source, "handleSenderControl");
    assert.match(senderBody, /let completed = false;/);
    assert.match(failSenderBody, /enqueueSenderControl\(async \(\) => \{[\s\S]*if \(completed\) return;[\s\S]*acks\.fail\(failed\);[\s\S]*\}\);/);
    assert.match(senderHandlerBody, /if \(completed\) return;[\s\S]*if \(!acks\.mark\("all-done-ok"\)\) throw new Error\("Unexpected all-done-ok acknowledgement\."\);\n\s+completed = true;[\s\S]*catch \(error\) \{[\s\S]*if \(completed\) return;/);
    assert.doesNotMatch(senderBody, /await acks\.wait\("all-done-ok"\);\n\s+completed = true;/);
  }

  assert.match(distCliTransferSource, /let completed = false;[\s\S]*const failSender = \(message\) => \{\n\s+enqueueSenderControl\(async \(\) => \{[\s\S]*if \(completed\)\n\s+return;[\s\S]*acks\.fail\(failed\);[\s\S]*const handleSenderControl = async \(data\) => \{\n\s+if \(completed\)\n\s+return;[\s\S]*if \(!acks\.mark\("all-done-ok"\)\)[\s\S]*throw new Error\("Unexpected all-done-ok acknowledgement\."\);\n\s+completed = true;[\s\S]*catch \(error\) \{\n\s+if \(completed\)\n\s+return;/);
  assert.doesNotMatch(distCliTransferSource, /await acks\.wait\("all-done-ok"\);\n\s+completed = true;/);
  assert.match(distWebBundle, /Unexpected all-done-ok acknowledgement/);
  assert.match(distWebBundle, /`all-done-ok`/);
  assert.match(distWebBundle, /\.fail\(/);
  assert.doesNotMatch(distWebBundle, /await \w+\.wait\(`all-done-ok`\),\w+=!0\}catch/);
});

function extractFunctionBody(source: string, name: string, declaration = "const"): string {
  const start = source.indexOf(declaration === "const" ? `const ${name} =` : `${declaration} ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing ${name} body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  assert.fail(`unterminated ${name}`);
}

function readDistWebBundle(): string {
  const distDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleName = fs.readdirSync(distDir).find((entry) => /^index-.*\.js$/.test(entry));
  assert.ok(bundleName);
  return fs.readFileSync(new URL(bundleName, distDir), "utf8");
}
