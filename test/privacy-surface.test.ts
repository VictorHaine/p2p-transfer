import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const cliTransferSource = fs.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const sharedTransferSource = fs.readFileSync(new URL("../src/shared/transfer.ts", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("server logging stays operational and does not log signaling payload fields", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  const logCalls = [...serverSource.matchAll(/console\.(?:log|error|warn)\(([^)]*)\)/g)].map((match) => match[1] ?? "");
  assert.equal(logCalls.length, 4);
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\b(?:message|payload|manifest|sealedManifest|pake|tag|sdp|candidate|code|sid|reason|peer|ip)\b/i);
  }
  assert.match(securityPolicy, /server operational logs must not include signaling payloads, receiver codes, session ids, peer identifiers, peer IPs, arbitrary exception messages, or stack traces/);
  const summaryBody = extractFunctionBody(serverSource, "operationalErrorSummary");
  assert.match(summaryBody, /ownErrorData\(error, "code"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "syscall"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "address"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "port"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "name"\)/);
  assert.doesNotMatch(summaryBody, /error\.message|error\.stack|String\(error\)|String\(/);
  assert.match(serverSource, /function ownErrorData\(error: unknown, key: string\): unknown \{[\s\S]*Object\.getOwnPropertyDescriptor\(error, key\)/);
});

test("honest clients do not send raw local exception messages through signaling bye reasons", () => {
  for (const source of [cliSource, webSource]) {
    assert.doesNotMatch(source, /reason:\s*error\s+instanceof\s+Error\s+\?\s+error\.message/);
    assert.doesNotMatch(source, /reason:\s*.*\.message/);
  }
  assert.match(cliSource, /reason:\s*"signal_error"/);
  assert.match(webSource, /reason:\s*"signal_error"/);
});

test("server does not relay arbitrary client bye reasons to peers", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /must not relay arbitrary peer-controlled disconnect text/);
  const handleBody = extractFunctionBody(serverSource, "handleMessage");
  const reasonBody = extractFunctionBody(serverSource, "peerVisibleByeReason");
  assert.match(handleBody, /cleanupPeer\(peer, peerVisibleByeReason\(message\.reason\)\)/);
  assert.doesNotMatch(handleBody, /cleanupPeer\(peer, message\.reason/);
  assert.match(reasonBody, /if \(reason === "complete"\) return "complete"/);
  assert.match(reasonBody, /if \(reason === "cancelled"\) return "cancelled"/);
  assert.match(reasonBody, /return "bye"/);
  assert.doesNotMatch(reasonBody, /return reason/);
});

test("clients derive public redacted manifest ids from descriptor-walked position only", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /client public manifest redaction must walk manifest fields and file entries through own data descriptors/);
  assert.match(securityPolicy, /client public manifest redaction must use synthetic per-file sizes/);
  for (const source of [cliSource, webSource]) {
    const redaction = extractFunctionBody(source, "redactManifest");
    assert.match(redaction, /const files = ownDataValue\(manifest, "files"\)/);
    assert.match(redaction, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
    assert.match(redaction, /const redactedSize = Math\.min\(remainingBytes, MAX_FILE_BYTES\)/);
    assert.match(redaction, /redactedFiles\.push\(\{ id: index, name: `encrypted-\$\{index\}`, size: redactedSize \}\)/);
    assert.doesNotMatch(redaction, /manifest\.files|manifest\.fileCount|manifest\.totalBytes|\.map\(/);
    assert.doesNotMatch(redaction, /id: file\.id|file\.name|file\.mime/);
    assert.doesNotMatch(redaction, /size: size|size \}/);
    assert.match(redaction, /name: `encrypted-\$\{index\}`/);
    assert.doesNotMatch(redaction, /mime/);
  }
  const distRedaction = extractFunctionBody(distCliSource, "redactManifest");
  assert.match(distRedaction, /const files = ownDataValue\(manifest, "files"\)/);
  assert.match(distRedaction, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
  assert.doesNotMatch(distRedaction, /manifest\.files|manifest\.fileCount|manifest\.totalBytes|\.map\(/);
  assert.doesNotMatch(distRedaction, /size: size|size \}/);
  assert.match(distWebBundle, /encrypted-\$\{\w+\}/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+,String\(\w+\)\)/);
  assert.doesNotMatch(distWebBundle, /e\.files\.map\(\(e,t\)=>\(\{id:t,name:`encrypted-\$\{t\}`,size:e\.size\}\)\)/);
});

test("CLI transfer progress sanitizes labels at the output sink", () => {
  const printProgressBody = extractFunctionBody(cliTransferSource, "printProgress");
  assert.match(printProgressBody, /const safeLabel = progress\.redactOutput && label !== "complete" \? "\[redacted\]" : sanitizeDisplayText\(label\)/);
  assert.match(printProgressBody, /const event = progress\.redactOutput \? \{ event: action, label: safeLabel \} : \{ event: action, label: safeLabel, bytes: progress\.transferredBytes, totalBytes: progress\.totalBytes \}/);
  assert.match(printProgressBody, /if \(progress\.redactOutput\) \{[\s\S]*if \(force\) process\.stdout\.write\(`\\n\$\{action\} \$\{safeLabel\}\\n`\);[\s\S]*return;[\s\S]*\}/);
  assert.match(printProgressBody, /\$\{safeLabel\}: \$\{formatBytes\(progress\.transferredBytes\)\} total/);
  assert.doesNotMatch(printProgressBody, /JSON\.stringify\(\{ event: action, label,/);
});

test("CLI redacted error output does not render transfer exception metadata", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /CLI `--redact-output` must remove file names, MIME types, and byte counts from CLI JSON, human transfer output, and error output/);
  for (const source of [cliSource, distCliSource]) {
    const printErrorBody = extractFunctionBody(source, "printError");
    assert.match(printErrorBody, /options\.redactOutput \? redactedErrorMessage\(code\) : redactLocalPathEvidence\(safeErrorMessage\(error\)\)/);
    assert.equal(printErrorBody.indexOf("redactedErrorMessage(code)") < printErrorBody.indexOf("sanitizeStructuredOutput"), true);
    const redactedErrorBody = extractFunctionBody(source, "redactedErrorMessage");
    assert.match(redactedErrorBody, /Command failed\. Re-run without --redact-output for details\./);
    assert.doesNotMatch(redactedErrorBody, /safeErrorMessage|redactLocalPathEvidence|formatBytes|error\.message|file\.name|state\.name/);
  }
});

test("remote encrypted abort reasons are not promoted to local user-facing errors", () => {
  assert.match(sharedTransferSource, /export const REMOTE_ABORT_MESSAGE = "Peer aborted the transfer\."/);
  for (const source of [cliTransferSource, webSource]) {
    assert.match(source, /remoteAbortError\(\)/);
    assert.doesNotMatch(source, /new Error\(message\.reason\)/);
    assert.doesNotMatch(source, /throw new Error\(message\.reason\)/);
    assert.doesNotMatch(source, /failed = new Error\(message\.reason\)/);
  }
});

test("local encrypted abort notifications do not disclose exception text to peers", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /DataChannel abort notifications must not include local exception text/);
  assert.match(sharedTransferSource, /function abortControlMessage\(_reason: unknown\):[\s\S]*reason: LOCAL_ABORT_MESSAGE/);
  assert.doesNotMatch(sharedTransferSource, /reason instanceof Error|String\(reason\)|reason\.message|sanitizeReason|reasonToString/);
});

test("clients map untrusted signaling server error text to local messages", () => {
  assert.match(cliSource, /new SignalingError\(message\.code\)/);
  assert.doesNotMatch(cliSource, /new SignalingError\(message\.code, message\.message\)/);
  assert.doesNotMatch(cliSource, /new Error\(message\.message\)/);
  assert.match(webSource, /new BrowserSignalingError\(message\.code\)/);
  assert.doesNotMatch(webSource, /new BrowserSignalingError\(message\.code, message\.message\)/);
});

test("browser signaling error rendering does not read hostile message accessors", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /CLI and browser error classification and error rendering must read error messages through data descriptors/);
  const emitBody = extractMethodBody(webSource, "emit");
  assert.match(emitBody, /message: safeErrorMessage\(error\)/);
  assert.doesNotMatch(emitBody, /error instanceof Error \? error\.message/);
  assert.match(webSource, /function ownStringDataProperty/);
  assert.match(webSource, /Object\.getOwnPropertyDescriptor\(current, key\)/);
  assert.match(distWebBundle, /message:[$\w]+\(e\)/);
  assert.doesNotMatch(distWebBundle, /message:e instanceof Error\?e\.message/);
  assert.match(distWebBundle, /Object\.getOwnPropertyDescriptor\(\w+,t\)/);
});

test("CLI post-accept ICE fallback does not classify by error message accessors", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /CLI and browser error classification and error rendering must read error messages through data descriptors/);
  const sourceBody = extractFunctionBody(cliSource, "getIceServersAfterAccept");
  const distBody = extractFunctionBody(distCliSource, "getIceServersAfterAccept");
  assert.match(cliSource, /SignalingWaitTimeoutError/);
  assert.match(sourceBody, /error instanceof SignalingWaitTimeoutError && error\.type === "ice-config"/);
  assert.doesNotMatch(sourceBody, /error\.message/);
  assert.match(distCliSource, /SignalingWaitTimeoutError/);
  assert.match(distBody, /error instanceof SignalingWaitTimeoutError && error\.type === "ice-config"/);
  assert.doesNotMatch(distBody, /error\.message/);
});

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not extract ${name} body.`);
}

function extractMethodBody(source: string, name: string): string {
  const signature = `private ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`Could not extract ${name} body.`);
}

function readDistWebBundle(): string {
  const assetsDir = new URL("../dist-web/assets/", import.meta.url);
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
