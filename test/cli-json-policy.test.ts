import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const cliFilesSource = fs.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const distCliFilesSource = fs.readFileSync(new URL("../dist-node/cli/files.js", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("CLI json mode emits structured sanitized error events instead of plain stderr", () => {
  assert.match(cliSource, /return runWithExit\(\(\) => recv\(merged\), merged\)/);
  assert.match(cliSource, /const inputs = await resolveSendInputs\(code, files, merged\)/);
  assert.match(cliSource, /return send\(normalizeCode\(inputs\.code\), inputs\.files, merged\)/);
  assert.match(cliSource, /function printError\(options: CommonOptions, error: unknown, code: number\): void \{/);
  assert.match(cliSource, /redactLocalPathEvidence\(safeErrorMessage\(error\)\)/);
  assert.match(cliSource, /if \(options\.json\) \{[\s\S]*console\.error\(JSON\.stringify\(sanitizeStructuredOutput\(\{ event: "error", code, message \}\)\)\);/);
  assert.match(cliSource, /console\.error\(message\);/);
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
    assert.match(source, /function registerReceiver[\s\S]*const parsedCode = suppliedCode \?\? parseRequiredCode\(normalizeCode\(generateCode\(\)\)\)/);
    assert.match(source, /const attempts = suppliedCode \? 1 : RECEIVE_CODE_GENERATION_ATTEMPTS/);
    assert.doesNotMatch(source, /parseRequiredCode\(normalizeCode\(options\.code \?\? generateCode\(\)\)\)/);
  }
});

test("CLI send supports non-argv code and file path input", () => {
  assert.match(securityPolicy, /CLI senders must support stdin, prompt, or environment-variable receive-code input and newline-delimited stdin file lists/);
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
