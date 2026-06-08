import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const cliTransferSource = fs.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
const cliFilesSource = fs.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const webFileSystemSource = fs.readFileSync(new URL("../src/web/file-system.ts", import.meta.url), "utf8");
const publicManifestSource = fs.readFileSync(new URL("../src/shared/public-manifest.ts", import.meta.url), "utf8");
const distPublicManifestSource = fs.readFileSync(new URL("../dist-node/shared/public-manifest.js", import.meta.url), "utf8");
const sharedTransferSource = fs.readFileSync(new URL("../src/shared/transfer.ts", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("server logging stays operational and does not log signaling payload fields", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const logCalls = [...serverSource.matchAll(/console\.(?:log|error|warn)\(([^)]*)\)/g)].map((match) => match[1] ?? "");
  assert.equal(logCalls.length, 4);
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\b(?:message|payload|manifest|sealedManifest|pake|tag|sdp|candidate|code|sid|reason|peer|ip)\b/i);
  }
  assert.match(securityPolicy, /server operational logs must not include signaling payloads, receiver codes, session ids, peer identifiers, peer IPs, arbitrary exception messages, raw configuration values, raw static-root paths, bind addresses, bind ports, or stack traces/);
  assert.match(serverSource, /writeSync\(2, `ff signaling server startup failed: \$\{scope\} \$\{startupErrorSummary\(error\)\}\\n`\)/);
  const startupSummaryBody = extractFunctionBody(serverSource, "startupErrorSummary");
  assert.match(startupSummaryBody, /ownErrorData\(error, "code"\)/);
  assert.match(startupSummaryBody, /ownErrorData\(error, "message"\)/);
  assert.doesNotMatch(startupSummaryBody, /error\.message|error\.stack|String\(error\)|String\(/);
  const summaryBody = extractFunctionBody(serverSource, "operationalErrorSummary");
  assert.match(summaryBody, /ownErrorData\(error, "code"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "syscall"\)/);
  assert.doesNotMatch(summaryBody, /ownErrorData\(error, "address"\)/);
  assert.doesNotMatch(summaryBody, /ownErrorData\(error, "port"\)/);
  assert.match(summaryBody, /ownErrorData\(error, "name"\)/);
  assert.doesNotMatch(summaryBody, /error\.message|error\.stack|String\(error\)|String\(/);
  assert.match(serverSource, /function ownErrorData\(error: unknown, key: string\): unknown \{[\s\S]*Object\.getOwnPropertyDescriptor\(error, key\)/);
  assert.match(securityPolicy, /conforming clients must never send the signaling server/);
  assert.match(securityPolicy, /server must reject unredacted public pair-request manifests from modified clients without forwarding or logging them/);
  assert.doesNotMatch(securityPolicy, /signaling server never receives the two secret words[\s\S]*plaintext file names/);
  assert.match(readme, /A modified client can still transmit a malformed public pair-request containing plaintext metadata before rejection/);
  assert.match(readme, /server rejects unredacted public manifests and does not forward or log them/);
  assert.match(readme, /from conforming clients and accepted protocol flow: two secret words, PAKE output, plaintext file names, MIME types/);
  assert.match(readme, /public WebRTC signal kinds, sealed frame sizes, timing, byte volume, and traffic shape/);
  assert.match(readme, /SDP contents, ICE candidate contents/);
  assert.match(readme, /traffic shape/);
  assert.match(readme, /absence of padding or cover traffic/);
  assert.match(readme, /Managed endpoint \/ MDM \/ EDR/);
  assert.match(readme, /cryptography does not hide local endpoint activity from a privileged endpoint monitor/);
  assert.match(readme, /Relay-only ICE reduces direct peer IP exposure to the other peer, but it shifts traffic metadata to the TURN operator/);
  assert.doesNotMatch(readme, /It does not receive the two secret words[\s\S]*MIME types/);
});

test("server websocket close frames do not expose internal teardown reasons", () => {
  const closeWithCodeBody = extractFunctionBody(serverSource, "closePeerWithCode");
  const wireReasonBody = extractFunctionBody(serverSource, "wireCloseReason");
  const notifyPeerLeftBody = extractFunctionBody(serverSource, "notifyPeerLeft");
  const peerLeftReasonBody = extractFunctionBody(serverSource, "peerLeftReason");
  assert.match(closeWithCodeBody, /peer\.ws\.close\(code, websocketCloseReason\(wireCloseReason\(code, reason\)\)\)/);
  assert.match(wireReasonBody, /if \(code === 1001\) return "server shutdown"/);
  assert.match(wireReasonBody, /if \(code === 1008\) return "policy violation"/);
  assert.match(wireReasonBody, /return "closed"/);
  assert.doesNotMatch(wireReasonBody, /return _?reason/);
  assert.match(notifyPeerLeftBody, /reason: peerLeftReason\(reason\)/);
  assert.match(peerLeftReasonBody, /if \(reason === "complete"\) return "complete"/);
  assert.match(peerLeftReasonBody, /if \(reason === "cancelled"\) return "cancelled"/);
  assert.match(peerLeftReasonBody, /if \(reason === "bye"\) return "bye"/);
  assert.match(peerLeftReasonBody, /return "closed"/);
  assert.doesNotMatch(peerLeftReasonBody, /return reason/);
  assert.match(securityPolicy, /server-initiated WebSocket close frames and `peer-left` messages must map internal teardown reasons to a fixed close-text vocabulary/);
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

test("clients derive constant public redacted manifests from descriptor-walked position only", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /client public manifest redaction must walk manifest fields and file entries through own data descriptors/);
  assert.match(securityPolicy, /client public manifest redaction must use a constant maximum-shape synthetic manifest/);
  assert.match(cliSource, /redactManifestForSignaling\(manifest\)/);
  assert.match(webSource, /redactManifestForSignaling\(manifest\)/);
  for (const source of [publicManifestSource, distPublicManifestSource]) {
    const redaction = extractFunctionBody(source, "redactManifestForSignaling");
    assert.match(redaction, /const files = ownDataValue\(manifest, "files"\)/);
    assert.match(redaction, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
    assert.match(redaction, /return constantPublicManifest\(\)/);
    assert.match(source, /for \(let index = 0; index < MAX_FILES_PER_SESSION; index \+= 1\)/);
    assert.match(source, /files\.push\(\{ id: index, name: `encrypted-\$\{index\}`, size: MAX_FILE_BYTES \}\)/);
    assert.doesNotMatch(redaction, /manifest\.files|manifest\.fileCount|manifest\.totalBytes|\.map\(/);
    assert.doesNotMatch(redaction, /id: file\.id|file\.name|file\.mime/);
    assert.doesNotMatch(redaction, /size: size|size \}/);
    assert.doesNotMatch(redaction, /mime/);
    assert.doesNotMatch(source, /function publicFileCountBucket/);
    assert.doesNotMatch(source, /function publicTotalBytesBucket/);
    assert.doesNotMatch(source, /Math\.log2\(totalBytes\)/);
  }
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
  assert.match(securityPolicy, /CLI `--redact-output` must remove transfer codes, rendezvous prefixes, SAS values, file names, MIME types, exact file counts, per-file placeholder counts, and byte counts from CLI JSON, human transfer output, and error output/);
  assert.match(securityPolicy, /only a local CLI output policy and must not be documented as protection from signaling\/server metadata, peer-visible metadata, endpoint telemetry, ICE candidates, timing, traffic shape, or other network observers/);
  assert.match(securityPolicy, /CLI error output must redact quoted and unquoted absolute local filesystem paths/);
  assert.match(cliSource, /--redact-output", "redact transfer codes, SAS, file metadata, and byte counts from CLI output, JSON events, and error text"/);
  for (const source of [cliSource, distCliSource]) {
    const printErrorBody = extractFunctionBody(source, "printError");
    assert.match(printErrorBody, /options\.redactOutput \? redactedErrorMessage\(code\) : redactConfiguredServerEvidence\(redactCliErrorEvidence\(safeErrorMessage\(error\)\), options\)/);
    assert.equal(printErrorBody.indexOf("redactedErrorMessage(code)") < printErrorBody.indexOf("sanitizeStructuredOutput"), true);
    const redactedErrorBody = extractFunctionBody(source, "redactedErrorMessage");
    assert.match(redactedErrorBody, /Command failed\. Re-run without --redact-output for details\./);
    assert.doesNotMatch(redactedErrorBody, /safeErrorMessage|redactCliErrorEvidence|redactLocalPathEvidence|formatBytes|error\.message|file\.name|state\.name/);
  }
});

test("README documents endpoint-visible local path and browser filename limits", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /`--files-stdin` protects the `ff` process argv only/);
  assert.match(readme, /command that produces the file list can still leak local paths/);
  assert.match(readme, /`--require-private-input` makes argv fallback a command error/);
  assert.match(readme, /does not hide paths from the command that enumerates them or from local file-open telemetry/);
  assert.match(readme, /`Folder only` protects streaming behavior and partial-overwrite handling/);
  assert.match(readme, /Use browser `Opaque output names` as well when final browser output names must not include the sanitized original basename/);
  assert.match(readme, /browser DOM previews, browser download behavior, final output names/);
});

test("browser clears sensitive DOM transfer metadata after operations", () => {
  assert.match(webSource, /function clearBrowserSendSecrets\(\): void \{[\s\S]*clearBrowserSendInputs\(\);\n\s+sendLog\.textContent = "";/);
  assert.match(webSource, /function clearBrowserSendInputs\(\): void \{[\s\S]*clearBrowserSendCode\(\);\n\s+fileInput\.value = "";/);
  assert.match(webSource, /function clearBrowserSendCode\(\): void \{[\s\S]*sendCode\.value = "";/);
  assert.match(webSource, /function clearBrowserReceiveSecrets\(\): void \{[\s\S]*codeBox\.textContent = "";\n\s+codeBox\.hidden = true;\n\s+clearBrowserPairRequest\(\);/);
  assert.match(webSource, /function clearBrowserPairRequest\(\): void \{[\s\S]*requestBox\.replaceChildren\(\);\n\s+requestBox\.hidden = true;/);
  assert.match(webSource, /sendFromBrowser\(\)[\s\S]*\.finally\(\(\) => \{[\s\S]*clearBrowserSendInputs\(\);[\s\S]*sendBusy = false;/);
  assert.match(webSource, /sendFromBrowser\(\)[\s\S]*finally \{[\s\S]*clearBrowserSendSecrets\(\);[\s\S]*\}/);
  assert.match(webSource, /receiveInBrowser\(\)[\s\S]*finally \{[\s\S]*clearBrowserReceiveSecrets\(\);[\s\S]*\}/);
});

test("browser persistent error logs do not interpolate selected or peer file names", () => {
  assert.match(securityPolicy, /browser top-level send and receive error logs must not persist selected local filenames, peer-supplied filenames, browser output names, or browser partial names/);
  assert.match(webSource, /throw new Error\("Selected file changed while sending\."\)/);
  assert.match(webSource, /throw new Error\("Selected file changed while preparing the transfer\."\)/);
  assert.match(webSource, /throw new Error\("Selected file changed while reading\."\)/);
  assert.match(webSource, /setLog\(sendLog, topLevelBrowserErrorMessage\(error, "send"\)\)/);
  assert.match(webSource, /setLog\(recvLog, topLevelBrowserErrorMessage\(error, "receive"\)\)/);
  assert.match(webSource, /function topLevelBrowserErrorMessage\(error: unknown, operation: "send" \| "receive"\): string/);
  assert.match(webSource, /function isBrowserNativeError\(error: unknown\): boolean \{[\s\S]*return typeof DOMException !== "undefined" && error instanceof DOMException;/);
  assert.match(webSource, /function containsPathLikeText\(value: string\): boolean/);
  assert.match(webSource, /throw new Error\(`Invalid resume offset for file \$\{plan\.id\}\.`\)/);
  assert.match(webSource, /throw new Error\(`Hash mismatch for file \$\{state\.id\}\.`\)/);
  assert.match(webSource, /throw new Error\("Missing browser partial file handle\."\)/);
  assert.match(webSource, /throw new Error\("Written file size mismatch\."\)/);
  assert.match(webSource, /throw new Error\("Written file hash mismatch\."\)/);
  assert.match(webFileSystemSource, /Could not reserve a browser output name after \$\{MAX_OUTPUT_NAME_ATTEMPTS\} attempts/);
  assert.match(webFileSystemSource, /Could not create a browser output file after \$\{MAX_OUTPUT_NAME_ATTEMPTS\} attempts/);
  assert.doesNotMatch(webSource, /throw new Error\(`[^`]*\$\{(?:plan|file|state)\.name/);
  assert.doesNotMatch(webSource, /throw new Error\(`[^`]*(?:changed|partial)[^`]*\$\{label\}/);
  assert.doesNotMatch(webSource, /changed before chunk \$\{seq\}/);
  assert.doesNotMatch(webSource, /Written file (?:size|hash) mismatch for \$\{name\}/);
  assert.doesNotMatch(webSource, /Could not read resumed partial for \$\{label\}/);
  assert.doesNotMatch(webFileSystemSource, /browser output (?:name|file) for \$\{name\}/);
});

test("CLI opaque output names avoid peer basenames in final receive paths", () => {
  const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(securityPolicy, /`recv --opaque-output-names` must publish final CLI receive paths as `ff-<token>` names/);
  assert.match(securityPolicy, /stable per-output-directory HMAC-derived opaque names instead of peer-supplied basenames/);
  assert.match(readme, /`recv --opaque-output-names`: publish received files as `ff-<token>` names instead of peer-supplied basenames/);
  assert.match(readme, /avoids peer basenames in final CLI receive paths/);
  assert.match(cliSource, /\.option\("--opaque-output-names", "write received files to opaque ff-<token> names instead of peer-supplied basenames"\)/);
  assert.match(cliSource, /Boolean\(options\.opaqueOutputNames\)/);
  assert.match(cliTransferSource, /opaqueName: opaqueOutputNames/);
  assert.match(cliFilesSource, /async function opaqueOutputFileName\(outputDir: string, name: string, size: number \| undefined\)/);
  assert.match(cliFilesSource, /return `ff-\$\{randomBytes\(PART_FILE_TOKEN_HEX_CHARS \/ 2\)\.toString\("hex"\)\}`/);
  assert.match(cliFilesSource, /createHmac\("sha256", secret\)\.update\("ff-output-v1\\0"\)\.update\(name\)\.update\("\\0"\)\.update\(String\(size\)\)\.digest\("hex"\)\.slice\(0, PART_FILE_TOKEN_HEX_CHARS\)/);
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
