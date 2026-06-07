import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const webSource = fs.readFileSync(new URL("../src/web/main.ts", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const browserInteropTest = fs.readFileSync(new URL("./browser/browser-cli-send.test.ts", import.meta.url), "utf8");
const distWebBundle = readDistWebBundle();

test("browser UI prevents overlapping send and receive operations from one tab", () => {
  assert.match(webSource, /let sendBusy = false;/);
  assert.match(webSource, /let receiveBusy = false;/);
  assert.match(webSource, /if \(operationBusy\(\)\) return;[\s\S]*sendBusy = true;[\s\S]*\.finally\(\(\) => \{[\s\S]*sendBusy = false;/);
  assert.match(webSource, /if \(operationBusy\(\)\) return;[\s\S]*receiveBusy = true;[\s\S]*\.finally\(\(\) => \{[\s\S]*receiveBusy = false;/);
  assert.match(webSource, /function operationBusy\(\): boolean \{[\s\S]*return sendBusy \|\| receiveBusy;/);
  assert.match(webSource, /const busy = operationBusy\(\);[\s\S]*serverUrl\.disabled = busy;/);
  assert.match(webSource, /serverIce\.disabled = busy;/);
  assert.match(webSource, /relayOnly\.disabled = busy;/);
  assert.match(webSource, /folderOnly\.disabled = busy;/);
  assert.match(webSource, /opaqueNames\.disabled = busy;/);
  assert.match(webSource, /sendButton\.disabled = busy;/);
  assert.match(webSource, /receiveButton\.disabled = busy;/);
});

test("browser exposes relay-only ICE parity with the CLI", () => {
  assert.match(securityPolicy, /CLI and browser docs must describe relay-only ICE as the TURN-backed mitigation for direct ICE candidate endpoint exposure/);
  assert.match(securityPolicy, /browser send and receive flows must pass `iceTransportPolicy: "relay"` when the browser relay-only control is selected/);
  assert.match(readme, /The browser client has matching ICE controls in the header/);
  assert.match(readme, /`Relay only` sets WebRTC `iceTransportPolicy` to `relay`/);
  assert.match(webSource, /<input id="relayOnly" type="checkbox" \/>/);
  assert.match(webSource, /<span>Relay only<\/span>/);
  assert.match(webSource, /const relayOnly = byId<HTMLInputElement>\("relayOnly"\);/);
  assert.match(webSource, /function shouldUseBrowserRelayOnly\(\): boolean \{[\s\S]*return relayOnly\.checked;/);
  assert.match(webSource, /function browserRtcConfiguration\(iceServers: RTCIceServer\[\]\): RTCConfiguration \{[\s\S]*const relayOnlySelected = shouldUseBrowserRelayOnly\(\);[\s\S]*if \(relayOnlySelected && !hasRelayIceServer\(iceServers\)\) throw new Error\("Relay-only ICE requires a TURN server\."\);[\s\S]*return \{ iceServers, iceTransportPolicy: relayOnlySelected \? "relay" : "all" \};/);
  assert.equal(webSource.match(/new RTCPeerConnection\(browserRtcConfiguration\(iceServers\)\)/g)?.length, 2);
});

test("browser exposes folder-only receive to avoid Blob fallback plaintext retention", () => {
  const receiveBody = extractFunctionBody(webSource, "receiveInBrowser");
  const promptBody = extractFunctionBody(webSource, "promptForBrowserAccept");

  assert.match(securityPolicy, /browser receive must expose an explicit folder-only mode for sensitive receives/);
  assert.match(readme, /enable `Folder only` before starting receive/);
  assert.match(readme, /memory-backed Blob download fallback/);
  assert.match(webSource, /<input id="folderOnly" type="checkbox" \/>/);
  assert.match(webSource, /<span>Folder only<\/span>/);
  assert.match(webSource, /const folderOnly = byId<HTMLInputElement>\("folderOnly"\);/);
  assert.match(webSource, /function shouldRequireBrowserFolderReceive\(\): boolean \{[\s\S]*return folderOnly\.checked;/);
  assert.match(webSource, /function canPickBrowserDirectory\(\): boolean \{[\s\S]*return typeof window\.showDirectoryPicker === "function";/);
  assert.match(receiveBody, /const requireFolderReceive = shouldRequireBrowserFolderReceive\(\);[\s\S]*if \(requireFolderReceive && !canPickBrowserDirectory\(\)\) throw new Error\("Folder-only receive requires File System Access\."\);/);
  assert.equal(receiveBody.indexOf("shouldRequireBrowserFolderReceive()") < receiveBody.indexOf("openSignaling()"), true);
  assert.match(receiveBody, /promptForBrowserAccept\(manifest, keys\.sas, requireFolderReceive, opaqueOutputNames\)/);
  assert.match(webSource, /async function promptForBrowserAccept\(manifest: FileManifest, sas: string, requireFolderReceive = false, opaqueOutputNames = false\): Promise<BrowserReceiveAccept>/);
  assert.match(promptBody, /const canUseMemoryFallback = !requireFolderReceive && manifest\.totalBytes <= BROWSER_BLOB_FALLBACK_MAX_BYTES;/);
  assert.match(promptBody, /const acceptButton = canUseMemoryFallback \? makeButton\("acceptButton", "Accept"\) : undefined;/);
  assert.match(promptBody, /requireFolderReceive \? "Folder-only receive requires folder streaming\." : "Large transfers require folder streaming\."/);
});

test("browser exposes opaque receive output names", () => {
  const receiveBody = extractFunctionBody(webSource, "receiveInBrowser");
  const promptBody = extractFunctionBody(webSource, "promptForBrowserAccept");
  const outputNameBody = extractFunctionBody(webSource, "browserFinalOutputName");

  assert.match(securityPolicy, /browser receive must expose an explicit opaque-names mode for sensitive receives/);
  assert.match(readme, /Enable `Opaque output names` before starting receive/);
  assert.match(webSource, /<input id="opaqueNames" type="checkbox" \/>/);
  assert.match(webSource, /<span>Opaque output names<\/span>/);
  assert.match(webSource, /const opaqueNames = byId<HTMLInputElement>\("opaqueNames"\);/);
  assert.match(webSource, /function shouldUseBrowserOpaqueNames\(\): boolean \{[\s\S]*return opaqueNames\.checked;/);
  assert.match(receiveBody, /const opaqueOutputNames = shouldUseBrowserOpaqueNames\(\);/);
  assert.match(receiveBody, /receiveBrowserFiles\(control, bulk, keys, recvLog, manifest, accept\.accepted \? accept\.directory : undefined, accept\.accepted \? accept\.resume : false, accept\.accepted \? accept\.opaqueNames : false\)/);
  assert.match(promptBody, /opaqueNames: opaqueOutputNames/);
  assert.match(outputNameBody, /if \(!opaqueOutputNames\) return randomizedBrowserOutputName\(name\);/);
  assert.match(outputNameBody, /return opaqueBrowserOutputName\(stableOpaqueKey === undefined \? undefined : browserOpaqueOutputToken\(stableOpaqueKey\)\);/);
});

test("browser bootstrap HTML uses the named Trusted Types policy", () => {
  assert.match(webSource, /const STATIC_HTML_POLICY_NAME = "ff-static";/);
  assert.match(webSource, /app\.innerHTML = staticTrustedHtml`/);
  assert.match(webSource, /trustedTypes\?\.createPolicy\(STATIC_HTML_POLICY_NAME/);
  assert.match(webSource, /function staticTrustedHtml\(strings: TemplateStringsArray, \.\.\.values: never\[\]\): string/);
  assert.match(webSource, /if \(values\.length !== 0\) throw new Error\("Static HTML must not contain interpolated values\."\);/);
  assert.match(webSource, /const html = strings\.join\(""\);/);
  assert.doesNotMatch(webSource, /app\.innerHTML = `[\s\S]*<main/);
  assert.doesNotMatch(webSource, /function staticTrustedHtml\(html: string\): string/);
});

test("browser interop tests fail closed unless browser skipping is explicit", () => {
  assert.match(securityPolicy, /browser interop tests must fail closed when neither Playwright-installed Chromium nor an explicit `PLAYWRIGHT_CHROMIUM`\/system Chromium binary is available/);
  assert.match(securityPolicy, /skipping browser interop must require an explicit non-release `FF_ALLOW_BROWSER_TEST_SKIP=true` opt-out/);
  assert.match(readme, /Missing Chromium is a hard test failure unless `FF_ALLOW_BROWSER_TEST_SKIP=true` is set explicitly/);
  assert.match(browserInteropTest, /const hasChromium = chromiumPath !== undefined \|\| hasPlaywrightChromium\(\);/);
  assert.match(browserInteropTest, /const allowMissingChromium = process\.env\.FF_ALLOW_BROWSER_TEST_SKIP === "true";/);
  assert.match(browserInteropTest, /test\("browser Chromium executable is available"/);
  assert.match(browserInteropTest, /if \(hasChromium\) return;/);
  assert.match(browserInteropTest, /context\.skip\(missingChromium\)/);
  assert.match(browserInteropTest, /assert\.fail\(missingChromium\)/);
  assert.match(browserInteropTest, /function hasPlaywrightChromium\(\): boolean/);
  assert.doesNotMatch(browserInteropTest, /skip: chromiumPath \? false : "No Chromium executable found"/);
});

test("browser sender revalidates transfer manifests at the send boundary", () => {
  assert.match(webSource, /assertTransferManifestWithinLimits\(manifest\);/);
  assert.match(
    webSource,
    /const sendPlan = await buildBrowserSendPlan\(files\);[\s\S]*const manifest = browserSendPlanManifest\(sendPlan\);[\s\S]*keys = await establishBrowserKeys\(signaling, joined\.sid, "sender", parsedCode\.handle\);[\s\S]*setLog\(sendLog, `SAS \$\{keys\.sas\}`\);[\s\S]*const sealedManifest = await sealManifest\(keys, manifest\);[\s\S]*signaling\.send\(\{ type: "pair-request", sid: joined\.sid, manifest: redactManifest\(manifest\), sealedManifest \}\)/
  );
  assert.match(
    webSource,
    /const safeSendPlan = browserSendPlanInput\(sendPlan\);[\s\S]*const transferManifest = browserSendPlanManifest\(safeSendPlan\);[\s\S]*await sendControl\(control, keys, \{[\s\S]*t: "manifest",[\s\S]*files: transferFiles,/
  );
});

test("browser sender uses the validated send plan for transfer metadata", () => {
  assert.match(webSource, /type BrowserSendPlanFile = \{[\s\S]*file: File;[\s\S]*slice: File\["slice"\];[\s\S]*sha256: string;[\s\S]*chunkSha256: string\[\];[\s\S]*\};/);
  assert.match(webSource, /sendBrowserFiles\(control, bulk, keys, sendPlan, sendLog\)/);
  assert.match(
    webSource,
    /const safeSendPlan = browserSendPlanInput\(sendPlan\);[\s\S]*for \(const plan of safeSendPlan\) \{[\s\S]*t: "file-begin", id: plan\.id, name: plan\.name, size: plan\.size[\s\S]*readBrowserFileChunk\(plan\.file, plan\.slice, offset[\s\S]*sealBulk\(keys, plan\.id, seq, payload\)[\s\S]*encodeChunk\(plan\.id, seq, sealed\)[\s\S]*t: "file-end", id: plan\.id/
  );
  assert.match(distWebBundle, /Browser send plan entry is invalid/);
  assert.match(distWebBundle, /changed before chunk/);
  assert.doesNotMatch(distWebBundle, /o\.file\.stream\(\)\.getReader\(\)/);
});

test("browser sender prehashes deterministic file slices and verifies chunk integrity while sending", () => {
  const sendFromBrowserBody = extractFunctionBody(webSource, "sendFromBrowser");
  const sendPlanBody = extractFunctionBody(webSource, "buildBrowserSendPlan");
  const prepareIndex = sendFromBrowserBody.indexOf('setStatus(sendStatus, "Preparing")');
  const buildPlanIndex = sendFromBrowserBody.indexOf("const sendPlan = await buildBrowserSendPlan(files)");
  const pairRequestIndex = sendFromBrowserBody.indexOf('type: "pair-request"');
  assert.equal(prepareIndex >= 0 && prepareIndex < buildPlanIndex, true);
  assert.equal(buildPlanIndex >= 0 && buildPlanIndex < pairRequestIndex, true);
  assert.doesNotMatch(webSource, /Promise\.all\(files\.map\(async \(file/);
  assert.match(webSource, /async function buildBrowserSendPlan\(files: File\[\]\): Promise<BrowserSendPlanFile\[\]> \{/);
  assert.match(sendPlanBody, /const sendPlan: BrowserSendPlanFile\[\] = \[\];/);
  assert.match(sendPlanBody, /const inputFiles = browserFileInputs\(files\);/);
  assert.match(sendPlanBody, /for \(const file of inputFiles\) \{/);
  assert.match(sendPlanBody, /assertFileWithinLimits\(file\.name, file\.size\);/);
  assert.match(sendPlanBody, /const slice = browserFileSliceMethod\(file\);/);
  assert.match(sendPlanBody, /const \{ sha256, chunkSha256 \} = await hashBrowserFile\(file\);/);
  assert.match(sendPlanBody, /sendPlan\.push\(\{[\s\S]*id: sendPlan\.length,[\s\S]*slice,[\s\S]*sha256,[\s\S]*chunkSha256[\s\S]*\}\);/);
  assert.match(sendPlanBody, /return sendPlan;/);
  assert.match(webSource, /async function hashBrowserFile\(file: File\): Promise<\{ sha256: string; chunkSha256: string\[\] \}> \{/);
  assert.match(webSource, /async function readBrowserFileChunk\(file: File, slice: File\["slice"\], offset: number, length: number, label: string\): Promise<Uint8Array>/);
  assert.match(webSource, /function browserFileInputs\(files: unknown\): File\[\]/);
  assert.match(webSource, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
  assert.match(webSource, /function browserSendPlanInput\(sendPlan: unknown\): BrowserSendPlanFile\[\]/);
  assert.match(webSource, /function browserChunkHashesInput\(value: unknown, size: number\): string\[\]/);
  assert.match(webSource, /!Number\.isInteger\(id\)/);
  assert.match(webSource, /id < 0/);
  assert.match(webSource, /id > 255/);
  assert.match(webSource, /assertFileWithinLimits\(name, size\);/);
  assert.match(webSource, /const currentSlice = browserFileSliceMethod\(file\);/);
  assert.match(webSource, /file\.name !== name \|\| file\.size !== size \|\| \(mime !== undefined && file\.type !== mime\) \|\| slice !== currentSlice/);
  assert.match(webSource, /MAX_BROWSER_CHUNK_HASHES_PER_FILE/);
  assert.match(webSource, /SHA256_HEX/);
  assert.match(distWebBundle, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(distWebBundle, /Browser send plan chunk hashes are invalid/);
  assert.match(distWebBundle, /Browser send plan entry is invalid/);
  assert.match(distWebBundle, /changed while sending/);
  assert.match(
    webSource,
    /for \(let offset = 0; offset < file\.size; offset \+= CHUNK_SIZE\) \{[\s\S]*readBrowserFileChunk\(file, slice, offset, Math\.min\(CHUNK_SIZE, file\.size - offset\), file\.name\)[\s\S]*chunkSha256\.push\(digestHex\(chunkHash\)\);/
  );
  assert.match(webSource, /const blob = slice\.call\(file, offset, offset \+ length\);/);
  assert.match(webSource, /blob instanceof Blob/);
  assert.match(webSource, /bytes instanceof ArrayBuffer/);
  assert.match(webSource, /const expectedChunkSha256 = plan\.chunkSha256\[seq\];/);
  assert.match(webSource, /if \(expectedChunkSha256 === undefined\) throw new Error\(`\$\{plan\.name\} changed while sending\.`\);/);
  assert.match(webSource, /if \(digestHex\(chunkHash\) !== expectedChunkSha256\) throw new Error\(`\$\{plan\.name\} changed before chunk \$\{seq\} could be sent\.`\);/);
  assert.match(webSource, /if \(seq !== plan\.chunkSha256\.length\) throw new Error\(`\$\{plan\.name\} changed while sending\.`\);/);
  assert.match(webSource, /const actualSha256 = digestHex\(hash\);[\s\S]*if \(actualSha256 !== plan\.sha256\) throw new Error\(`\$\{plan\.name\} changed while sending\.`\);/);
});

test("browser sender honors encrypted resume offsets", () => {
  const sendBody = extractFunctionBody(webSource, "sendBrowserFiles");

  assert.match(securityPolicy, /browser and CLI senders must honor encrypted receiver resume offsets on `ready` acknowledgements/);
  assert.match(sendBody, /const readyStates = new Map<number, BrowserReadyState>\(\);/);
  assert.match(sendBody, /readyStates\.set\(message\.id, browserReadyStateInput\(message, message\.id\)\)/);
  assert.match(webSource, /function resumeOffsetInput\(value: unknown, id: number\): number/);
  assert.match(webSource, /function browserReadyStateInput\(message: Extract<ControlMessage, \{ t: "ready" \}>, id: number\): BrowserReadyState/);
  assert.match(webSource, /function verifiedBrowserReadyState\(/);
  assert.match(webSource, /function hashBrowserFilePrefix\(plan: BrowserSendPlanFile, resumeOffset: number\): Promise<string>/);
  assert.match(webSource, /value > MAX_FILE_BYTES/);
  assert.match(webSource, /const prefixSha256 = message\.prefixSha256;\n\s+if \(prefixSha256 === undefined\) throw new Error\(`Invalid ready acknowledgement for file \$\{id\}\.`\);/);
  assert.match(webSource, /if \(ready\.offset > plan\.size \|\| \(ready\.offset < plan\.size && ready\.offset % CHUNK_SIZE !== 0\)\) throw new Error\(`Invalid resume offset for \$\{plan\.name\}\.`\);/);
  assert.match(webSource, /const prefixSha256 = await hashBrowserFilePrefix\(plan, ready\.offset\);[\s\S]*if \(prefixSha256 === ready\.prefixSha256\) return ready;[\s\S]*await sendControl\(control, keys, \{ t: "restart", id: plan\.id \}\);/);
  assert.match(sendBody, /const ready = await verifiedBrowserReadyState\(control, keys, acks, readyStates, plan\);/);
  assert.match(sendBody, /const resumeOffset = ready\.offset;/);
  assert.match(sendBody, /transferred \+= resumeOffset;/);
  assert.match(sendBody, /if \(resumeOffset > 0\) updateProgress\(log, "sent", transferred, totalBytes, startedAt\);/);
  assert.match(sendBody, /let skippedBytes = 0;/);
  assert.match(sendBody, /if \(skippedBytes < resumeOffset\) \{[\s\S]*skippedBytes \+= payload\.byteLength;[\s\S]*\} else \{[\s\S]*sealBulk\(keys, plan\.id, seq, payload\)/);
  assert.match(sendBody, /updateProgress\(log, "sent", transferred, totalBytes, startedAt\)/);
  assert.match(sendBody, /if \(actualSha256 !== plan\.sha256\) throw new Error\(`\$\{plan\.name\} changed while sending\.`\);/);
  assert.match(distWebBundle, /new Map/);
  assert.match(distWebBundle, /offset\?\?0/);
  assert.match(distWebBundle, /Invalid ready acknowledgement for file/);
  assert.match(distWebBundle, /Invalid ready acknowledgement for file/);
});

test("browser sender uses deterministic slices and streamed receive data stays normalized", () => {
  const sendBody = extractFunctionBody(webSource, "sendBrowserFiles");
  const copyBody = extractFunctionBody(webSource, "copyWritableFile");
  const verifyBody = extractFunctionBody(webSource, "verifyWritableFile");

  assert.match(securityPolicy, /browser sender preflight and transfer must hash\/send deterministic `File\.slice\(\)` byte ranges/);
  assert.match(sendBody, /readBrowserFileChunk\(plan\.file, plan\.slice, offset/);
  assert.match(webSource, /async function readBrowserFileChunk[\s\S]*bytes instanceof ArrayBuffer[\s\S]*return new Uint8Array\(bytes\);/);
  assert.match(copyBody, /const chunk = toBytes\(value\);[\s\S]*copiedBytes \+= chunk\.byteLength;[\s\S]*new Uint8Array\(chunk\.byteLength\)[\s\S]*copy\.set\(chunk\)[\s\S]*chunk\.fill\(0\)/);
  assert.match(verifyBody, /const chunk = toBytes\(value\);[\s\S]*hash\.update\(chunk\)[\s\S]*chunk\.fill\(0\)/);
  assert.doesNotMatch(webSource, /value\.byteLength/);
  assert.doesNotMatch(webSource, /value\.subarray/);
  assert.doesNotMatch(webSource, /value\.fill/);
  assert.match(distWebBundle, /changed before chunk/);
  assert.match(distWebBundle, /changed while sending/);
  assert.match(distWebBundle, /Unsupported chunk data/);
  assert.match(distWebBundle, /\.fill\(0\)/);
});

test("browser sender rejects too many files before hashing", () => {
  const fileInputsBody = extractFunctionBody(webSource, "browserFileInputs");
  const sendPlanBody = extractFunctionBody(webSource, "buildBrowserSendPlan");
  const countGuardIndex = fileInputsBody.indexOf("files.length > MAX_FILES_PER_SESSION");
  const hashIndex = sendPlanBody.indexOf("await hashBrowserFile(file)");

  assert.match(securityPolicy, /browser sender preflight must descriptor-validate selected file arrays and enforce file-count limits before hashing any selected files/);
  assert.match(webSource, /MAX_FILES_PER_SESSION/);
  assert.equal(countGuardIndex >= 0, true);
  assert.equal(hashIndex >= 0, true);
  assert.match(fileInputsBody, /throw new Error\(`Too many files\. Limit is \$\{MAX_FILES_PER_SESSION\}\.`\);/);
});

test("browser download fallback uses the selected final output name policy", () => {
  assert.match(webSource, /const name = browserFinalOutputName\(message\.name, opaqueOutputNames\);/);
  assert.match(webSource, /let writableState: Partial<BrowserWritableReceiveFile> = \{\};[\s\S]*if \(directory\) \{[\s\S]*const resumeKey = resume \? await browserResumeKey\(acceptedManifest, expected\) : undefined;[\s\S]*writableState = await createBrowserReceiveFile\(directory, message\.name, message\.size, resumeKey, resume, opaqueOutputNames\);[\s\S]*\}/);
  assert.match(webSource, /anchor\.download = state\.name;/);
});

test("browser receive resume is explicit and limited to saved opaque folder partials", () => {
  const receiveBody = extractFunctionBody(webSource, "receiveBrowserFiles");
  const fileFactoryBody = extractFunctionBody(webSource, "createBrowserReceiveFile");
  const resumeBody = extractFunctionBody(webSource, "resumeBrowserPartialFile");
  const resumeKeyBody = extractFunctionBody(webSource, "browserResumeKey");
  const lookupKeyBody = extractFunctionBody(webSource, "loadBrowserResumeLookupKey");
  const promptBody = extractFunctionBody(webSource, "promptForBrowserAccept");

  assert.match(webSource, /type BrowserReceiveAccept = \{ accepted: true; directory\?: FileSystemDirectoryHandle; resume: boolean; opaqueNames: boolean \} \| \{ accepted: false \};/);
  assert.match(webSource, /<button id="clearResumeButton" class="secondary" type="button">Clear resume records<\/button>/);
  assert.match(webSource, /const clearResumeButton = byId<HTMLButtonElement>\("clearResumeButton"\);/);
  assert.match(webSource, /clearResumeButton\.addEventListener\("click", \(\) => \{[\s\S]*clearBrowserResumeState\(\)[\s\S]*Cleared browser resume records\. Delete old ff-\*\.part files manually from receive folders you previously selected\./);
  assert.match(promptBody, /makeButton\("resumeButton", "Resume in folder", "secondary"\)/);
  assert.match(promptBody, /Resume in folder keeps opaque tokenized \.part files after failures/);
  assert.match(webSource, /receiveBrowserFiles\(control, bulk, keys, recvLog, manifest, accept\.accepted \? accept\.directory : undefined, accept\.accepted \? accept\.resume : false, accept\.accepted \? accept\.opaqueNames : false\)/);
  assert.match(webSource, /resume = false,\n  opaqueOutputNames = false\s*\): Promise<void> \{/);
  assert.match(securityPolicy, /browser receive must not create or load browser resume HMAC key material for ordinary folder receives/);
  assert.match(receiveBody, /const resumeKey = resume \? await browserResumeKey\(acceptedManifest, expected\) : undefined;/);
  assert.match(receiveBody, /createBrowserReceiveFile\(directory, message\.name, message\.size, resumeKey, resume, opaqueOutputNames\)/);
  assert.match(receiveBody, /hash: writableState\.hash \?\? createSha256\(\)/);
  assert.match(receiveBody, /bytes: writableState\.bytes \?\? 0/);
  assert.match(receiveBody, /expectedSeq: writableState\.expectedSeq \?\? 0/);
  assert.match(receiveBody, /state\.bytes > 0 \? \{ t: "ready", id: message\.id, offset: state\.bytes, prefixSha256: digestCloneHex\(state\.hash\) \} : \{ t: "ready", id: message\.id \}/);
  assert.match(receiveBody, /message\.t === "restart"[\s\S]*await restartBrowserReceiveState\(state\)[\s\S]*await sendControl\(control, keys, \{ t: "ready", id: message\.id \}\)/);
  assert.match(webSource, /async function restartBrowserReceiveState\(state: BrowserReceiveState\): Promise<void>/);
  assert.match(webSource, /state\.writable = await state\.fileHandle\.createWritable\(\{ keepExistingData: false \}\)/);
  assert.match(receiveBody, /if \(state\.resume\) \{[\s\S]*await preserveBrowserPartialFile\(state\);[\s\S]*\} else \{[\s\S]*await discardBrowserPartialFile\(state\)/);
  assert.match(webSource, /async function preserveBrowserPartialFile\(state: BrowserReceiveState\): Promise<void> \{[\s\S]*await state\.writable\.close\(\);[\s\S]*await state\.writable\.abort\(\);/);
  assert.match(webSource, /if \(actual !== state\.expectedSha256\) \{[\s\S]*state\.resume = false;[\s\S]*forgetBrowserResumePartial\(state\.resumeKey\);[\s\S]*Hash mismatch/);
  assert.match(fileFactoryBody, /if \(resume\) \{[\s\S]*if \(!resumeKey\) throw new Error\("Browser resume key is required\."\);[\s\S]*const resumed = await resumeBrowserPartialFile\(directory, name, size, resumeKey, opaqueOutputNames\);[\s\S]*if \(resumed\) return resumed;/);
  assert.match(fileFactoryBody, /rememberBrowserResumePartial\(resumeKey, \{ partName: created\.partName, updatedAt: Date\.now\(\) \}\)/);
  assert.match(resumeBody, /assertBrowserOpaquePartFileName\(record\.partName\);/);
  assert.match(resumeBody, /name: browserFinalOutputName\(name, opaqueOutputNames, resumeKey\)/);
  assert.match(resumeBody, /const bytes = browserResumeOffset\(file\.size, size\);/);
  assert.match(resumeBody, /const hash = await hashBrowserPartialPrefix\(file, bytes, name\);/);
  assert.match(resumeBody, /await writable\.write\(\{ type: "truncate", size: bytes \}\);/);
  assert.match(resumeBody, /await writable\.write\(\{ type: "seek", position: bytes \}\);/);
  assert.match(webSource, /function browserResumeOffset\(partialSize: number, expectedSize: number\): number/);
  assert.match(webSource, /if \(partialSize >= expectedSize\) return expectedSize;/);
  assert.match(webSource, /Math\.floor\(partialSize \/ CHUNK_SIZE\) \* CHUNK_SIZE/);
  assert.match(webSource, /const BROWSER_RESUME_STORAGE_KEY = "ff\.browserReceiveResume\.v1";/);
  assert.match(webSource, /const BROWSER_RESUME_KEY_DB = "ff\.browserReceiveResume\.keys\.v1";/);
  assert.match(webSource, /const BROWSER_RESUME_KEY_PREFIX = "ff\.resume\.v2:";/);
  assert.match(webSource, /const BROWSER_RESUME_RECORD_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(resumeKeyBody, /crypto\.subtle\.sign\("HMAC", await browserResumeLookupKey\(\), identity\)/);
  assert.match(resumeKeyBody, /return `\$\{BROWSER_RESUME_KEY_PREFIX\}\$\{hexBytes\(mac\)\}`;/);
  assert.doesNotMatch(resumeKeyBody, /return JSON\.stringify/);
  assert.match(webSource, /function canonicalBrowserResumeIdentity\(manifest: FileManifest, file: TransferManifest\["files"\]\[number\]\): string/);
  assert.match(securityPolicy, /browser receive resume registry keys must be HMAC identifiers over canonical manifest identity using a non-extractable browser-held HMAC-SHA-256 lookup key with 256-bit key material/);
  assert.match(securityPolicy, /production browser deployments that use browser resume should run on a dedicated origin/);
  assert.match(readme, /Host the browser client on a dedicated origin/);
  assert.match(securityPolicy, /missing, invalid, or unavailable browser resume lookup keys must clear the resume registry before a fresh key is used/);
  assert.match(securityPolicy, /browser receive must expose a user-visible clear action that removes origin-stored browser resume registry records, resets the in-memory resume lookup key, and deletes the IndexedDB resume lookup key store/);
  assert.match(readme, /Use `Clear resume records` to remove browser origin resume records and the browser-held resume lookup key/);
  assert.match(webSource, /async function clearBrowserResumeState\(\): Promise<void> \{[\s\S]*clearBrowserResumeRegistry\(\);[\s\S]*browserResumeLookupKeyPromise = undefined;[\s\S]*await deleteBrowserResumeKeyDb\(\);[\s\S]*\}/);
  assert.match(webSource, /function deleteBrowserResumeKeyDb\(\): Promise<void> \{[\s\S]*indexedDB\.deleteDatabase\(BROWSER_RESUME_KEY_DB\)/);
  assert.match(lookupKeyBody, /const stored = await readStoredBrowserResumeLookupKey\(db\);[\s\S]*if \(stored\) return stored;[\s\S]*const created = await createBrowserResumeLookupKey\(\);[\s\S]*await storeBrowserResumeLookupKey\(db, created\);[\s\S]*clearBrowserResumeRegistry\(\);[\s\S]*return created;/);
  assert.match(lookupKeyBody, /catch \{[\s\S]*clearBrowserResumeRegistry\(\);[\s\S]*return createBrowserResumeLookupKey\(\);[\s\S]*\}/);
  assert.match(securityPolicy, /browser receive resume registry values must not persist plaintext file names, MIME types, or sizes/);
  assert.match(securityPolicy, /browser receive resume registry reads must scrub invalid, noncanonical, expired, or legacy metadata-bearing entries, clear stale storage before writing sanitized replacements/);
  assert.match(securityPolicy, /browser receive resume must be explicit and limited to same-browser saved opaque tokenized `.part` records/);
  assert.match(webSource, /type BrowserResumePartialRecord = \{\n  partName: string;\n  updatedAt: number;\n\};/);
  assert.doesNotMatch(webSource, /type BrowserResumePartialRecord = \{(?:(?!\n\};)[\s\S])*finalName:/);
  assert.doesNotMatch(webSource, /type BrowserResumePartialRecord = \{(?:(?!\n\};)[\s\S])*size:/);
  assert.doesNotMatch(webSource, /rememberBrowserResumePartial\(resumeKey, \{(?:(?!\}\);)[\s\S])*(?:finalName|size)/);
  assert.match(webSource, /const \{ name: partName, handle \} = await createAvailableBrowserFile\(directory, opaqueBrowserPartName\(\), browserPartCandidateName\)/);
  assert.equal(webSource.includes("const BROWSER_RESUME_STORAGE_ENTRY_KEY = /^ff\\.resume\\.v2:[a-f0-9]{64}$/;"), true);
  assert.match(webSource, /function isBrowserResumeLookupKey\(value: unknown\): value is CryptoKey \{[\s\S]*value\.type === "secret"[\s\S]*value\.extractable === false[\s\S]*algorithm\.name === "HMAC"[\s\S]*length === 256[\s\S]*hash\.name === "SHA-256"/);
  assert.match(browserInteropTest, /seedInvalidBrowserResumeState\(page\)/);
  assert.match(browserInteropTest, /hash: "SHA-1"/);
  assert.match(browserInteropTest, /browserResumeRegistry\(page\), null/);
  assert.match(browserInteropTest, /browserResumeLookupKeyAlgorithm\(page\), \{ name: "HMAC", hash: "SHA-1", length: 256 \}/);
  assert.match(browserInteropTest, /browserResumeLookupKeyAlgorithm\(page\), \{ name: "HMAC", hash: "SHA-256", length: 256 \}/);
  assert.match(browserInteropTest, /browser folder receiver restarts after a corrupted saved partial/);
  assert.match(browserInteropTest, /corruptFolderPartFile\(page, partial\.partFiles\[0\]!\)/);
  assert.match(browserInteropTest, /operation === `createWritable:\$\{partial\.partFiles\[0\]\}:reset`/);
  assert.match(browserInteropTest, /operation\.startsWith\(`write:\$\{partial\.partFiles\[0\]\}:0:`\)/);
  assert.match(browserInteropTest, /browser startup scrubs legacy resume registry metadata/);
  assert.match(browserInteropTest, /seedLegacyBrowserResumeRegistry\(page\)/);
  assert.match(browserInteropTest, /finalName: "secret-name\.txt"/);
  assert.match(browserInteropTest, /mime: "text\/plain"/);
  assert.match(browserInteropTest, /browserResumeRegistryObject\(page\)/);
  assert.match(webSource, /pruneBrowserResumeRegistry\(\);[\s\S]*const app = document\.querySelector/);
  assert.match(webSource, /function sanitizeBrowserResumeRegistry\(registry: Record<string, unknown>\): Record<string, unknown>/);
  assert.match(webSource, /if \(!BROWSER_RESUME_STORAGE_ENTRY_KEY\.test\(entryKey\)\) \{[\s\S]*changed = true;[\s\S]*continue;/);
  assert.match(webSource, /if \(!browserResumePartialRecordIsFresh\(record\)\) \{[\s\S]*changed = true;[\s\S]*continue;/);
  assert.match(webSource, /function browserResumePartialRecordIsFresh\(record: BrowserResumePartialRecord, now = Date\.now\(\)\): boolean \{[\s\S]*record\.updatedAt <= now && now - record\.updatedAt <= BROWSER_RESUME_RECORD_TTL_MS/);
  assert.match(webSource, /if \(!browserResumePartialRecordIsCanonical\(entryValue, record\)\) changed = true;/);
  assert.match(webSource, /if \(changed\) replaceBrowserResumeRegistry\(sanitized\);/);
  assert.match(webSource, /function replaceBrowserResumeRegistry\(registry: Record<string, unknown>\): void \{[\s\S]*clearBrowserResumeRegistry\(\);[\s\S]*writeBrowserResumeRegistry\(registry\);[\s\S]*\}/);
  assert.match(webSource, /if \(Object\.keys\(registry\)\.length === 0\) \{[\s\S]*window\.localStorage\.removeItem\(BROWSER_RESUME_STORAGE_KEY\);[\s\S]*return;/);
  assert.match(webSource, /keys\.length !== 2 \|\| !keys\.includes\("partName"\) \|\| !keys\.includes\("updatedAt"\)/);
});

test("browser download fallback always schedules Blob URL revocation", () => {
  assert.match(securityPolicy, /browser Blob download fallback must create generic `application\/octet-stream` blobs/);
  assert.match(webSource, /new Blob\(state\.chunks\.map\(\(chunk\) => chunk\.slice\(\)\.buffer\), \{ type: "application\/octet-stream" \}\)/);
  assert.match(securityPolicy, /browser Blob download URLs must be scheduled for revocation even if the synthetic download click throws/);
  assert.match(
    webSource,
    /const url = URL\.createObjectURL\(blob\);[\s\S]*const anchor = document\.createElement\("a"\);[\s\S]*try \{[\s\S]*anchor\.href = url;[\s\S]*anchor\.download = state\.name;[\s\S]*anchor\.click\(\);[\s\S]*\} finally \{[\s\S]*setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 30_000\);[\s\S]*\}/
  );
  assert.match(
    distWebBundle,
    /let n=URL\.createObjectURL\(t\),r=document\.createElement\(`a`\);try\{r\.href=n,r\.download=e\.name,r\.click\(\)\}finally\{setTimeout\(\(\)=>URL\.revokeObjectURL\(n\),3e4\)\}/
  );
});

test("browser folder receive removes a created partial if writable stream creation fails", () => {
  assert.match(
    webSource,
    /const \{ name: partName, handle \} = await createAvailableBrowserFile\(directory, opaqueBrowserPartName\(\), browserPartCandidateName\);[\s\S]*try \{[\s\S]*writable: await handle\.createWritable\(\{ keepExistingData: false \}\)[\s\S]*\} catch \(error\) \{[\s\S]*await directory\.removeEntry\(partName\)\.catch\(ignoreNotFoundError\);[\s\S]*throw error;[\s\S]*\}/
  );
});

test("browser folder publish carries accepted size through partial copy", () => {
  const publishBody = extractFunctionBody(webSource, "publishBrowserPartFile");
  const copyBody = extractFunctionBody(webSource, "copyWritableFile");

  assert.match(securityPolicy, /browser folder receive publish must carry the accepted file size through partial copy and final verification/);
  assert.match(publishBody, /await copyWritableFile\(state\.fileHandle, created\.handle, state\.size\)/);
  assert.match(webSource, /async function copyWritableFile\([\s\S]*expectedSize: number[\s\S]*\): Promise<void>/);
  assert.match(copyBody, /if \(source\.size !== expectedSize\) throw new Error\("Browser partial file size changed before publish\."\)/);
  assert.match(copyBody, /let copiedBytes = 0;/);
  assert.match(copyBody, /copiedBytes \+= chunk\.byteLength;[\s\S]*if \(copiedBytes > expectedSize\) throw new Error\("Browser partial file size changed during publish\."\)/);
  assert.match(copyBody, /if \(copiedBytes !== expectedSize\) throw new Error\("Browser partial file size changed during publish\."\)/);
  assert.match(publishBody, /await verifyWritableFile\(created\.handle, finalName, state\.size, expectedSha256\)/);
  assert.match(distWebBundle, /Browser partial file size changed before publish/);
  assert.match(distWebBundle, /Browser partial file size changed during publish/);
});

test("browser folder publish releases the source reader if target writer creation fails", () => {
  const copyBody = extractFunctionBody(webSource, "copyWritableFile");

  assert.match(securityPolicy, /browser folder receive publish must release source readers even when target writable creation fails/);
  assert.match(copyBody, /const reader = source\.stream\(\)\.getReader\(\);/);
  assert.match(copyBody, /let writable: FileSystemWritableFileStream \| undefined;/);
  assert.match(copyBody, /try \{[\s\S]*writable = await targetHandle\.createWritable\(\{ keepExistingData: false \}\);[\s\S]*\} catch \(error\) \{[\s\S]*if \(writable && !closed\)[\s\S]*await writable\.abort\(\);[\s\S]*\} finally \{[\s\S]*reader\.releaseLock\(\);[\s\S]*\}/);
  assert.doesNotMatch(copyBody, /const writable = await targetHandle\.createWritable/);
  assert.match(distWebBundle, /\.stream\(\)\.getReader\(\)/);
  assert.match(distWebBundle, /\.abort\(\)/);
  assert.match(distWebBundle, /\.releaseLock\(\)/);
  assert.doesNotMatch(distWebBundle, /\.getReader\(\),\w=await \w\.createWritable\(\{keepExistingData:!1\}\),\w=!1/);
});

test("browser default signaling URL does not generate remote plaintext websocket URLs", () => {
  assert.match(webSource, /serverUrl\.value = defaultBrowserServerUrl\(\);/);
  assert.doesNotMatch(webSource, /value="\$\{escapeHtml/);
  assert.doesNotMatch(webSource, /function escapeHtml/);
  assert.match(webSource, /const loopback = hostname === "127\.0\.0\.1" \|\| hostname === "localhost" \|\| hostname === "\[::1\]" \|\| hostname === "::1";/);
  assert.match(webSource, /return `\$\{protocol === "https:" \|\| !loopback \? "wss" : "ws"\}:\/\/\$\{host\}\/v1\/ws`;/);
  assert.doesNotMatch(webSource, /return `\$\{protocol === "https:" \? "wss" : "ws"\}:\/\/\$\{host\}\/v1\/ws`;/);
});

test("browser signaling close disposes handlers and buffered peer data", () => {
  assert.match(securityPolicy, /browser signaling sockets must clear runtime handlers, listener sets, cached ICE config, and buffered early WebRTC signals on close or after a bounded close-dispose grace period/);
  assert.match(webSource, /SIGNALING_CLOSE_GRACE_MS/);
  assert.match(webSource, /private closeTimer\?: ReturnType<typeof setTimeout>/);
  assert.match(webSource, /private disposed = false;/);
  assert.match(webSource, /this\.ws\.onclose = \(\) => \{[\s\S]*this\.clearCloseTimer\(\);[\s\S]*this\.emit\(\{ type: "close", reason: "signaling_closed" \}\);[\s\S]*this\.dispose\(\);[\s\S]*\};/);
  assert.match(webSource, /if \(this\.disposed\) return;[\s\S]*const set = this\.listeners\.get\(type\) \?\? new Set\(\);/);
  assert.match(webSource, /if \(this\.disposed\) throw new Error\("signaling socket is closed"\);/);
  assert.match(webSource, /currentIceServers\(\): RTCIceServer\[\] \| undefined \{[\s\S]*if \(this\.disposed\) return undefined;[\s\S]*return this\.latestIceServers \? cloneIceServers\(this\.latestIceServers\) : undefined;/);
  assert.match(webSource, /if \(this\.disposed\) return \[\];[\s\S]*return this\.earlySignals\.drain\(\);/);
  const closeBody = extractBodyAfterSignature(webSource, "close(): void", "close");
  assert.match(closeBody, /this\.ws\.close\(\);[\s\S]*this\.scheduleCloseDispose\(\);/);
  const disposeBody = extractMethodBody(webSource, "dispose");
  assert.match(disposeBody, /this\.disposed = true/);
  assert.match(disposeBody, /this\.clearCloseTimer\(\)/);
  assert.match(disposeBody, /this\.ws\.onopen = null/);
  assert.match(disposeBody, /this\.ws\.onerror = null/);
  assert.match(disposeBody, /this\.ws\.onmessage = null/);
  assert.match(disposeBody, /this\.ws\.onclose = null/);
  assert.match(disposeBody, /delete this\.latestIceServers/);
  assert.match(disposeBody, /this\.listeners\.clear\(\)/);
  assert.match(disposeBody, /this\.earlySignals\.drain\(\)/);
  const scheduleBody = extractMethodBody(webSource, "scheduleCloseDispose");
  assert.match(scheduleBody, /if \(this\.closeTimer\) return/);
  assert.match(scheduleBody, /setTimeout\(\(\) => \{[\s\S]*delete this\.closeTimer;[\s\S]*this\.dispose\(\);[\s\S]*\}, SIGNALING_CLOSE_GRACE_MS\)/);
  const clearBody = extractMethodBody(webSource, "clearCloseTimer");
  assert.match(clearBody, /clearTimeout\(this\.closeTimer\)/);
  assert.match(clearBody, /delete this\.closeTimer/);
  assert.match(distWebBundle, /signaling_closed/);
  assert.match(distWebBundle, /\.ws\.close\(\)/);
  assert.match(distWebBundle, /\.dispose\(\)/);
  assert.match(distWebBundle, /\.ws\.onopen=null/);
  assert.match(distWebBundle, /delete this\.closeTimer/);
  assert.match(distWebBundle, /clearTimeout\(this\.closeTimer\)/);
});

test("browser signaling clients reject open reuse", () => {
  const openBody = extractBodyAfterSignature(webSource, "open(): Promise<void>", "open");

  assert.match(securityPolicy, /browser signaling clients must reject `open\(\)` reuse after construction/);
  assert.match(webSource, /private openStarted = false;/);
  assert.match(openBody, /if \(this\.disposed\) return Promise\.reject\(new Error\("browser signaling client is closed"\)\)/);
  assert.match(openBody, /if \(this\.openStarted \|\| this\.ws\.readyState !== WebSocket\.CONNECTING\)/);
  assert.match(openBody, /if \(this\.ws\.readyState === WebSocket\.CLOSED\) this\.dispose\(\)/);
  assert.match(openBody, /browser signaling client already has an active socket/);
  assert.match(openBody, /this\.openStarted = true;[\s\S]*return new Promise/);
  assert.match(distWebBundle, /openStarted=!1;disposed=!1/);
  assert.match(distWebBundle, /browser signaling client already has an active socket/);
});

test("browser signaling failed opens self-close because callers cannot clean them up", () => {
  const openBody = extractBodyAfterSignature(webSource, "open(): Promise<void>", "open");
  const failedOpenCleanupBody = extractMethodBody(webSource, "closeSocketAfterFailedOpen");

  assert.match(securityPolicy, /browser signaling connection failures before `open\(\)` resolves must close and dispose their own WebSocket/);
  assert.match(openBody, /const fail = \(error: Error\) => \{[\s\S]*detachFailedConnect\(\);[\s\S]*this\.closeSocketAfterFailedOpen\(\);[\s\S]*reject\(error\);[\s\S]*\};/);
  assert.match(failedOpenCleanupBody, /this\.ws\.readyState === WebSocket\.OPEN \|\| this\.ws\.readyState === WebSocket\.CONNECTING/);
  assert.match(failedOpenCleanupBody, /this\.ws\.close\(\)/);
  assert.match(failedOpenCleanupBody, /this\.dispose\(\)/);
});

function extractMethodBody(source: string, name: string): string {
  const signature = `private ${name}(`;
  return extractBodyAfterSignature(source, signature, name);
}

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  return extractBodyAfterSignature(source, signature, name);
}

function extractBodyAfterSignature(source: string, signature: string, name: string): string {
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
  const bundleNames = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, "dist-web must contain exactly one browser JS bundle");
  return fs.readFileSync(new URL(bundleNames[0]!, assetsDir), "utf8");
}
