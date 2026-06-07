import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
const cliSignalingSource = fs.readFileSync(new URL("../src/cli/signaling.ts", import.meta.url), "utf8");
const distCliSource = fs.readFileSync(new URL("../dist-node/cli/index.js", import.meta.url), "utf8");
const distCliSignalingSource = fs.readFileSync(new URL("../dist-node/cli/signaling.js", import.meta.url), "utf8");
const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("successful transfers treat final signaling bye as best-effort teardown", () => {
  assert.equal(countMatches(cliSource, /safeSend\(signaling, \{ type: "bye", sid: joined\.sid, reason: "complete" \}\)/g), 2);
  assert.equal(countMatches(webSource, /safeBrowserSend\(signaling, \{ type: "bye", sid: joined\.sid, reason: "complete" \}\)/g), 2);
  assert.doesNotMatch(cliSource, /signaling\.send\(\{ type: "bye", sid: joined\.sid, reason: "complete" \}\)/);
  assert.doesNotMatch(webSource, /signaling\.send\(\{ type: "bye", sid: joined\.sid, reason: "complete" \}\)/);
});

test("receiver declines preserve local decision even if signaling teardown fails", () => {
  assert.match(cliSource, /safeSend\(signaling, \{ type: "pair-reject", sid: joined\.sid, reason: "user_declined", auth: runtime\.security\.pairDecisionAuthTag\(keys\.signalAuthKey, joined\.sid, "receiver", "reject", sealedManifest, "user_declined"\) \}\);[\s\S]*throw new Error\("Transfer declined\."\)/);
  assert.match(webSource, /safeBrowserSend\(signaling, \{ type: "pair-reject", sid: joined\.sid, reason: "user_declined", auth: pairDecisionAuthTag\(keys\.signalAuthKey, joined\.sid, "receiver", "reject", sealedManifest, "user_declined"\) \}\);[\s\S]*setStatus\(recvStatus, "Declined"\)/);
  assert.doesNotMatch(cliSource, /signaling\.send\(\{ type: "pair-reject", sid: joined\.sid, reason: "user_declined" \}\);[\s\S]*throw new Error\("Transfer declined\."\)/);
  assert.doesNotMatch(webSource, /signaling\.send\(\{ type: "pair-reject", sid: joined\.sid, reason: "user_declined" \}\);[\s\S]*setStatus\(recvStatus, "Declined"\)/);
});

test("headless CLI receivers decline explicitly instead of dropping the sender", () => {
  assert.match(cliSource, /if \(!input\.isTTY\) \{[\s\S]*declining transfer[\s\S]*return false;[\s\S]*\}/);
  assert.doesNotMatch(cliSource, /if \(!input\.isTTY\) throw new Error\("Refusing to prompt without a TTY/);
});

test("interactive CLI receive prompt always closes readline", () => {
  assert.match(cliSource, /const rl = readline\.createInterface\(\{ input, output \}\);[\s\S]*try \{[\s\S]*rl\.question\("Accept\? \[y\/N\] "\)[\s\S]*\} finally \{[\s\S]*rl\.close\(\);[\s\S]*\}/);
  assert.doesNotMatch(cliSource, /const answer = \(await rl\.question\("Accept\? \[y\/N\] "\)\)[\s\S]*rl\.close\(\);[\s\S]*return answer === "y"/);
});

test("clients reject mismatched registered rendezvous acknowledgements", () => {
  assert.match(securityPolicy, /clients must reject `registered` acknowledgements whose rendezvous prefix does not match/);
  for (const source of [cliSource, webSource]) {
    assert.match(source, /function assertRegisteredRendezvous\(/);
    assert.match(source, /Signaling server returned a mismatched rendezvous code/);
    assert.match(source, /assertRegisteredRendezvous\(registered, parsedCode\.rendezvous\)/);
  }
  assert.match(cliSource, /assertRegisteredRendezvous\(restored, parsedCode\.rendezvous\)/);
  assert.match(cliSource, /assertRegisteredRendezvous\(registered, expectedRendezvous\)/);
  assert.match(webSource, /assertRegisteredRendezvous\(await waitFor\(signaling, "registered", CONNECT_TIMEOUT_MS\), parsedCode\.rendezvous\)/);
  assert.match(webSource, /assertRegisteredRendezvous\(await waitFor\(signaling, "registered", CONNECT_TIMEOUT_MS\), expectedRendezvous\)/);
});

test("browser senders treat pair rejection as a decision, not a socket failure", () => {
  assert.match(webSource, /signaling\.off\("pair-reject", onPairReject\)/);
  assert.match(webSource, /const onPairReject = \(message: BrowserSignalingEvent\) => \{[\s\S]*message\.type !== "pair-reject"[\s\S]*waitSid === undefined \|\| message\.sid !== waitSid[\s\S]*pairRejectMessage\(message\.reason\)[\s\S]*\};/);
  assert.match(webSource, /signaling\.on\("pair-reject", onPairReject\)/);
});

test("senders do not expose protocol-only pair rejection reasons as user messages", () => {
  assert.match(cliSource, /function pairRejectMessage\(_reason: string \| undefined\): string \{[\s\S]*return "Transfer rejected\.";[\s\S]*\}/);
  assert.match(webSource, /function pairRejectMessage\(_reason: string \| undefined\): string \{[\s\S]*return "Transfer rejected\.";[\s\S]*\}/);
  assert.doesNotMatch(cliSource, /new Error\(message\.reason \?\? "Transfer rejected\."\)/);
  assert.doesNotMatch(webSource, /new Error\(message\.reason \?\? "Transfer rejected\."\)/);
});

test("senders do not expose peer-left signaling reasons as user messages", () => {
  for (const source of [cliSource, webSource]) {
    assert.match(source, /new Error\("Peer disconnected\."\)/);
    assert.doesNotMatch(source, /Peer disconnected: \$\{message\.reason/);
    assert.doesNotMatch(source, /Peer disconnected: \$\{message\.reason \?\? "unknown"\}/);
  }
});

test("authenticated WebRTC signal failures stay visible during connection setup", () => {
  for (const source of [cliSource, webSource]) {
    assert.match(source, /const signalWire = wireSignals\(/);
    assert.match(source, /Promise\.race\(\[Promise\.all\(\[[\s\S]*wait(?:ForDataChannelOpen|Open)[\s\S]*wait(?:Connected|PeerConnected)[\s\S]*\]\), signalWire\.failure\]\)/);
    assert.match(source, /const fail = \(error: Error\) => \{[\s\S]*if \(failed \|\| disposed\) return;[\s\S]*failSignal\(error\);[\s\S]*reason: "signal_error"[\s\S]*pc\.close\(\);[\s\S]*dispose\(\);[\s\S]*\};/);
    assert.match(source, /fail\(error instanceof Error \? error : new Error\(safeErrorMessage\(error\)\)\)/);
    assert.match(source, /return \{ dispose, failure \};/);
  }
  assert.match(cliSource, /const \{ control, bulk \} = await Promise\.race\(\[channels, signalWire\.failure\]\)/);
  assert.match(webSource, /const \{ control, bulk \} = await Promise\.race\(\[channels, signalWire\.failure\]\)/);
});

test("transfers stop depending on signaling after WebRTC is connected", () => {
  assert.match(securityPolicy, /after WebRTC is connected and both DataChannels are open, transfers must not race file streaming against signaling liveness/);
  assert.match(cliSource, /runtime\.rtc\.waitForDataChannelOpen\(control\), runtime\.rtc\.waitForDataChannelOpen\(bulk\), peer\.waitConnected\(\)[\s\S]*signalWire\.failure\]\);[\s\S]*signalWire\.dispose\(\);[\s\S]*unwireSignals = undefined;[\s\S]*await runtime\.transfer\.receiveFiles\(control, bulk, keys,/);
  assert.match(cliSource, /runtime\.rtc\.waitForDataChannelOpen\(control\), runtime\.rtc\.waitForDataChannelOpen\(bulk\), peer\.waitConnected\(\)[\s\S]*signalWire\.failure\]\);[\s\S]*signalWire\.dispose\(\);[\s\S]*unwireSignals = undefined;[\s\S]*await runtime\.transfer\.sendFiles\(control, bulk, keys,/);
  assert.match(webSource, /waitOpen\(control\), waitOpen\(bulk\), waitPeerConnected\(pc\)[\s\S]*signalWire\.failure\]\);[\s\S]*signalWire\.dispose\(\);[\s\S]*unwireSignals = undefined;[\s\S]*await sendBrowserFiles\(control, bulk, keys,/);
  assert.match(webSource, /waitOpen\(control\), waitOpen\(bulk\), waitPeerConnected\(pc\)[\s\S]*signalWire\.failure\]\);[\s\S]*signalWire\.dispose\(\);[\s\S]*unwireSignals = undefined;[\s\S]*await receiveBrowserFiles\(control, bulk, keys,/);
  assert.doesNotMatch(cliSource, /Promise\.race\(\[receiveFiles\(control, bulk, keys,[\s\S]*\), signalWire\.failure\]\)/);
  assert.doesNotMatch(cliSource, /Promise\.race\(\[sendFiles\(control, bulk, keys,[\s\S]*\), signalWire\.failure\]\)/);
  assert.doesNotMatch(webSource, /Promise\.race\(\[sendBrowserFiles\(control, bulk, keys,[\s\S]*\), signalWire\.failure\]\)/);
  assert.doesNotMatch(webSource, /Promise\.race\(\[receiveBrowserFiles\(control, bulk, keys,[\s\S]*\), signalWire\.failure\]\)/);
  assert.match(distCliSource, /signalWire\.dispose\(\);\n\s+unwireSignals = undefined;\n\s+human\(options, "Connected\. Receiving files\.\.\."\);\n\s+await runtime\.transfer\.receiveFiles\(control, bulk, keys,/);
  assert.match(distCliSource, /signalWire\.dispose\(\);\n\s+unwireSignals = undefined;\n\s+human\(options, "Connected\. Sending files\.\.\."\);\n\s+await runtime\.transfer\.sendFiles\(control, bulk, keys,/);
  assert.match(distWebBundle, /`Sending`/);
  assert.match(distWebBundle, /`Receiving`/);
  assert.match(distWebBundle, /\.dispose\(\)/);
  assert.match(cliSource, /failure\.catch\(\(\) => \{\}\)/);
  assert.match(webSource, /failure\.catch\(\(\) => \{\}\)/);
});

test("browser protocol waits use shared timeout constants", () => {
  assert.match(securityPolicy, /browser and CLI protocol wait paths must use the same shared connection and pair-decision timeout constants/);
  assert.match(webSource, /PAIR_TIMEOUT_MS/);
  assert.match(webSource, /CONNECT_TIMEOUT_MS/);
  assert.doesNotMatch(webSource, /waitFor(?:Session)?\(signaling, "[^"]+", [^,\n]+, 300_000\)/);
  assert.doesNotMatch(webSource, /waitFor\(signaling, "[^"]+", 45_000/);
  assert.match(webSource, /await waitForAuthenticatedPairAccept\(signaling, joined\.sid, keys, sealedManifest\)/);
  assert.match(webSource, /const timer = setTimeout\(\(\) => \{[\s\S]*Timed out waiting for pair decision[\s\S]*\}, PAIR_TIMEOUT_MS\)/);
  assert.match(webSource, /waitForSession\(signaling, "pair-request", joined\.sid, PAIR_TIMEOUT_MS\)/);
  assert.match(webSource, /return waitFor\(signaling, "peer-joined", CONNECT_TIMEOUT_MS\)/);
  assert.match(webSource, /waitFor\(signaling, "pake", CONNECT_TIMEOUT_MS, sid, waitAbort\.signal\)/);
  assert.match(webSource, /waitFor\(signaling, "confirm", CONNECT_TIMEOUT_MS, sid, waitAbort\.signal\)/);
});

test("signaling wait cancellation paths settle once", () => {
  assert.match(securityPolicy, /signaling waiters must settle already-aborted waits exactly once/);
  assert.equal(countMatches(cliSignalingSource, /reject\(new Error\(`Cancelled waiting for \$\{waitType\}`\)\);/g), 1);
  assert.equal(countMatches(webSource, /reject\(new Error\(`Cancelled waiting for \$\{waitType\}`\)\);/g), 1);
  assert.equal(countMatches(distCliSignalingSource, /reject\(new Error\(`Cancelled waiting for \$\{waitType\}`\)\);/g), 1);
  assert.match(distWebBundle, /if\(u\?\.aborted\)\{f\(\),o\(Error\(`Cancelled waiting for \$\{s\}`\)\);return\}/);
  assert.doesNotMatch(webSource, /reject\(new Error\(`Cancelled waiting for \$\{waitType\}`\)\);\s*reject\(new Error\(`Cancelled waiting for \$\{waitType\}`\)\);/);
});

test("browser ICE config wait fails when signaling dies after accept", () => {
  assert.match(securityPolicy, /browser post-accept ICE configuration waits must fail on signaling close or signaling error/);
  const body = extractFunctionBody(webSource, "getIceServers");
  assert.match(body, /new Promise\(\(resolve, reject\) => \{/);
  assert.match(body, /signaling\.off\("error", onError\)/);
  assert.match(body, /signaling\.off\("close", onClose\)/);
  assert.match(body, /const onError = \(message: BrowserSignalingEvent\) => \{[\s\S]*if \(!isServerMessage\(message\)\) return;[\s\S]*reject\(message\.type === "error" \? new BrowserSignalingError\(message\.code\) : new Error\("Signaling error"\)\);[\s\S]*\};/);
  assert.match(body, /const onClose = \(\) => \{[\s\S]*reject\(new Error\("Signaling socket closed\."\)\);[\s\S]*\};/);
  assert.match(body, /signaling\.on\("error", onError\)/);
  assert.match(body, /signaling\.on\("close", onClose\)/);
  assert.match(distWebBundle, /currentIceServers\(\)\|\|new Promise/);
  assert.match(distWebBundle, /\.off\(`error`,\w+\),\w+\.off\(`close`,\w+\)/);
  assert.match(distWebBundle, /Signaling error/);
  assert.match(distWebBundle, /Signaling socket closed/);
  assert.match(distWebBundle, /\.on\(`ice-config`,\w+\),\w+\.on\(`error`,\w+\),\w+\.on\(`close`,\w+\)/);
});

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);
  if (start === -1) start = source.indexOf(`function ${name}<`);
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
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
