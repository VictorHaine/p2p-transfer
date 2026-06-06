import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const cliFilesSource = fs.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const distCliFilesSource = fs.readFileSync(new URL("../dist-node/cli/files.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("CLI json mode emits structured sanitized error events instead of plain stderr", () => {
  assert.match(cliSource, /return runWithExit\(\(\) => recv\(merged\), merged\)/);
  assert.match(cliSource, /const inputs = await resolveSendInputs\(code, files, merged\)/);
  assert.match(cliSource, /return send\(normalizeCode\(inputs\.code\), inputs\.files, merged\)/);
  assert.match(cliSource, /function printError\(options: CommonOptions, error: unknown, code: number\): void \{/);
  assert.match(cliSource, /redactLocalPathEvidence\(safeErrorMessage\(error\)\)/);
  assert.match(cliSource, /if \(options\.json\) \{[\s\S]*console\.error\(JSON\.stringify\(sanitizeStructuredOutput\(\{ event: "error", code, message \}\)\)\);/);
  assert.match(cliSource, /console\.error\(message\);/);
});

test("CLI redacted output mode removes file metadata from JSON and progress events", () => {
  assert.match(securityPolicy, /CLI `--redact-output` must remove file names, MIME types, and byte counts from CLI JSON and human transfer output/);
  assert.match(readme, /`--redact-output`: redact file names, MIME types, and byte counts/);
  assert.match(cliSource, /\.option\("--redact-output", "redact file metadata from CLI output and JSON events"\)/);
  assert.match(cliSource, /options\.redactOutput \? \{ event: "pair_request", fileCount: manifest\.fileCount \} : \{ event: "pair_request", files: manifest\.files, totalBytes: manifest\.totalBytes \}/);
  assert.match(cliSource, /options\.redactOutput \? `Incoming transfer: \$\{manifest\.fileCount\} file\(s\)\. SAS \$\{sas\}` : `Incoming transfer: \$\{manifest\.fileCount\} file\(s\), \$\{formatBytes\(manifest\.totalBytes\)\}\. SAS \$\{sas\}`/);
  assert.match(cliSource, /console\.log\(options\.redactOutput \? "  - \[redacted\]" : `  - \$\{safeFileName\(file\.name\)\} \(\$\{formatBytes\(file\.size\)\}\)`\)/);
  assert.match(cliSource, /sendFiles\(control, bulk, keys, files, options\.json, options\.quiet, Boolean\(options\.redactOutput\)\)/);
  assert.match(cliSource, /receiveFiles\(control, bulk, keys, outDir, options\.json, options\.quiet, undefined, manifest, Boolean\(options\.resume\), Boolean\(options\.redactOutput\)\)/);
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
  for (const source of [cliSource, distCliSource]) {
    const recvBody = extractFunctionBody(source, "recv");
    assert.match(recvBody, /const suppliedCode = await resolveRecvCode\(options\)/);
    assert.equal(recvBody.indexOf("resolveRecvCode(options)") < recvBody.indexOf("ensureOutputDir(options.out)"), true);
    assert.equal(recvBody.indexOf("resolveRecvCode(options)") < recvBody.indexOf("openSignaling(options.server)"), true);
    assert.match(recvBody, /registerReceiver\(signaling, suppliedCode\)/);

    assert.match(source, /function resolveRecvCode/);
    assert.match(source, /parseRequiredCode\(normalizeCode\(code\)\)/);
    assert.match(source, /supplied: true/);
    assert.match(source, /function registerReceiver[\s\S]*const parsedCode = suppliedCode\?\.parsedCode \?\? parseRequiredCode\(normalizeCode\(generateCode\(\)\)\)/);
    assert.match(source, /const attempts = suppliedCode \? 1 : RECEIVE_CODE_GENERATION_ATTEMPTS/);
    assert.doesNotMatch(source, /parseRequiredCode\(normalizeCode\(options\.code \?\? generateCode\(\)\)\)/);
  }
});

test("CLI send supports non-argv code and file path input", () => {
  assert.match(securityPolicy, /CLI senders must support piped stdin or environment-variable receive-code input and newline-delimited stdin file lists/);
  for (const source of [cliSource, distCliSource]) {
    assert.match(source, /process\.title = "ff"/);
    assert.match(source, /\.option\("--out <dir>", "output directory"\)/);
    assert.match(source, /out: options\.out \?\? process\.cwd\(\)/);
    assert.doesNotMatch(source, /\.option\("--out <dir>", "output directory", process\.cwd\(\)\)/);
    assert.match(source, /\.option\("--code-stdin"/);
    assert.match(source, /\.option\("--code-env <name>"/);
    assert.match(source, /\.option\("--files-stdin"/);
    assert.match(source, /const CLI_STDIN_MAX_BYTES = 512 \* 1024/);
    assert.match(source, /const ENV_NAME_PATTERN = \/\^\[A-Za-z_\]/);
    assert.match(source, /function resolveSendInputs/);
    assert.match(source, /function readCodeEnv/);
    assert.match(source, /function readBoundedStdin/);
    assert.match(source, /function redactLocalPathEvidence/);
    assert.match(source, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
    assert.match(source, /input exceeds/);
    assert.doesNotMatch(source, /\.argument\("<code>"/);
    assert.doesNotMatch(source, /\.argument\("<files\.\.\.>"/);
  }
});

test("CLI private receive-code inputs are not echoed back into local telemetry", () => {
  assert.match(securityPolicy, /supplied receive codes must not be reprinted in registered output/);
  assert.match(securityPolicy, /environment-sourced codes must be cleared after capture/);
  assert.match(securityPolicy, /code-stdin paths must not fall back to echoing terminal prompts/);
  for (const source of [cliSource, distCliSource]) {
    assert.match(source, /function printRegisteredReceiver/);
    assert.match(source, /codeSupplied: true/);
    assert.match(source, /Ready to receive with the supplied code/);
    assert.match(source, /printRegisteredReceiver\(options, parsedCode\.handle, registered, registeredCode\.supplied\)/);
    assert.doesNotMatch(source, /code: parsedCode\.handle, rendezvous: registered\.code, expiresInSec: registered\.expiresInSec \}\);[\s\S]*Ready to receive\. Share this code/);
    assert.match(source, /delete process\.env\[name\]/);
    assert.match(source, /function readCodeFromStdin/);
    assert.doesNotMatch(source, /readCodeFromStdinOrPrompt|function promptCode|Receiver code:|Receive code:/);
  }
  assert.match(readme, /read -rs FF_RECEIVE_CODE/);
  assert.match(readme, /FF_RECEIVE_CODE="\$FF_RECEIVE_CODE" node dist-node\/cli\/index\.js send --code-env FF_RECEIVE_CODE --files-stdin/);
  assert.doesNotMatch(readme, /printf '%s(?:\\n%s\\n)?' '<code>'/);
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
