import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const cliErrorRedactionSource = fs.readFileSync(new URL("../src/cli/error-redaction.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const cliFilesSource = fs.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const distCliFilesSource = fs.readFileSync(new URL("../dist-node/cli/files.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const cliEntrypoint = fileURLToPath(new URL("../dist-node/cli/index.js", import.meta.url));

test("CLI json mode emits structured sanitized error events instead of plain stderr", () => {
  assert.match(cliSource, /return runWithExit\(\(\) => recv\(merged\), merged\)/);
  assert.match(cliSource, /const inputs = await resolveSendInputs\(code, files, merged\)/);
  assert.match(cliSource, /return send\(normalizeCode\(inputs\.code\), inputs\.files, merged\)/);
  assert.match(cliSource, /function printError\(options: CommonOptions, error: unknown, code: number\): void \{/);
  assert.match(cliSource, /options\.redactOutput \? redactedErrorMessage\(code\) : redactLocalPathEvidence\(safeErrorMessage\(error\)\)/);
  assert.match(cliSource, /if \(options\.json\) \{[\s\S]*console\.error\(JSON\.stringify\(sanitizeStructuredOutput\(\{ event: "error", code, message \}\)\)\);/);
  assert.match(cliSource, /console\.error\(message\);/);
});

test("CLI redacted output mode removes file metadata from JSON and progress events", () => {
  assert.match(securityPolicy, /CLI `--redact-output` must remove transfer codes, rendezvous prefixes, SAS values, file names, MIME types, exact file counts, per-file placeholder counts, and byte counts from CLI JSON, human transfer output, and error output/);
  assert.match(readme, /`--redact-output`: redact transfer codes, SAS, file names, MIME types, file counts, byte counts, and per-file placeholders from local CLI output, JSON events, and error text/);
  assert.match(readme, /It does not hide signaling\/server metadata, peer-visible metadata, endpoint telemetry, ICE candidates, timing, or traffic shape/);
  assert.match(readme, /CLI output is metadata-bearing by default for consent, progress, and detailed failures/);
  assert.match(cliSource, /\.option\("--redact-output", "redact transfer codes, SAS, file metadata, and byte counts from CLI output, JSON events, and error text"\)/);
  assert.match(cliSource, /options\.redactOutput \? \{ event: "pair_requested", manifestRedacted: true \} : \{ event: "pair_requested", sid: joined\.sid, files: manifest\.fileCount, totalBytes: manifest\.totalBytes \}/);
  assert.match(cliSource, /options\.redactOutput \? "Waiting for receiver to accept transfer\. SAS \[redacted\]" : `Waiting for receiver to accept \$\{manifest\.fileCount\} file\(s\), \$\{formatBytes\(manifest\.totalBytes\)\}\. SAS \$\{keys\.sas\}`/);
  assert.match(cliSource, /options\.redactOutput \? \{ event: "pair_request", manifestRedacted: true, sasRedacted: true \} : \{ event: "pair_request", files: manifest\.files, totalBytes: manifest\.totalBytes \}/);
  assert.match(cliSource, /options\.redactOutput \? "Incoming transfer\. SAS \[redacted\]" : `Incoming transfer: \$\{manifest\.fileCount\} file\(s\), \$\{formatBytes\(manifest\.totalBytes\)\}\. SAS \$\{sas\}`/);
  assert.match(cliSource, /if \(options\.redactOutput\) console\.log\("  - \[redacted file list\]"\)/);
  assert.doesNotMatch(cliSource, /options\.redactOutput \? \{ event: "pair_requested", sid: joined\.sid, fileCount: manifest\.fileCount \}/);
  assert.doesNotMatch(cliSource, /options\.redactOutput \? \{ event: "pair_request", fileCount: manifest\.fileCount \}/);
  assert.doesNotMatch(cliSource, /options\.redactOutput \? `(?:Waiting|Incoming)[^`]*\$\{manifest\.fileCount\}[^`]*SAS \$\{(?:keys\.sas|sas)\}`/);
  assert.match(cliSource, /sendFiles\(control, bulk, keys, files, options\.json, options\.quiet, Boolean\(options\.redactOutput\)\)/);
  assert.match(cliSource, /Boolean\(options\.opaqueOutputNames\)/);
  for (const source of [cliSource, distCliSource]) {
    const printError = extractFunctionBody(source, "printError");
    assert.match(printError, /redactedErrorMessage\(code\)/);
    assert.match(printError, /redactLocalPathEvidence\(safeErrorMessage\(error\)\)/);
    assert.equal(printError.indexOf("redactedErrorMessage(code)") < printError.indexOf("JSON.stringify"), true);
    const redactedError = extractFunctionBody(source, "redactedErrorMessage");
    assert.match(redactedError, /Command failed\. Re-run without --redact-output for details\./);
    assert.doesNotMatch(redactedError, /safeErrorMessage|error|message|path|file|label|formatBytes/);
  }
});

test("CLI redacted JSON errors do not render local file metadata", () => {
  const secretPath = path.join(os.tmpdir(), `ff-secret-${Date.now()}-private-name.txt`);
  const result = spawnSync(process.execPath, [cliEntrypoint, "--json", "--redact-output", "send", "12345678-apple-anchor", secretPath], {
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /private-name|ff-secret|12345678-apple-anchor|apple-anchor/);
  const event = JSON.parse(result.stderr.trim()) as { event?: unknown; message?: unknown };
  assert.equal(event.event, "error");
  assert.equal(event.message, "Command failed. Re-run without --redact-output for details.");
});

test("CLI exit handling does not truncate piped output with direct process.exit", () => {
  assert.match(securityPolicy, /CLI entrypoints must set `process\.exitCode` after printing output/);
  for (const source of [cliSource, distCliSource]) {
    const runWithExit = extractFunctionBody(source, "runWithExit");
    assert.match(runWithExit, /process\.exitCode = 0/);
    assert.match(runWithExit, /process\.exitCode = code/);
    assert.doesNotMatch(runWithExit, /process\.exit\(/);
  }
});

test("CLI receive validates supplied codes before filesystem or signaling side effects", () => {
  assert.match(securityPolicy, /CLI receive codes supplied with `recv --code` must be validated before output-directory creation or signaling connection setup/);
  assert.match(securityPolicy, /CLI send and receive commands must verify the reviewed runtime cryptographic dependency graph before importing CLI modules that load CPace or noble-hashes code, opening local send files, creating receive output directories, or connecting to signaling/);
  assert.match(securityPolicy, /interactive receive flows must emit a generic no-values warning to human stderr when `recv --code` accepts a supplied receive code from argv unless JSON or quiet output is selected/);
  for (const source of [cliSource, distCliSource]) {
    const recvBody = extractFunctionBody(source, "recv");
    assert.match(recvBody, /const suppliedCode = await resolveRecvCode\(options\)/);
    assert.match(recvBody, /const runtime = await reviewedCliRuntime\(\)/);
    assert.equal(recvBody.indexOf("resolveRecvCode(options)") < recvBody.indexOf("ensureOutputDir(options.out)"), true);
    assert.equal(recvBody.indexOf("reviewedCliRuntime()") < recvBody.indexOf("ensureOutputDir(options.out)"), true);
    assert.equal(recvBody.indexOf("resolveRecvCode(options)") < recvBody.indexOf("openSignaling(options.server)"), true);
    assert.equal(recvBody.indexOf("reviewedCliRuntime()") < recvBody.indexOf("openSignaling(options.server)"), true);
    assert.match(recvBody, /registerReceiver\(signaling, suppliedCode\)/);
    assert.match(source, /assertReviewedCryptoDependencies\(\);\s*reviewedCliRuntimePromise = Promise\.all\(\[import\("\.\.\/shared\/security\.js"\), import\("\.\/rtc\.js"\), import\("\.\/secure\.js"\), import\("\.\/transfer\.js"\)\]\)/);
    assert.doesNotMatch(source, /import \{[^}]+(?:openManifest|sealManifest|wipeSessionKeys)[^}]+from "\.\.\/shared\/security\.js"/);
    assert.doesNotMatch(source, /import \{[^}]+(?:createPeer|handleSignal)[^}]+from "\.\/rtc\.js"/);

    assert.match(source, /function resolveRecvCode/);
    assert.match(source, /if \(options\.code !== undefined\) \{[\s\S]*rejectSensitiveRecvArgv\(options\);[\s\S]*warnSensitiveRecvArgv\(options\);[\s\S]*\}/);
    assert.match(source, /parseRequiredCode\(normalizeCode\(code\)\)/);
    assert.match(source, /supplied: true/);
    assert.match(source, /function registerReceiver[\s\S]*const parsedCode = suppliedCode\?\.parsedCode \?\? parseRequiredCode\(normalizeCode\(generateCode\(\)\)\)/);
    assert.match(source, /const attempts = suppliedCode \? 1 : RECEIVE_CODE_GENERATION_ATTEMPTS/);
    assert.doesNotMatch(source, /parseRequiredCode\(normalizeCode\(options\.code \?\? generateCode\(\)\)\)/);
  }
});

test("CLI send supports non-argv code and file path input", () => {
  assert.match(securityPolicy, /CLI senders must support piped stdin or environment-variable receive-code input and newline-delimited stdin file lists/);
  assert.match(securityPolicy, /interactive send flows must emit a generic no-values warning to human stderr whenever a receive code or local file path is still accepted from argv unless JSON or quiet output is selected/);
  assert.match(securityPolicy, /interactive receive flows must emit a generic no-values warning to human stderr when `recv --code` accepts a supplied receive code from argv unless JSON or quiet output is selected/);
  for (const source of [cliSource, distCliSource]) {
    const sendBody = extractFunctionBody(source, "send");
    assert.match(sendBody, /const parsedCode = parseRequiredCode\(code\)/);
    assert.match(sendBody, /const runtime = await reviewedCliRuntime\(\)/);
    assert.equal(sendBody.indexOf("parseRequiredCode(code)") < sendBody.indexOf("reviewedCliRuntime()"), true);
    assert.equal(sendBody.indexOf("reviewedCliRuntime()") < sendBody.indexOf("buildManifest(paths)"), true);
    assert.equal(sendBody.indexOf("reviewedCliRuntime()") < sendBody.indexOf("openSignaling(options.server)"), true);
    assert.match(source, /process\.title = "ff"/);
    assert.match(source, /\.option\("--out <dir>", "output directory"\)/);
    assert.match(source, /out: options\.out \?\? process\.cwd\(\)/);
    assert.doesNotMatch(source, /\.option\("--out <dir>", "output directory", process\.cwd\(\)\)/);
    assert.match(source, /\.option\("--code-stdin"/);
    assert.match(source, /\.option\("--code-env <name>"/);
    assert.match(source, /\.option\("--files-stdin"/);
    assert.match(source, /\.option\("--require-private-input", "reject receive codes and send code\/file paths supplied through argv"\)/);
    assert.match(source, /const CLI_STDIN_MAX_BYTES = 512 \* 1024/);
    assert.match(source, /const ENV_NAME_PATTERN = \/\^\[A-Za-z_\]/);
    assert.match(source, /function resolveSendInputs/);
    assert.match(source, /const SEND_ARGV_TELEMETRY_WARNING = "Warning: receiver codes or local file paths passed as arguments can be captured by shell history, process lists, or endpoint telemetry\. Use --code-stdin\/--code-env and --files-stdin for private input\."/);
    assert.match(source, /const RECV_ARGV_TELEMETRY_WARNING = "Warning: receive codes passed as arguments can be captured by shell history, process lists, or endpoint telemetry\. Use --code-stdin\/--code-env for private input\."/);
    assert.match(source, /warnSensitiveSendArgv\(options\);[\s\S]*return \{ code, files \};/);
    assert.match(source, /const codeFromArgv = !options\.codeStdin && options\.codeEnv === undefined && code !== undefined && code !== "-"/);
    assert.match(source, /const filesFromArgv = !options\.filesStdin && resolvedFiles\.length > 0/);
    assert.match(source, /if \(codeFromArgv \|\| filesFromArgv\) \{[\s\S]*rejectSensitiveSendArgv\(options, codeFromArgv, filesFromArgv\);[\s\S]*warnSensitiveSendArgv\(options\);[\s\S]*\}/);
    assert.match(source, /function rejectSensitiveSendArgv/);
    assert.match(source, /Receiver code and file path argv are disabled by --require-private-input/);
    assert.match(source, /File path argv is disabled by --require-private-input/);
    assert.match(source, /function rejectSensitiveRecvArgv/);
    assert.match(source, /Receive code argv is disabled by --require-private-input/);
    const warningBody = extractFunctionBody(source, "warnSensitiveSendArgv");
    assert.match(warningBody, /options\.json \|\| options\.quiet \|\| stderr\.isTTY !== true/);
    assert.match(warningBody, /console\.error\(sanitizeDisplayText\(SEND_ARGV_TELEMETRY_WARNING\)\)/);
    assert.doesNotMatch(warningBody, /\bcode\b|\bfiles\b|process\.argv|safeErrorMessage|formatBytes/);
    const recvWarningBody = extractFunctionBody(source, "warnSensitiveRecvArgv");
    assert.match(recvWarningBody, /options\.json \|\| options\.quiet \|\| stderr\.isTTY !== true/);
    assert.match(recvWarningBody, /console\.error\(sanitizeDisplayText\(RECV_ARGV_TELEMETRY_WARNING\)\)/);
    assert.doesNotMatch(recvWarningBody, /\bcode\b|\bfiles\b|process\.argv|safeErrorMessage|formatBytes/);
    assert.match(source, /function readCodeEnv/);
    assert.match(source, /function readBoundedStdin/);
    assert.match(cliErrorRedactionSource, /export function redactLocalPathEvidence/);
    assert.match(cliErrorRedactionSource, /UNQUOTED_ABSOLUTE_PATH/);
    assert.match(source, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
    assert.match(source, /input exceeds/);
    assert.doesNotMatch(source, /\.argument\("<code>"/);
    assert.doesNotMatch(source, /\.argument\("<files\.\.\.>"/);
  }
});

test("CLI private receive-code inputs are not echoed back into local telemetry", () => {
  assert.match(securityPolicy, /supplied receive codes must not be reprinted in registered output/);
  assert.match(securityPolicy, /environment-sourced codes must be cleared after capture/);
  assert.match(securityPolicy, /environment-sourced codes must be byte-capped before code normalization/);
  assert.match(securityPolicy, /code-stdin paths must not fall back to echoing terminal prompts/);
  for (const source of [cliSource, distCliSource]) {
    assert.match(source, /function printRegisteredReceiver/);
    assert.match(source, /codeSupplied: true/);
    assert.match(source, /codeRedacted: true/);
    assert.match(source, /Ready to receive with the supplied code/);
    assert.match(source, /printRegisteredReceiver\(options, parsedCode\.handle, registered, registeredCode\.supplied\)/);
    assert.doesNotMatch(source, /code: parsedCode\.handle, rendezvous: registered\.code, expiresInSec: registered\.expiresInSec \}\);[\s\S]*Ready to receive\. Share this code/);
    assert.match(source, /codeInputUtf8ByteLengthExceeds/);
    assert.match(source, /const value = descriptor\.value;[\s\S]*delete process\.env\[name\];[\s\S]*codeInputUtf8ByteLengthExceeds\(value\)/);
    assert.match(source, /function readCodeFromStdin/);
    assert.doesNotMatch(source, /readCodeFromStdinOrPrompt|function promptCode|Receiver code:|Receive code:/);
  }
  assert.match(readme, /read -rs FF_RECEIVE_CODE/);
  assert.match(readme, /FF_RECEIVE_CODE="\$FF_RECEIVE_CODE" node dist-node\/cli\/index\.js send --code-env FF_RECEIVE_CODE --files-stdin/);
  assert.match(readme, /`--code-env` only avoids argv and shell-history exposure/);
  assert.match(readme, /Interactive send commands print a generic warning on stderr whenever the receive code or local file paths are still accepted from argv/);
  assert.match(readme, /`recv --code` prints the same kind of generic warning for supplied receive codes in argv/);
  assert.match(readme, /Use `--require-private-input` in automation that must fail closed/);
  assert.match(securityPolicy, /`--require-private-input` must reject `recv --code`, `send <code>`, and send file paths supplied through argv before filesystem, signaling, or peer work/);
  assert.match(readme, /The warnings never include the code or paths/);
  assert.match(securityPolicy, /CLI environment-sourced codes must be documented as protection from argv and shell-history capture only/);
  assert.doesNotMatch(readme, /printf '%s(?:\\n%s\\n)?' '<code>'/);
});

test("CLI require-private-input rejects argv secrets and paths", async () => {
  const secretPath = "/tmp/ff-private-input-secret.txt";
  const sendArgv = spawnSync(process.execPath, [cliEntrypoint, "--json", "--require-private-input", "send", "12345678-apple-anchor", secretPath], {
    encoding: "utf8"
  });
  assert.notEqual(sendArgv.status, 0);
  assert.equal(sendArgv.stdout, "");
  assert.match(sendArgv.stderr, /Receiver code and file path argv are disabled by --require-private-input/);
  assert.doesNotMatch(sendArgv.stderr, /12345678-apple-anchor|ff-private-input-secret/);

  const sendPathArgv = spawnSync(process.execPath, [cliEntrypoint, "--json", "--require-private-input", "send", "--code-stdin", secretPath], {
    encoding: "utf8",
    input: "12345678-apple-anchor\n"
  });
  assert.notEqual(sendPathArgv.status, 0);
  assert.equal(sendPathArgv.stdout, "");
  assert.match(sendPathArgv.stderr, /File path argv is disabled by --require-private-input/);
  assert.doesNotMatch(sendPathArgv.stderr, /12345678-apple-anchor|ff-private-input-secret/);

  const recvArgv = spawnSync(process.execPath, [cliEntrypoint, "--json", "--require-private-input", "recv", "--code", "12345678-apple-anchor"], {
    encoding: "utf8"
  });
  assert.notEqual(recvArgv.status, 0);
  assert.equal(recvArgv.stdout, "");
  assert.match(recvArgv.stderr, /Receive code argv is disabled by --require-private-input/);
  assert.doesNotMatch(recvArgv.stderr, /12345678-apple-anchor/);
});

test("CLI code-env rejects oversized receive codes without echoing them", async () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, "--json", "recv", "--code-env", "FF_PRIVATE_RECEIVE_CODE"], {
    encoding: "utf8",
    env: { ...process.env, FF_PRIVATE_RECEIVE_CODE: "é".repeat(129) }
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /ééé/);
  const event = JSON.parse(result.stderr.trim()) as { event?: unknown; message?: unknown };
  assert.equal(event.event, "error");
  assert.equal(event.message, "Environment variable FF_PRIVATE_RECEIVE_CODE is invalid.");
});

test("CLI recv code-env errors do not echo supplied receive codes", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ff-recv-code-env-"));
  const outputFile = path.join(tmp, "not-a-directory");
  await fs.promises.writeFile(outputFile, "");
  try {
    const result = spawnSync(process.execPath, [cliEntrypoint, "--json", "recv", "--code-env", "FF_PRIVATE_RECEIVE_CODE", "--out", outputFile], {
      encoding: "utf8",
      env: { ...process.env, FF_PRIVATE_RECEIVE_CODE: "12345678-apple-anchor" }
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /12345678-apple-anchor|apple-anchor/);
    const event = JSON.parse(result.stderr.trim()) as { event?: unknown; message?: unknown };
    assert.equal(event.event, "error");
    assert.equal(event.message, "EEXIST: file already exists, mkdir '[path]'");
  } finally {
    await fs.promises.rm(tmp, { force: true, recursive: true });
  }
});

test("CLI path setup errors do not echo raw local paths", () => {
  assert.match(securityPolicy, /CLI sender path preflight errors must not echo raw local send paths/);
  for (const source of [cliFilesSource, distCliFilesSource]) {
    assert.doesNotMatch(source, /\$\{input\}/);
    assert.doesNotMatch(source, /\$\{resolved\} is not a directory/);
    assert.match(source, /Selected file is a symbolic link/);
    assert.match(source, /Selected file changed while preparing the transfer/);
    assert.match(source, /Output path is not a directory/);
  }
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
