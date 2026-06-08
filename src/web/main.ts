import {
  BROWSER_BLOB_FALLBACK_MAX_BYTES,
  CHUNK_SIZE,
  CONNECT_TIMEOUT_MS,
  DATA_CHANNEL_BUFFER_HIGH,
  DATA_CHANNEL_BUFFER_LOW,
  DEFAULT_ICE_SERVERS,
  DEFAULT_SERVER_URL,
  MAX_BUFFERED_SIGNAL_MESSAGES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  RECEIVE_QUEUE_MAX_BYTES,
  RECEIVE_QUEUE_MAX_MESSAGES,
  SIGNALING_MAX_BUFFERED_BYTES,
  MAX_QUEUED_ICE_CANDIDATES,
  PAIR_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECEIVER_MAX_PREPAIR_ATTEMPTS,
  SIGNALING_CLOSE_GRACE_MS,
  TRANSFER_CONTROL_TIMEOUT_MS
} from "../shared/constants.js";
import { decodeChunk, encodeChunk } from "../shared/chunks.js";
import { ControlAckWaiter } from "../shared/control-waiter.js";
import { formatBytes, formatRate } from "../shared/format.js";
import { createSha256, digestCloneHex, digestHex, type Sha256 } from "../shared/hash.js";
import { assertFileWithinLimits, assertManifestWithinLimits, assertTransferManifestWithinLimits, safeFileName } from "../shared/limits.js";
import type { ErrorCode, FileManifest, ServerMessage, SignalPayload } from "../shared/messages.js";
import { isServerMessage, parseBrowserJsonMessage, serializeMessage, signalingErrorDisplayMessage } from "../shared/messages.js";
import { sanitizeDisplayText } from "../shared/output-safety.js";
import { redactManifestForSignaling } from "../shared/public-manifest.js";
import { normalizeSignalingServerUrl } from "../shared/server-url.js";
import { signalingBackpressureExceeded } from "../shared/signaling-backpressure.js";
import { WebRtcSignalReplayGuard } from "../shared/signal-replay.js";
import { SignalMessageQueue, type SignalServerMessage } from "../shared/signal-queue.js";
import { cloneIceServers, hasRelayIceServer } from "../shared/ice.js";
import {
  openBulk,
  openControl,
  openManifest,
  ownPakeShareB64,
  pairDecisionAuthTag,
  parsePakeShareMessage,
  sdpAuthTag,
  sealBulk,
  sealControl,
  sealManifest,
  sessionConfirmTag,
  signalAuthTag,
  startPake,
  finishPake,
  verifyPairDecisionAuthTag,
  verifySessionConfirmTag,
  verifySignalAuthTag,
  wipePakeState,
  wipeSessionKeys,
  type PakeRole,
  type SessionKeys
} from "../shared/security.js";
import { abortControlMessage, assertControlMessage, assertSenderControlMessage, assertTransferManifestMatchesAccepted, remoteAbortError, type TransferManifest, type ControlMessage } from "../shared/transfer.js";
import { assertBrowserOpaquePartFileName, createAvailableBrowserFile, ignoreNotFoundError, isNotFoundError } from "./file-system.js";
import { generateCode, normalizeCode, parseCode } from "../shared/wordlist.js";
import { browserFinalCandidateName, browserPartCandidateName, opaqueBrowserOutputName, opaqueBrowserPartName, randomizedBrowserOutputName } from "./file-names.js";
import "./styles.css";

type BrowserReceiveState = {
  id: number;
  name: string;
  partName?: string;
  publishedName?: string;
  resumeKey?: string;
  resume: boolean;
  size: number;
  chunks: Uint8Array<ArrayBuffer>[];
  writable?: FileSystemWritableFileStream;
  fileHandle?: FileSystemFileHandle;
  directory?: FileSystemDirectoryHandle;
  hash: Sha256;
  bytes: number;
  expectedSha256?: string;
  expectedSeq: number;
  done: boolean;
  finalizing: boolean;
};

type BrowserReceiveAccept = { accepted: true; directory?: FileSystemDirectoryHandle; resume: boolean; opaqueNames: boolean } | { accepted: false };

type BrowserResumePartialRecord = {
  partName: string;
  updatedAt: number;
};

type BrowserResumeLookupKey = {
  key: CryptoKey;
  persistent: boolean;
};

type BrowserResumeKey = {
  key: string;
  persistent: boolean;
};

type BrowserResumeClearResult = {
  records: number;
  removed: number;
  folderSelected: boolean;
  cleanupFailed: boolean;
};

type BrowserSendPlanFile = {
  id: number;
  name: string;
  size: number;
  mime?: string;
  file: File;
  slice: File["slice"];
  sha256: string;
  chunkSha256: string[];
};

type BrowserReadyState = {
  offset: number;
  prefixSha256?: string;
};

class BrowserSignalingError extends Error {
  constructor(
    readonly code: ErrorCode
  ) {
    super(signalingErrorDisplayMessage(code));
    this.name = "BrowserSignalingError";
  }
}

const RECEIVE_CODE_GENERATION_ATTEMPTS = 10;
const STATIC_HTML_POLICY_NAME = "ff-static";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_BROWSER_CHUNK_HASHES_PER_FILE = Math.ceil(MAX_FILE_BYTES / CHUNK_SIZE);
const BROWSER_RESUME_STORAGE_KEY = "ff.browserReceiveResume.v1";
const BROWSER_RESUME_KEY_DB = "ff.browserReceiveResume.keys.v1";
const BROWSER_RESUME_KEY_STORE = "keys";
const BROWSER_RESUME_LOOKUP_KEY_ID = "lookup";
const BROWSER_RESUME_KEY_PREFIX = "ff.resume.v2:";
const BROWSER_RESUME_STORAGE_ENTRY_KEY = /^ff\.resume\.v2:[a-f0-9]{64}$/;
const MAX_BROWSER_RESUME_RECORDS = 200;
const BROWSER_RESUME_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const browserResumeText = new TextEncoder();
let browserResumeLookupKeyPromise: Promise<BrowserResumeLookupKey> | undefined;
const BROWSER_WAIT_MESSAGE_TYPES = new Set<ServerMessage["type"]>([
  "registered",
  "peer-joined",
  "pake",
  "confirm",
  "pair-request",
  "pair-accept",
  "pair-reject",
  "signal",
  "peer-left",
  "ice-config",
  "error"
]);
const BROWSER_WAIT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

pruneBrowserResumeRegistry();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

app.innerHTML = staticTrustedHtml`
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>ff transfer</h1>
        <p>Peer-to-peer file sharing with a tiny signaling server.</p>
      </div>
      <div class="serverControls">
        <label class="server">
          <span>Server</span>
          <input id="serverUrl" spellcheck="false" />
        </label>
        <label class="serverIce">
          <input id="serverIce" type="checkbox" checked />
          <span>Server ICE/TURN</span>
        </label>
        <label class="serverIce">
          <input id="relayOnly" type="checkbox" />
          <span>Relay only</span>
        </label>
        <label class="serverIce">
          <input id="folderOnly" type="checkbox" />
          <span>Folder only</span>
        </label>
        <label class="serverIce">
          <input id="opaqueNames" type="checkbox" />
          <span>Opaque output names</span>
        </label>
      </div>
    </header>

    <section class="workspace" aria-label="Transfer tools">
      <form id="sendForm" class="panel">
        <div class="panelHeader">
          <h2>Send</h2>
          <span id="sendStatus" class="status">Idle</span>
        </div>
        <label>
          <span>Receiver code</span>
          <input id="sendCode" placeholder="123456789012-apple-anchor" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span>Files</span>
          <input id="fileInput" type="file" multiple />
        </label>
        <button type="submit">Send files</button>
        <pre id="sendLog" class="log" aria-live="polite"></pre>
      </form>

      <section class="panel">
        <div class="panelHeader">
          <h2>Receive</h2>
          <span id="recvStatus" class="status">Idle</span>
        </div>
        <button id="receiveButton" type="button">Start receiving</button>
        <button id="clearResumeButton" class="secondary" type="button">Clear resume records</button>
        <div id="codeBox" class="codeBox" hidden></div>
        <div id="requestBox" class="requestBox" hidden></div>
        <pre id="recvLog" class="log" aria-live="polite"></pre>
      </section>
    </section>
  </main>
`;

const serverUrl = byId<HTMLInputElement>("serverUrl");
serverUrl.value = defaultBrowserServerUrl();
const serverIce = byId<HTMLInputElement>("serverIce");
const relayOnly = byId<HTMLInputElement>("relayOnly");
const folderOnly = byId<HTMLInputElement>("folderOnly");
const opaqueNames = byId<HTMLInputElement>("opaqueNames");
const sendForm = byId<HTMLFormElement>("sendForm");
const sendCode = byId<HTMLInputElement>("sendCode");
const fileInput = byId<HTMLInputElement>("fileInput");
const sendStatus = byId<HTMLSpanElement>("sendStatus");
const sendLog = byId<HTMLPreElement>("sendLog");
const receiveButton = byId<HTMLButtonElement>("receiveButton");
const clearResumeButton = byId<HTMLButtonElement>("clearResumeButton");
const recvStatus = byId<HTMLSpanElement>("recvStatus");
const recvLog = byId<HTMLPreElement>("recvLog");
const codeBox = byId<HTMLDivElement>("codeBox");
const requestBox = byId<HTMLDivElement>("requestBox");
const sendButton = requireElement(sendForm.querySelector<HTMLButtonElement>('button[type="submit"]'), "send submit button");

let sendBusy = false;
let receiveBusy = false;

sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (operationBusy()) return;
  sendBusy = true;
  updateOperationControls();
  sendFromBrowser()
    .catch((error) => {
      setStatus(sendStatus, "Failed");
      setLog(sendLog, topLevelBrowserErrorMessage(error, "send"));
    })
    .finally(() => {
      clearBrowserSendInputs();
      sendBusy = false;
      updateOperationControls();
    });
});

receiveButton.addEventListener("click", () => {
  if (operationBusy()) return;
  receiveBusy = true;
  updateOperationControls();
  receiveInBrowser()
    .catch((error) => {
      setStatus(recvStatus, "Failed");
      setLog(recvLog, topLevelBrowserErrorMessage(error, "receive"));
    })
    .finally(() => {
      receiveBusy = false;
      updateOperationControls();
    });
});

clearResumeButton.addEventListener("click", () => {
  if (operationBusy()) return;
  receiveBusy = true;
  updateOperationControls();
  clearBrowserResumeState()
    .then((result) => setLog(recvLog, browserResumeClearMessage(result)))
    .catch((error) => setLog(recvLog, errorMessage(error)))
    .finally(() => {
      receiveBusy = false;
      updateOperationControls();
    });
});

async function sendFromBrowser(): Promise<void> {
  const code = normalizeCode(sendCode.value);
  const parsedCode = parseRequiredCode(code);
  const files = Array.from(fileInput.files ?? []);
  if (files.length === 0) throw new Error("Choose at least one file.");

  setStatus(sendStatus, "Preparing");
  const sendPlan = await buildBrowserSendPlan(files);
  const manifest = browserSendPlanManifest(sendPlan);

  setStatus(sendStatus, "Connecting");
  let signaling: BrowserSignaling | undefined;
  let pc: RTCPeerConnection | undefined;
  let keys: SessionKeys | undefined;
  let sid: string | undefined;
  let finished = false;
  let unwireSignals: (() => void) | undefined;
  let unwireIce: (() => void) | undefined;
  try {
    signaling = await openSignaling();
    const joined = await connectCode(signaling, parsedCode.rendezvous);
    sid = joined.sid;
    keys = await establishBrowserKeys(signaling, joined.sid, "sender", parsedCode.handle);
    setLog(sendLog, `SAS ${keys.sas}`);
    const sealedManifest = await sealManifest(keys, manifest);
    signaling.send({ type: "pair-request", sid: joined.sid, manifest: redactManifestForSignaling(manifest), sealedManifest });
    setStatus(sendStatus, "Waiting");
    await waitForAuthenticatedPairAccept(signaling, joined.sid, keys, sealedManifest);
    const iceServers = await getIceServers(signaling, shouldUseBrowserServerIce());

    pc = new RTCPeerConnection(browserRtcConfiguration(iceServers));
    const signalWire = wireSignals(signaling, pc, joined.sid, keys, false);
    unwireSignals = signalWire.dispose;
    unwireIce = wireBrowserIceCandidates(signaling, pc, joined.sid, keys.signalAuthKey, "sender");
    const control = pc.createDataChannel("control", { ordered: true });
    const bulk = pc.createDataChannel("bulk", { ordered: true });
    bulk.binaryType = "arraybuffer";
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offerSdp = requireSdp(pc.localDescription?.sdp ?? offer.sdp);
    signaling.send({ type: "signal", sid: joined.sid, signal: { kind: "offer", sdp: offerSdp, auth: sdpAuthTag(keys.signalAuthKey, joined.sid, "sender", "offer", offerSdp) } });
    await Promise.race([Promise.all([waitOpen(control), waitOpen(bulk), waitPeerConnected(pc)]), signalWire.failure]);
    unwireIce();
    unwireIce = undefined;
    signalWire.dispose();
    unwireSignals = undefined;

    setStatus(sendStatus, "Sending");
    await sendBrowserFiles(control, bulk, keys, sendPlan, sendLog);
    safeBrowserSend(signaling, { type: "bye", sid: joined.sid, reason: "complete" });
    finished = true;
    setStatus(sendStatus, "Done");
  } finally {
    if (!finished && sid) safeBrowserSend(signaling, { type: "bye", sid, reason: "error" });
    unwireIce?.();
    unwireSignals?.();
    wipeSessionKeys(keys);
    pc?.close();
    signaling?.close();
    clearBrowserSendSecrets();
  }
}

async function receiveInBrowser(): Promise<void> {
  setStatus(recvStatus, "Registering");
  const requireFolderReceive = shouldRequireBrowserFolderReceive();
  const opaqueOutputNames = shouldUseBrowserOpaqueNames();
  if (requireFolderReceive && !canPickBrowserDirectory()) throw new Error("Folder-only receive requires File System Access.");
  let signaling: BrowserSignaling | undefined;
  let pc: RTCPeerConnection | undefined;
  let keys: SessionKeys | undefined;
  let sid: string | undefined;
  let finished = false;
  let unwireSignals: (() => void) | undefined;
  let unwireIce: (() => void) | undefined;
  try {
    signaling = await openSignaling();
    const registeredCode = await registerBrowserReceiver(signaling);
    const parsedCode = registeredCode.parsedCode;
    codeBox.hidden = false;
    codeBox.textContent = parsedCode.handle;
    setStatus(recvStatus, "Waiting");

    for (let pairRequestRetry = 0; ; pairRequestRetry += 1) {
      const joined = await waitForConfirmedBrowserReceiverSession(signaling, parsedCode.handle);
      sid = joined.sid;
      keys = joined.keys;
      let manifest: FileManifest;
      let sealedManifest: string;
      try {
        const request = await waitForSession(signaling, "pair-request", joined.sid, PAIR_TIMEOUT_MS);
        sealedManifest = request.sealedManifest;
        manifest = await openManifest<FileManifest>(keys, request.sealedManifest);
        assertTransferManifestWithinLimits(manifest);
      } catch (error) {
        if (pairRequestRetry >= RECEIVER_MAX_PREPAIR_ATTEMPTS - 1) throw error;
        safeBrowserSend(signaling, { type: "bye", sid: joined.sid, reason: "prepair_retry" });
        wipeSessionKeys(keys);
        keys = undefined;
        sid = undefined;
        assertRegisteredRendezvous(await waitFor(signaling, "registered", CONNECT_TIMEOUT_MS), parsedCode.rendezvous);
        setStatus(recvStatus, "Waiting");
        setLog(recvLog, "Ignored an invalid transfer request. Still waiting...");
        continue;
      }
      const accept = await promptForBrowserAccept(manifest, keys.sas, requireFolderReceive, opaqueOutputNames);
      if (!accept.accepted) {
        safeBrowserSend(signaling, { type: "pair-reject", sid: joined.sid, reason: "user_declined", auth: pairDecisionAuthTag(keys.signalAuthKey, joined.sid, "receiver", "reject", sealedManifest, "user_declined") });
        finished = true;
        setStatus(recvStatus, "Declined");
        return;
      }

      signaling.send({ type: "pair-accept", sid: joined.sid, auth: pairDecisionAuthTag(keys.signalAuthKey, joined.sid, "receiver", "accept", sealedManifest) });
      const iceServers = await getIceServers(signaling, shouldUseBrowserServerIce());
      pc = new RTCPeerConnection(browserRtcConfiguration(iceServers));
      const channels = waitIncomingChannels(pc);
      const signalWire = wireSignals(signaling, pc, joined.sid, keys, true);
      unwireSignals = signalWire.dispose;
      unwireIce = wireBrowserIceCandidates(signaling, pc, joined.sid, keys.signalAuthKey, "receiver");
      const { control, bulk } = await Promise.race([channels, signalWire.failure]);
      await Promise.race([Promise.all([waitOpen(control), waitOpen(bulk), waitPeerConnected(pc)]), signalWire.failure]);
      unwireIce();
      unwireIce = undefined;
      signalWire.dispose();
      unwireSignals = undefined;
      setStatus(recvStatus, "Receiving");
      await receiveBrowserFiles(control, bulk, keys, recvLog, manifest, accept.accepted ? accept.directory : undefined, accept.accepted ? accept.resume : false, accept.accepted ? accept.opaqueNames : false);
      safeBrowserSend(signaling, { type: "bye", sid: joined.sid, reason: "complete" });
      finished = true;
      setStatus(recvStatus, "Done");
      break;
    }
  } finally {
    if (!finished && sid) safeBrowserSend(signaling, { type: "bye", sid, reason: "error" });
    unwireIce?.();
    unwireSignals?.();
    wipeSessionKeys(keys);
    pc?.close();
    signaling?.close();
    clearBrowserReceiveSecrets();
  }
}

async function registerBrowserReceiver(
  signaling: BrowserSignaling
): Promise<{ parsedCode: ReturnType<typeof parseRequiredCode>; registered: Extract<ServerMessage, { type: "registered" }> }> {
  for (let attempt = 1; attempt <= RECEIVE_CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const parsedCode = parseRequiredCode(generateCode());
    signaling.send({ type: "register", role: "receiver", code: parsedCode.rendezvous, protocolVersion: PROTOCOL_VERSION });
    try {
      const registered = await waitFor(signaling, "registered", CONNECT_TIMEOUT_MS);
      assertRegisteredRendezvous(registered, parsedCode.rendezvous);
      return { parsedCode, registered };
    } catch (error) {
      if (error instanceof BrowserSignalingError && error.code === "code_taken") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a receive code after repeated collisions.");
}

async function sendBrowserFiles(control: RTCDataChannel, bulk: RTCDataChannel, keys: SessionKeys, sendPlan: BrowserSendPlanFile[], log: HTMLElement): Promise<void> {
  const acks = new ControlAckWaiter(TRANSFER_CONTROL_TIMEOUT_MS);
  let failed: Error | undefined;
  let completed = false;
  let senderControlQueue: Promise<void> = Promise.resolve();
  const readyStates = new Map<number, BrowserReadyState>();
  const cleanupSenderChannels = () => {
    control.onmessage = null;
    control.onclose = null;
    control.onerror = null;
    bulk.onclose = null;
    bulk.onerror = null;
  };
  const enqueueSenderControl = (task: () => Promise<void>): void => {
    senderControlQueue = senderControlQueue.then(task, task);
    senderControlQueue.catch(() => {});
  };
  const failSender = (message: string) => {
    enqueueSenderControl(async () => {
      if (completed) return;
      failed = new Error(message);
      acks.fail(failed);
    });
  };
  const throwIfSenderFailed = async () => {
    await senderControlQueue;
    if (failed) throw failed;
  };
  const handleSenderControl = async (data: unknown) => {
    if (completed) return;
    try {
      const message = assertSenderControlMessage(assertControlMessage(await openControl<unknown>(keys, data)));
      if (message.t === "ready") {
        readyStates.set(message.id, browserReadyStateInput(message, message.id));
        if (!acks.mark("ready", message.id)) throw new Error(`Unexpected ready acknowledgement for file ${message.id}.`);
      } else if (message.t === "file-ok") {
        if (!acks.mark("file-ok", message.id)) throw new Error(`Unexpected file-ok acknowledgement for file ${message.id}.`);
      } else if (message.t === "all-done-ok") {
        if (!acks.mark("all-done-ok")) throw new Error("Unexpected all-done-ok acknowledgement.");
        completed = true;
      } else if (message.t === "abort") {
        failed = remoteAbortError();
        acks.fail(failed);
      }
    } catch (error) {
      if (completed) return;
      failed = error instanceof Error ? error : new Error(safeErrorMessage(error));
      acks.fail(failed);
    }
  };
  control.onclose = () => failSender("Control channel closed before transfer completed.");
  bulk.onclose = () => failSender("Bulk channel closed before transfer completed.");
  control.onerror = () => failSender("Control channel errored before transfer completed.");
  bulk.onerror = () => failSender("Bulk channel errored before transfer completed.");
  control.onmessage = async (event) => {
    enqueueSenderControl(() => handleSenderControl(event.data));
  };

  try {
    const safeSendPlan = browserSendPlanInput(sendPlan);
    const transferManifest = browserSendPlanManifest(safeSendPlan);
    const transferFiles = transferManifest.files as TransferManifest["files"];
    const totalBytes = transferManifest.totalBytes;
    let transferred = 0;
    const startedAt = Date.now();
    await sendControl(control, keys, {
      t: "manifest",
      files: transferFiles,
      totalBytes
    }, throwIfSenderFailed);

    for (const plan of safeSendPlan) {
      await throwIfSenderFailed();
      await sendControl(control, keys, { t: "file-begin", id: plan.id, name: plan.name, size: plan.size }, throwIfSenderFailed);
      await acks.wait("ready", plan.id);
      await throwIfSenderFailed();
      const ready = await verifiedBrowserReadyState(control, keys, acks, readyStates, plan, throwIfSenderFailed);
      const resumeOffset = ready.offset;
      transferred += resumeOffset;
      if (resumeOffset > 0) updateProgress(log, "sent", transferred, totalBytes, startedAt);
      const hash = createSha256();
      let seq = 0;
      let fileBytes = 0;
      let skippedBytes = 0;
      for (let offset = 0; offset < plan.size; offset += CHUNK_SIZE) {
        if (failed) throw failed;
        const payload = await readBrowserFileChunk(plan.file, plan.slice, offset, Math.min(CHUNK_SIZE, plan.size - offset), plan.name);
        try {
          await throwIfSenderFailed();
          if (fileBytes + payload.byteLength > plan.size) throw new Error("Selected file changed while sending.");
          const expectedChunkSha256 = plan.chunkSha256[seq];
          if (expectedChunkSha256 === undefined) throw new Error("Selected file changed while sending.");
          const chunkHash = createSha256();
          chunkHash.update(payload);
          if (digestHex(chunkHash) !== expectedChunkSha256) throw new Error("Selected file changed while sending.");
          hash.update(payload);
          if (skippedBytes < resumeOffset) {
            skippedBytes += payload.byteLength;
          } else {
            const sealed = await sealBulk(keys, plan.id, seq, payload);
            try {
              await throwIfSenderFailed();
              bulk.send(encodeChunk(plan.id, seq, sealed));
            } finally {
              sealed.fill(0);
            }
            transferred += payload.byteLength;
            updateProgress(log, "sent", transferred, totalBytes, startedAt);
            await waitBackpressure(bulk);
            await throwIfSenderFailed();
          }
          seq += 1;
          fileBytes += payload.byteLength;
        } finally {
          payload.fill(0);
        }
      }
      if (seq !== plan.chunkSha256.length) throw new Error("Selected file changed while sending.");
      if (fileBytes !== plan.size) throw new Error("Selected file changed while sending.");
      const actualSha256 = digestHex(hash);
      if (actualSha256 !== plan.sha256) throw new Error("Selected file changed while sending.");
      await throwIfSenderFailed();
      await sendControl(control, keys, { t: "file-end", id: plan.id, sha256: actualSha256 }, throwIfSenderFailed);
      await acks.wait("file-ok", plan.id);
    }
    await throwIfSenderFailed();
    await sendControl(control, keys, { t: "all-done" }, throwIfSenderFailed);
    await acks.wait("all-done-ok");
  } catch (error) {
    try {
      await sendControl(control, keys, abortControlMessage(error));
    } catch {
      // The peer may already have closed the control channel.
    }
    throw error;
  } finally {
    cleanupSenderChannels();
  }
}

function resumeOffsetInput(value: unknown, id: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > MAX_FILE_BYTES) throw new Error(`Invalid ready acknowledgement for file ${id}.`);
  return value;
}

function browserReadyStateInput(message: Extract<ControlMessage, { t: "ready" }>, id: number): BrowserReadyState {
  const offset = resumeOffsetInput(message.offset ?? 0, id);
  if (offset === 0) return { offset };
  const prefixSha256 = message.prefixSha256;
  if (prefixSha256 === undefined) throw new Error(`Invalid ready acknowledgement for file ${id}.`);
  return { offset, prefixSha256 };
}

async function verifiedBrowserReadyState(
  control: RTCDataChannel,
  keys: SessionKeys,
  acks: ControlAckWaiter,
  readyStates: Map<number, BrowserReadyState>,
  plan: BrowserSendPlanFile,
  throwIfSenderFailed: () => Promise<void>
): Promise<BrowserReadyState> {
  for (;;) {
    await throwIfSenderFailed();
    const ready = readyStates.get(plan.id) ?? { offset: 0 };
    readyStates.delete(plan.id);
    if (ready.offset > plan.size || (ready.offset < plan.size && ready.offset % CHUNK_SIZE !== 0)) throw new Error(`Invalid resume offset for file ${plan.id}.`);
    if (ready.offset === 0) return ready;
    const prefixSha256 = await hashBrowserFilePrefix(plan, ready.offset);
    await throwIfSenderFailed();
    if (prefixSha256 === ready.prefixSha256) return ready;
    const restarted = acks.wait("ready", plan.id);
    await sendControl(control, keys, { t: "restart", id: plan.id });
    await restarted;
  }
}

async function hashBrowserFilePrefix(plan: BrowserSendPlanFile, resumeOffset: number): Promise<string> {
  const hash = createSha256();
  for (let offset = 0; offset < resumeOffset; offset += CHUNK_SIZE) {
    const payload = await readBrowserFileChunk(plan.file, plan.slice, offset, Math.min(CHUNK_SIZE, resumeOffset - offset), plan.name);
    try {
      hash.update(payload);
    } finally {
      payload.fill(0);
    }
  }
  return digestHex(hash);
}

async function buildBrowserSendPlan(files: File[]): Promise<BrowserSendPlanFile[]> {
  const inputFiles = browserFileInputs(files);
  const sendPlan: BrowserSendPlanFile[] = [];
  for (const file of inputFiles) {
    assertFileWithinLimits(file.name, file.size);
    const slice = browserFileSliceMethod(file);
    const { sha256, chunkSha256 } = await hashBrowserFile(file);
    sendPlan.push({
      id: sendPlan.length,
      name: file.name,
      size: file.size,
      ...(file.type ? { mime: file.type } : {}),
      file,
      slice,
      sha256,
      chunkSha256
    });
  }
  return sendPlan;
}

function browserSendPlanManifest(sendPlan: BrowserSendPlanFile[]): FileManifest {
  const safeSendPlan = browserSendPlanInput(sendPlan);
  const manifest: FileManifest = {
    files: safeSendPlan.map(({ id, name, size, mime }) => (mime === undefined ? { id, name, size } : { id, name, size, mime })),
    fileCount: safeSendPlan.length,
    totalBytes: safeSendPlan.reduce((sum, file) => sum + file.size, 0)
  };
  assertTransferManifestWithinLimits(manifest);
  return manifest;
}

async function hashBrowserFile(file: File): Promise<{ sha256: string; chunkSha256: string[] }> {
  file = browserFileInput(file);
  const slice = browserFileSliceMethod(file);
  const hash = createSha256();
  const chunkSha256: string[] = [];
  let bytesRead = 0;
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const payload = await readBrowserFileChunk(file, slice, offset, Math.min(CHUNK_SIZE, file.size - offset), file.name);
    const chunkHash = createSha256();
    try {
      if (bytesRead + payload.byteLength > file.size) throw new Error("Selected file changed while preparing the transfer.");
      hash.update(payload);
      chunkHash.update(payload);
      chunkSha256.push(digestHex(chunkHash));
      bytesRead += payload.byteLength;
    } finally {
      payload.fill(0);
    }
  }
  if (bytesRead !== file.size) throw new Error("Selected file changed while preparing the transfer.");
  return { sha256: digestHex(hash), chunkSha256 };
}

function browserFileInputs(files: unknown): File[] {
  if (!Array.isArray(files)) throw new Error("Browser file list is invalid.");
  if (files.length === 0) throw new Error("Choose at least one file.");
  if (files.length > MAX_FILES_PER_SESSION) throw new Error(`Too many files. Limit is ${MAX_FILES_PER_SESSION}.`);
  const out: File[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Browser file entry is invalid.");
    out.push(browserFileInput(descriptor.value));
  }
  return out;
}

function browserFileInput(value: unknown): File {
  if (!(value instanceof File)) throw new Error("Browser file entry is invalid.");
  return value;
}

function browserFileSliceMethod(file: File): File["slice"] {
  const slice = dataMethod(file, "slice");
  if (typeof slice !== "function") throw new Error("Browser file entry is invalid.");
  return slice as File["slice"];
}

async function readBrowserFileChunk(file: File, slice: File["slice"], offset: number, length: number, _label: string): Promise<Uint8Array> {
  const blob = slice.call(file, offset, offset + length);
  if (!(blob instanceof Blob) || blob.size !== length) throw new Error("Selected file changed while reading.");
  const arrayBuffer = dataMethod(blob, "arrayBuffer");
  if (typeof arrayBuffer !== "function") throw new Error("Selected file changed while reading.");
  const bytes = await arrayBuffer.call(blob);
  if (!(bytes instanceof ArrayBuffer) || Object.getPrototypeOf(bytes) !== ArrayBuffer.prototype || bytes.byteLength !== length) {
    throw new Error("Selected file changed while reading.");
  }
  return new Uint8Array(bytes);
}

function browserSendPlanInput(sendPlan: unknown): BrowserSendPlanFile[] {
  if (!Array.isArray(sendPlan)) throw new Error("Browser send plan is invalid.");
  if (sendPlan.length === 0 || sendPlan.length > MAX_FILES_PER_SESSION) throw new Error("Browser send plan is invalid.");
  const out: BrowserSendPlanFile[] = [];
  for (let index = 0; index < sendPlan.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(sendPlan, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Browser send plan entry is invalid.");
    out.push(browserSendPlanFileInput(descriptor.value));
  }
  return out;
}

function browserSendPlanFileInput(value: unknown): BrowserSendPlanFile {
  if (!value || typeof value !== "object") throw new Error("Browser send plan entry is invalid.");
  const id = ownDataValue(value, "id");
  const name = ownDataValue(value, "name");
  const size = ownDataValue(value, "size");
  const mime = ownDataValue(value, "mime");
  const file = ownDataValue(value, "file");
  const slice = ownDataValue(value, "slice");
  const sha256 = ownDataValue(value, "sha256");
  const chunkSha256 = ownDataValue(value, "chunkSha256");
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id < 0 ||
    id > 255 ||
    typeof name !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_FILE_BYTES ||
    (mime !== undefined && typeof mime !== "string") ||
    !(file instanceof File) ||
    typeof slice !== "function" ||
    typeof sha256 !== "string" ||
    !SHA256_HEX.test(sha256)
  ) {
    throw new Error("Browser send plan entry is invalid.");
  }
  assertFileWithinLimits(name, size);
  const currentSlice = browserFileSliceMethod(file);
  if (file.name !== name || file.size !== size || (mime !== undefined && file.type !== mime) || slice !== currentSlice) {
    throw new Error("Browser send plan entry is invalid.");
  }
  const chunkHashes = browserChunkHashesInput(chunkSha256, size);
  return { id, name, size, ...(mime === undefined ? {} : { mime }), file, slice: currentSlice, sha256, chunkSha256: chunkHashes };
}

function browserChunkHashesInput(value: unknown, size: number): string[] {
  if (!Array.isArray(value)) throw new Error("Browser send plan chunk hashes are invalid.");
  const expectedChunks = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
  if (value.length !== expectedChunks || value.length > MAX_BROWSER_CHUNK_HASHES_PER_FILE) throw new Error("Browser send plan chunk hashes are invalid.");
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !SHA256_HEX.test(descriptor.value)) {
      throw new Error("Browser send plan chunk hashes are invalid.");
    }
    out.push(descriptor.value);
  }
  return out;
}

async function receiveBrowserFiles(
  control: RTCDataChannel,
  bulk: RTCDataChannel,
  keys: SessionKeys,
  log: HTMLElement,
  acceptedManifest: FileManifest,
  directory?: FileSystemDirectoryHandle,
  resume = false,
  opaqueOutputNames = false
): Promise<void> {
  const states = new Map<number, BrowserReceiveState>();
  let manifest: TransferManifest | undefined;
  const expectedFiles = new Map<number, TransferManifest["files"][number]>();
  let totalBytes = 0;
  let transferred = 0;
  const startedAt = Date.now();
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  let failed = false;
  let completed = false;
  let allDoneSeen = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let localReceiveWorkDepth = 0;

  const maybeResolveDone = async () => {
    if (!allDoneSeen) return;
    for (const state of states.values()) {
      if (!state.done) return;
    }
    clearReceiveTimeout();
    await sendControl(control, keys, { t: "all-done-ok" }, throwIfReceiveStopped);
    completed = true;
    resolveDone();
  };

  const clearReceiveTimeout = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const detachChannels = () => {
    control.onmessage = null;
    control.onclose = null;
    control.onerror = null;
    bulk.onmessage = null;
    bulk.onclose = null;
    bulk.onerror = null;
  };

  const closeChannels = () => {
    try {
      control.close();
    } catch {
      // The channel may already be closed.
    }
    try {
      bulk.close();
    } catch {
      // The channel may already be closed.
    }
  };

  const failTransfer = async (error: unknown) => {
    if (failed || completed) return;
    failed = true;
    clearReceiveTimeout();
    detachChannels();
    try {
      await sendControl(control, keys, abortControlMessage(error));
    } catch {
      // Best-effort peer notification; local cleanup remains authoritative.
    }
    closeChannels();
    rejectDone(error instanceof Error ? error : new Error(safeErrorMessage(error)));
  };

  const throwIfReceiveStopped = () => {
    if (failed) throw new Error("Transfer stopped during local browser receive work.");
    if (completed) throw new Error("Transfer completed during local browser receive work.");
  };

  const resetReceiveTimeout = () => {
    clearReceiveTimeout();
    if (failed || completed || localReceiveWorkDepth > 0) return;
    idleTimer = setTimeout(() => {
      void failTransfer(new Error("Transfer timed out waiting for peer data."));
    }, TRANSFER_CONTROL_TIMEOUT_MS);
  };

  const withLocalReceiveWork = async <T>(work: () => Promise<T>): Promise<T> => {
    throwIfReceiveStopped();
    localReceiveWorkDepth += 1;
    clearReceiveTimeout();
    try {
      const result = await work();
      throwIfReceiveStopped();
      return result;
    } finally {
      localReceiveWorkDepth -= 1;
      resetReceiveTimeout();
    }
  };

  let receiveQueue: Promise<void> = Promise.resolve();
  let queuedReceiveBytes = 0;
  let queuedReceiveMessages = 0;
  const enqueueReceiveTask = (data: unknown, task: () => Promise<void>): Promise<void> => {
    if (failed || completed) return receiveQueue;
    const byteLength = receiveQueueByteLength(data);
    if (queuedReceiveBytes + byteLength > RECEIVE_QUEUE_MAX_BYTES || queuedReceiveMessages + 1 > RECEIVE_QUEUE_MAX_MESSAGES) {
      void failTransfer(new Error("Receive queue backpressure exceeded."));
      return receiveQueue;
    }
    queuedReceiveBytes += byteLength;
    queuedReceiveMessages += 1;
    const runTask = async () => {
      try {
        await task();
      } finally {
        queuedReceiveBytes -= byteLength;
        queuedReceiveMessages -= 1;
      }
    };
    receiveQueue = receiveQueue.then(runTask, runTask);
    receiveQueue.catch(() => {});
    return receiveQueue;
  };

  const failOnChannelClose = () => {
    void failTransfer(new Error("Transfer channel closed before completion."));
  };
  const failOnChannelError = () => {
    void failTransfer(new Error("Transfer channel errored before completion."));
  };
  control.onclose = failOnChannelClose;
  bulk.onclose = failOnChannelClose;
  control.onerror = failOnChannelError;
  bulk.onerror = failOnChannelError;
  resetReceiveTimeout();

  const handleControlMessage = async (data: unknown) => {
    if (failed || completed) return;
    resetReceiveTimeout();
    try {
      const message = assertControlMessage(await openControl<unknown>(keys, data));
      throwIfReceiveStopped();
      if (message.t === "manifest") {
        if (manifest) throw new Error("Duplicate transfer manifest.");
        manifest = message;
        for (const file of message.files) expectedFiles.set(file.id, file);
        assertManifestWithinLimits({ files: message.files, fileCount: message.files.length, totalBytes: message.totalBytes });
        assertTransferManifestMatchesAccepted(acceptedManifest, message);
        if (!directory && message.totalBytes > BROWSER_BLOB_FALLBACK_MAX_BYTES) {
          throw new Error(`This browser requires Save to folder for transfers over ${formatBytes(BROWSER_BLOB_FALLBACK_MAX_BYTES)}.`);
        }
        totalBytes = message.totalBytes;
      } else if (message.t === "file-begin") {
        if (!manifest) throw new Error("file-begin arrived before manifest.");
        const expected = expectedFiles.get(message.id);
        if (!expected) throw new Error(`file-begin for unexpected file ${message.id}`);
        if (states.has(message.id)) throw new Error(`Duplicate file-begin for file ${message.id}`);
        if (expected.name !== message.name || expected.size !== message.size) throw new Error(`file-begin does not match manifest for file ${message.id}`);
        assertFileWithinLimits(message.name, message.size);
        const name = browserFinalOutputName(message.name, opaqueOutputNames);
        let writableState: Partial<BrowserWritableReceiveFile> = {};
        if (directory) {
          const resumeKey = resume ? await browserResumeKey(acceptedManifest, expected) : undefined;
          writableState = await withLocalReceiveWork(() => createBrowserReceiveFile(directory, message.name, message.size, resumeKey?.key, resume, opaqueOutputNames, resumeKey?.persistent ?? false));
        }
        states.set(message.id, {
          id: message.id,
          name,
          size: message.size,
          chunks: [],
          resume,
          ...writableState,
          hash: writableState.hash ?? createSha256(),
          bytes: writableState.bytes ?? 0,
          expectedSeq: writableState.expectedSeq ?? 0,
          done: false,
          finalizing: false
        });
        const state = states.get(message.id)!;
        if (state.bytes > 0) {
          transferred += state.bytes;
          updateProgress(log, "received", transferred, totalBytes, startedAt);
        }
        await sendControl(control, keys, state.bytes > 0 ? { t: "ready", id: message.id, offset: state.bytes, prefixSha256: digestCloneHex(state.hash) } : { t: "ready", id: message.id }, throwIfReceiveStopped);
      } else if (message.t === "restart") {
        const state = states.get(message.id);
        if (!state) throw new Error(`Unknown file ${message.id}`);
        if (state.done || state.expectedSha256) throw new Error(`restart for completed file ${message.id}`);
        transferred = Math.max(0, transferred - state.bytes);
        await withLocalReceiveWork(() => restartBrowserReceiveState(state));
        updateProgress(log, "received", transferred, totalBytes, startedAt);
        await sendControl(control, keys, { t: "ready", id: message.id }, throwIfReceiveStopped);
      } else if (message.t === "file-end") {
        const state = states.get(message.id);
        if (!state) throw new Error(`Unknown file ${message.id}`);
        if (state.expectedSha256) throw new Error(`Duplicate file-end for file ${message.id}`);
        state.expectedSha256 = message.sha256;
        await withLocalReceiveWork(() => maybeDownload(state, control, keys, throwIfReceiveStopped));
        await maybeResolveDone();
      } else if (message.t === "all-done") {
        if (!manifest) throw new Error("all-done arrived before manifest.");
        if (allDoneSeen) throw new Error("Duplicate all-done control message.");
        if (states.size !== expectedFiles.size) throw new Error("Not all manifest files were transferred.");
        allDoneSeen = true;
        await maybeResolveDone();
      } else if (message.t === "abort") {
        throw remoteAbortError();
      } else {
        throw new Error(`Unexpected receiver control message: ${message.t}.`);
      }
    } catch (error) {
      await failTransfer(error);
    }
  };

  control.onmessage = (event) => enqueueReceiveTask(event.data, () => handleControlMessage(event.data));

  const handleBulkMessage = async (data: unknown) => {
    if (failed || completed) return;
    resetReceiveTimeout();
    try {
      const frame = decodeChunk(toBytes(data));
      const state = states.get(frame.fileId);
      if (!state) throw new Error(`Unknown file ${frame.fileId}`);
      if (state.done || (state.expectedSha256 && state.bytes >= state.size)) throw new Error(`chunk for completed file ${frame.fileId}`);
      if (frame.chunkSeq !== state.expectedSeq) throw new Error(`Unexpected chunk sequence for file ${state.id}.`);
      const copy = await openBulk(keys, frame.fileId, frame.chunkSeq, frame.payload);
      try {
        throwIfReceiveStopped();
        if (copy.byteLength === 0) throw new Error(`Empty chunk for file ${state.id}.`);
        if (state.bytes + copy.byteLength > state.size) throw new Error(`Received more bytes than declared for file ${state.id}.`);
        state.expectedSeq += 1;
        if (state.writable) {
          const writeCopy = new Uint8Array(copy.byteLength) as Uint8Array<ArrayBuffer>;
          writeCopy.set(copy);
          try {
            await withLocalReceiveWork(() => state.writable!.write(writeCopy));
          } finally {
            writeCopy.fill(0);
          }
        } else {
          const memoryCopy = new Uint8Array(copy.byteLength) as Uint8Array<ArrayBuffer>;
          memoryCopy.set(copy);
          state.chunks.push(memoryCopy);
        }
        state.hash.update(copy);
        state.bytes += copy.byteLength;
        transferred += copy.byteLength;
        updateProgress(log, "received", transferred, totalBytes, startedAt);
        await withLocalReceiveWork(() => maybeDownload(state, control, keys, throwIfReceiveStopped));
        await maybeResolveDone();
      } finally {
        copy.fill(0);
        frame.payload.fill(0);
      }
    } catch (error) {
      await failTransfer(error);
    }
  };

  bulk.onmessage = (event) => enqueueReceiveTask(event.data, () => handleBulkMessage(event.data));

  let doneError: unknown;
  try {
    await done;
  } catch (error) {
    doneError = error;
    throw error;
  } finally {
    clearReceiveTimeout();
    detachChannels();
    let cleanupError: unknown;
    for (const state of states.values()) {
      if (!state.done) {
        wipeChunks(state.chunks);
        state.chunks = [];
        if (state.publishedName) {
          try {
            await discardBrowserPartialFile(state);
            if (state.resumeKey) forgetBrowserResumePartial(state.resumeKey);
          } catch (error) {
            cleanupError ??= error;
            // Final publication started but the peer acknowledgement failed; remove visible output if the browser still allows it.
          }
        } else if (state.resume) {
          try {
            await preserveBrowserPartialFile(state);
          } catch (error) {
            cleanupError ??= error;
            // The browser may already have closed or discarded the partial file.
          }
        } else {
          try {
            await discardBrowserPartialFile(state);
            if (state.resumeKey) forgetBrowserResumePartial(state.resumeKey);
          } catch (error) {
            cleanupError ??= error;
            // The browser may have already closed or discarded the partial file.
          }
        }
      }
    }
    if (!doneError && cleanupError) throw cleanupError;
  }
}

async function maybeDownload(state: BrowserReceiveState, control: RTCDataChannel, keys: SessionKeys, throwIfReceiveStopped: () => void): Promise<void> {
  if (state.done || state.finalizing || !state.expectedSha256 || state.bytes < state.size) return;
  state.finalizing = true;
  try {
    const actual = digestHex(state.hash);
    if (actual !== state.expectedSha256) {
      state.resume = false;
      if (state.resumeKey) forgetBrowserResumePartial(state.resumeKey);
      throw new Error(`Hash mismatch for file ${state.id}.`);
    }
    if (state.writable) {
      await state.writable.close();
      throwIfReceiveStopped();
      if (!state.fileHandle || !state.partName) throw new Error("Missing browser partial file handle.");
      await verifyWritableFile(state.fileHandle, state.partName, state.size, actual);
      throwIfReceiveStopped();
      const fileOk = await sealControl(keys, { t: "file-ok", id: state.id });
      throwIfReceiveStopped();
      const publishedName = await publishBrowserPartFile(state, actual, throwIfReceiveStopped);
      state.name = publishedName;
      state.publishedName = publishedName;
      throwIfReceiveStopped();
      if (state.resumeKey) forgetBrowserResumePartial(state.resumeKey);
      control.send(fileOk);
    } else {
      const fileOk = await sealControl(keys, { t: "file-ok", id: state.id });
      throwIfReceiveStopped();
      const blob = new Blob(state.chunks, { type: "application/octet-stream" });
      wipeChunks(state.chunks);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = state.name;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      throwIfReceiveStopped();
      control.send(fileOk);
    }
    state.chunks = [];
    state.done = true;
  } catch (error) {
    state.finalizing = false;
    throw error;
  }
}

async function restartBrowserReceiveState(state: BrowserReceiveState): Promise<void> {
  wipeChunks(state.chunks);
  state.chunks = [];
  if (state.writable) {
    try {
      await state.writable.abort();
    } catch {
      // The browser may have already closed the stale partial writer.
    }
    if (!state.fileHandle) throw new Error("Missing browser partial file handle.");
    state.writable = await state.fileHandle.createWritable({ keepExistingData: false });
  }
  state.hash = createSha256();
  state.bytes = 0;
  state.expectedSeq = 0;
}

function wipeChunks(chunks: Uint8Array<ArrayBuffer>[]): void {
  for (const chunk of chunks) chunk.fill(0);
}

async function promptForBrowserAccept(manifest: FileManifest, sas: string, requireFolderReceive = false, opaqueOutputNames = false): Promise<BrowserReceiveAccept> {
  const canUseMemoryFallback = !requireFolderReceive && manifest.totalBytes <= BROWSER_BLOB_FALLBACK_MAX_BYTES;
  const hasDirectoryPicker = canPickBrowserDirectory();
  const canResumeInFolder = hasDirectoryPicker && manifest.fileCount === 1;
  requestBox.hidden = false;
  requestBox.replaceChildren();
  const summary = document.createElement("strong");
  summary.textContent = `${manifest.fileCount} file(s), ${formatBytes(manifest.totalBytes)}`;
  requestBox.append(summary);

  const sasLine = document.createElement("p");
  sasLine.className = "sas";
  sasLine.textContent = `SAS ${sas}`;
  requestBox.append(sasLine);

  const list = document.createElement("ul");
  for (const file of manifest.files) {
    const item = document.createElement("li");
    item.append(document.createTextNode(`${safeFileName(file.name)} `));
    const size = document.createElement("span");
    size.textContent = formatBytes(file.size);
    item.append(size);
    list.append(item);
  }
  requestBox.append(list);

  if (!canUseMemoryFallback) {
    const warning = document.createElement("p");
    warning.className = "sas";
    warning.textContent = requireFolderReceive ? "Folder-only receive requires folder streaming." : "Large transfers require folder streaming.";
    requestBox.append(warning);
  }
  if (canResumeInFolder) {
    const resumeNote = document.createElement("p");
    resumeNote.className = "sas";
    resumeNote.textContent = "Resume in folder keeps the opaque tokenized .part file after failures and reuses only a saved opaque partial entry for the same single-file manifest.";
    requestBox.append(resumeNote);
  }
  const pickerStatus = document.createElement("p");
  pickerStatus.className = "sas";
  pickerStatus.hidden = true;
  requestBox.append(pickerStatus);

  const actions = document.createElement("div");
  actions.className = "actions";
  const acceptButton = canUseMemoryFallback ? makeButton("acceptButton", "Accept") : undefined;
  const folderButton = hasDirectoryPicker ? makeButton("folderButton", "Save to folder", "secondary") : undefined;
  const resumeButton = canResumeInFolder ? makeButton("resumeButton", "Resume in folder", "secondary") : undefined;
  const declineButton = makeButton("declineButton", "Decline", "secondary");
  if (acceptButton) actions.append(acceptButton);
  if (folderButton) actions.append(folderButton);
  if (resumeButton) actions.append(resumeButton);
  actions.append(declineButton);
  requestBox.append(actions);

  return new Promise((resolve) => {
    const setPickerButtonsDisabled = (disabled: boolean) => {
      if (acceptButton) acceptButton.disabled = disabled;
      if (folderButton) folderButton.disabled = disabled;
      if (resumeButton) resumeButton.disabled = disabled;
      declineButton.disabled = disabled;
    };
    const chooseDirectory = async (resumeChoice: boolean) => {
      pickerStatus.hidden = true;
      setPickerButtonsDisabled(true);
      requestBox.hidden = true;
      try {
        const directory = await window.showDirectoryPicker!();
        clearBrowserPairRequest();
        resolve({ accepted: true, directory, resume: resumeChoice, opaqueNames: opaqueOutputNames });
      } catch {
        pickerStatus.textContent = "Folder selection cancelled.";
        pickerStatus.hidden = false;
        requestBox.hidden = false;
        setPickerButtonsDisabled(false);
      }
    };
    if (acceptButton) {
      acceptButton.onclick = () => {
        clearBrowserPairRequest();
        resolve({ accepted: true, resume: false, opaqueNames: opaqueOutputNames });
      };
    }
    if (folderButton) {
      folderButton.onclick = async () => {
        await chooseDirectory(false);
      };
    }
    if (resumeButton) {
      resumeButton.onclick = async () => {
        await chooseDirectory(true);
      };
    }
    declineButton.onclick = () => {
      clearBrowserPairRequest();
      resolve({ accepted: false });
    };
  });
}

function clearBrowserSendSecrets(): void {
  clearBrowserSendInputs();
  sendLog.textContent = "";
}

function clearBrowserSendInputs(): void {
  clearBrowserSendCode();
  fileInput.value = "";
}

function clearBrowserSendCode(): void {
  sendCode.value = "";
}

function clearBrowserReceiveSecrets(): void {
  codeBox.textContent = "";
  codeBox.hidden = true;
  clearBrowserPairRequest();
}

function clearBrowserPairRequest(): void {
  requestBox.replaceChildren();
  requestBox.hidden = true;
}

function makeButton(id: string, label: string, className?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  return button;
}

class BrowserSignaling {
  private ws: WebSocket;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Map<BrowserSignalingEventType, Set<(message: BrowserSignalingEvent) => void>>();
  private latestIceServers?: RTCIceServer[];
  private readonly earlySignals = new SignalMessageQueue(MAX_BUFFERED_SIGNAL_MESSAGES, SIGNALING_MAX_BUFFERED_BYTES);
  private openStarted = false;
  private disposed = false;

  constructor(url: string) {
    this.ws = new WebSocket(normalizeSignalingServerUrl(url));
  }

  open(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("browser signaling client is closed"));
    if (this.openStarted || this.ws.readyState !== WebSocket.CONNECTING) {
      if (this.ws.readyState === WebSocket.CLOSED) this.dispose();
      return Promise.reject(new Error("browser signaling client already has an active socket"));
    }
    this.openStarted = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("Timed out connecting to signaling server."));
        this.ws.close();
      }, CONNECT_TIMEOUT_MS);
      const cleanupConnect = () => {
        clearTimeout(timer);
        this.ws.onopen = null;
      };
      const detachFailedConnect = () => {
        cleanupConnect();
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.onmessage = null;
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        this.ws.onerror = () => {
          this.emit({ type: "error", code: "peer_unavailable", message: "Signaling socket error." });
        };
        this.ws.onclose = () => {
          this.clearCloseTimer();
          this.emit({ type: "close", reason: "signaling_closed" });
          this.dispose();
        };
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        detachFailedConnect();
        this.closeSocketAfterFailedOpen();
        reject(error);
      };
      this.ws.onopen = () => succeed();
      this.ws.onerror = () => {
        fail(new Error("Could not connect to signaling server."));
      };
      this.ws.onclose = () => {
        fail(new Error("Signaling socket closed before connection opened."));
      };
      this.ws.onmessage = (event) => {
        const parsed = parseBrowserJsonMessage(event.data);
        if (!isServerMessage(parsed)) {
          this.emit({ type: "error", code: "bad_message", message: "Malformed signaling server message." });
          this.close();
          return;
        }
        if (parsed.type === "ice-config") this.latestIceServers = cloneIceServers(parsed.iceServers);
        this.emit(parsed);
      };
    });
  }

  on(type: BrowserSignalingEventType, handler: (message: BrowserSignalingEvent) => void): void {
    if (this.disposed) return;
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  off(type: BrowserSignalingEventType, handler: (message: BrowserSignalingEvent) => void): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(type);
  }

  send(message: Parameters<typeof serializeMessage>[0]): void {
    if (this.disposed) throw new Error("signaling socket is closed");
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("signaling socket is not open");
    if (signalingBackpressureExceeded(this.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
      this.close();
      throw new Error("signaling socket backpressure exceeded");
    }
    this.ws.send(serializeMessage(message));
    if (signalingBackpressureExceeded(this.ws, SIGNALING_MAX_BUFFERED_BYTES)) {
      this.close();
      throw new Error("signaling socket backpressure exceeded");
    }
  }

  close(): void {
    if (this.disposed) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.dispose();
      return;
    }
    this.ws.close();
    this.scheduleCloseDispose();
  }

  currentIceServers(): RTCIceServer[] | undefined {
    if (this.disposed) return undefined;
    return this.latestIceServers ? cloneIceServers(this.latestIceServers) : undefined;
  }

  drainSignalMessages(): SignalServerMessage[] {
    if (this.disposed) return [];
    return this.earlySignals.drain();
  }

  isClosed(): boolean {
    return this.disposed || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED;
  }

  private emit(message: BrowserSignalingEvent): void {
    if (this.disposed) return;
    if (message.type === "signal" && !this.listeners.get("signal")?.size) {
      try {
        this.earlySignals.push(message);
      } catch (error) {
        this.emit({ type: "error", code: "bad_message", message: safeErrorMessage(error) });
        this.close();
      }
      return;
    }
    this.listeners.get(message.type)?.forEach((handler) => handler(message));
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCloseTimer();
    this.ws.onopen = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    delete this.latestIceServers;
    this.listeners.clear();
    this.earlySignals.drain();
  }

  private scheduleCloseDispose(): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => {
      delete this.closeTimer;
      this.dispose();
    }, SIGNALING_CLOSE_GRACE_MS);
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    delete this.closeTimer;
  }

  private closeSocketAfterFailedOpen(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close();
      } catch {
        // The browser may already be tearing down the failed socket.
      }
    }
    this.dispose();
  }
}

type BrowserSignalingCloseEvent = { type: "close"; reason?: string };
type BrowserSignalingEvent = ServerMessage | BrowserSignalingCloseEvent;
type BrowserSignalingEventType = ServerMessage["type"] | BrowserSignalingCloseEvent["type"];

async function openSignaling(): Promise<BrowserSignaling> {
  const signaling = new BrowserSignaling(serverUrl.value.trim());
  await signaling.open();
  return signaling;
}

async function getIceServers(signaling: BrowserSignaling, useServerIce: boolean): Promise<RTCIceServer[]> {
  if (!useServerIce) return cloneIceServers(DEFAULT_ICE_SERVERS);
  const cached = signaling.currentIceServers();
  if (cached) return cached;
  if (signaling.isClosed()) throw new Error("Signaling socket closed.");
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signaling.off("ice-config", onIceConfig);
      signaling.off("error", onError);
      signaling.off("close", onClose);
    };
    const onIceConfig = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      if (message.type === "ice-config") {
        cleanup();
        resolve(cloneIceServers(message.iceServers));
      }
    };
    const onError = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      cleanup();
      reject(message.type === "error" ? new BrowserSignalingError(message.code) : new Error("Signaling error"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Signaling socket closed."));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(cloneIceServers(DEFAULT_ICE_SERVERS));
    }, 1000);
    signaling.on("ice-config", onIceConfig);
    signaling.on("error", onError);
    signaling.on("close", onClose);
  });
}

function shouldUseBrowserServerIce(): boolean {
  return serverIce.checked;
}

function shouldUseBrowserRelayOnly(): boolean {
  return relayOnly.checked;
}

function shouldRequireBrowserFolderReceive(): boolean {
  return folderOnly.checked;
}

function shouldUseBrowserOpaqueNames(): boolean {
  return opaqueNames.checked;
}

function canPickBrowserDirectory(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

function browserRtcConfiguration(iceServers: RTCIceServer[]): RTCConfiguration {
  const relayOnlySelected = shouldUseBrowserRelayOnly();
  if (relayOnlySelected && !hasRelayIceServer(iceServers)) throw new Error("Relay-only ICE requires a TURN server.");
  return { iceServers, iceTransportPolicy: relayOnlySelected ? "relay" : "all" };
}

function connectCode(signaling: BrowserSignaling, code: string) {
  signaling.send({ type: "connect", role: "sender", code, protocolVersion: PROTOCOL_VERSION });
  return waitFor(signaling, "peer-joined", CONNECT_TIMEOUT_MS);
}

function parseRequiredCode(code: string) {
  const parsed = parseCode(code);
  if (!parsed) throw new Error("Code must look like 123456789012-two-words.");
  return parsed;
}

function assertRegisteredRendezvous(message: Extract<ServerMessage, { type: "registered" }>, expected: string): void {
  if (message.code !== expected) throw new Error("Signaling server returned a mismatched rendezvous code.");
}

async function establishBrowserKeys(signaling: BrowserSignaling, sid: string, role: "sender" | "receiver", code: string): Promise<SessionKeys> {
  const state = startPake(role, code, sid);
  const waitAbort = new AbortController();
  let keys: SessionKeys | undefined;
  let peerWait: Promise<Extract<ServerMessage, { type: "pake" }>> | undefined;
  let confirmWait: Promise<Extract<ServerMessage, { type: "confirm" }>> | undefined;
  try {
    peerWait = waitFor(signaling, "pake", CONNECT_TIMEOUT_MS, sid, waitAbort.signal);
    confirmWait = waitFor(signaling, "confirm", CONNECT_TIMEOUT_MS, sid, waitAbort.signal);
    peerWait.catch(() => {});
    confirmWait.catch(() => {});
    signaling.send({ type: "pake", sid, data: JSON.stringify({ t: "cpace-share", share: ownPakeShareB64(state) }) });
    const peer = await peerWait;
    keys = await finishPake(state, parsePakeShareMessage(peer.data));
    signaling.send({ type: "confirm", sid, tag: sessionConfirmTag(keys.signalAuthKey, sid, role, keys.protocolVersion) });
    const confirm = await confirmWait;
    const peerRole = role === "sender" ? "receiver" : "sender";
    if (!verifySessionConfirmTag(keys.signalAuthKey, sid, peerRole, confirm.tag, keys.protocolVersion)) {
      throw new Error("PAKE confirmation failed. Wrong code or signaling MITM.");
    }
    return keys;
  } catch (error) {
    waitAbort.abort();
    wipePakeState(state);
    wipeSessionKeys(keys);
    throw error;
  }
}

async function waitForConfirmedBrowserReceiverSession(signaling: BrowserSignaling, code: string): Promise<{ sid: string; keys: SessionKeys }> {
  const expectedRendezvous = parseRequiredCode(code).rendezvous;
  for (let attempt = 1; attempt <= RECEIVER_MAX_PREPAIR_ATTEMPTS; attempt += 1) {
    const joined = await waitFor(signaling, "peer-joined", PAIR_TIMEOUT_MS);
    try {
      return { sid: joined.sid, keys: await establishBrowserKeys(signaling, joined.sid, "receiver", code) };
    } catch (error) {
      if (!isPrePairRetryable(error) || attempt >= RECEIVER_MAX_PREPAIR_ATTEMPTS) throw error;
      safeBrowserSend(signaling, { type: "bye", sid: joined.sid, reason: "prepair_retry" });
      assertRegisteredRendezvous(await waitFor(signaling, "registered", CONNECT_TIMEOUT_MS), expectedRendezvous);
      setStatus(recvStatus, "Waiting");
      setLog(recvLog, "Ignored an invalid pairing attempt. Still waiting...");
    }
  }
  throw new Error("Too many invalid pairing attempts.");
}

function isPrePairRetryable(error: unknown): boolean {
  const message = safeErrorMessage(error);
  return /PAKE confirmation failed|invalid PAKE|Peer disconnected|Timed out waiting for (?:pake|confirm)/i.test(message);
}

async function waitForSession<T extends Extract<ServerMessage, { sid: string }>["type"]>(
  signaling: BrowserSignaling,
  type: T,
  sid: string,
  timeoutMs: number
): Promise<Extract<ServerMessage, { type: T }>> {
  return waitFor(signaling, type, timeoutMs, sid);
}

function waitFor<T extends ServerMessage["type"]>(
  signaling: BrowserSignaling,
  type: T,
  timeoutMs: number,
  sid?: string,
  signal?: AbortSignal
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const waitType = browserWaitMessageType(type);
    const waitTimeoutMs = browserWaitTimeout(timeoutMs);
    const waitSid = browserWaitSid(sid);
    const waitSignal = browserWaitAbortSignal(signal);
    if (signaling.isClosed()) {
      reject(new Error("Signaling socket closed."));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signaling.off(waitType, onType);
      signaling.off("error", onError);
      signaling.off("peer-left", onPeerLeft);
      signaling.off("close", onClose);
      waitSignal?.removeEventListener("abort", onAbort);
    };
    const succeed = (message: Extract<ServerMessage, { type: T }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(message);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onType = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      if (message.type !== waitType) return;
      if (waitSid !== undefined && "sid" in message && message.sid !== waitSid) return;
      succeed(message as Extract<ServerMessage, { type: T }>);
    };
    const onError = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      fail(message.type === "error" ? new BrowserSignalingError(message.code) : new Error("Signaling error"));
    };
    const onPeerLeft = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      if (waitSid === undefined || !("sid" in message) || message.sid !== waitSid) return;
      fail(new Error("Peer disconnected."));
    };
    const onClose = () => {
      fail(new Error("Signaling socket closed."));
    };
    const onAbort = () => {
      fail(new Error(`Cancelled waiting for ${waitType}`));
    };
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for ${waitType}`));
    }, waitTimeoutMs);
    if (waitSignal?.aborted) {
      cleanup();
      reject(new Error(`Cancelled waiting for ${waitType}`));
      return;
    }
    waitSignal?.addEventListener("abort", onAbort, { once: true });
    signaling.on(waitType, onType);
    signaling.on("error", onError);
    signaling.on("peer-left", onPeerLeft);
    signaling.on("close", onClose);
  });
}

function waitForAuthenticatedPairAccept(signaling: BrowserSignaling, sid: string, keys: SessionKeys, sealedManifest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signaling.isClosed()) {
      reject(new Error("Signaling socket closed."));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signaling.off("pair-accept", onPairAccept);
      signaling.off("pair-reject", onPairReject);
      signaling.off("error", onError);
      signaling.off("peer-left", onPeerLeft);
      signaling.off("close", onClose);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onPairAccept = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message) || message.type !== "pair-accept" || message.sid !== sid) return;
      if (verifyPairDecisionAuthTag(keys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, message.auth)) {
        succeed();
      } else {
        fail(new Error("Authenticated pair decision check failed. Wrong code or signaling MITM."));
      }
    };
    const onPairReject = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message) || message.type !== "pair-reject" || message.sid !== sid) return;
      if (verifyPairDecisionAuthTag(keys.signalAuthKey, sid, "receiver", "reject", sealedManifest, message.reason, message.auth)) {
        fail(new Error(pairRejectMessage(message.reason)));
      } else {
        fail(new Error("Authenticated pair decision check failed. Wrong code or signaling MITM."));
      }
    };
    const onError = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message)) return;
      fail(message.type === "error" ? new BrowserSignalingError(message.code) : new Error("Signaling error"));
    };
    const onPeerLeft = (message: BrowserSignalingEvent) => {
      if (!isServerMessage(message) || message.type !== "peer-left" || message.sid !== sid) return;
      fail(new Error("Peer disconnected."));
    };
    const onClose = () => {
      fail(new Error("Signaling socket closed."));
    };
    const timer = setTimeout(() => {
      fail(new Error("Timed out waiting for pair decision"));
    }, PAIR_TIMEOUT_MS);
    signaling.on("pair-accept", onPairAccept);
    signaling.on("pair-reject", onPairReject);
    signaling.on("error", onError);
    signaling.on("peer-left", onPeerLeft);
    signaling.on("close", onClose);
  });
}

function browserWaitMessageType(type: unknown): ServerMessage["type"] {
  if (typeof type !== "string" || !BROWSER_WAIT_MESSAGE_TYPES.has(type as ServerMessage["type"])) throw new Error("Browser signaling wait message type is invalid.");
  return type as ServerMessage["type"];
}

function browserWaitTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PAIR_TIMEOUT_MS) {
    throw new Error("Browser signaling wait timeout is invalid.");
  }
  return timeoutMs;
}

function browserWaitSid(sid: unknown): string | undefined {
  if (sid === undefined) return undefined;
  if (typeof sid !== "string" || !BROWSER_WAIT_SESSION_ID.test(sid)) throw new Error("Browser signaling wait session id is invalid.");
  return sid;
}

function browserWaitAbortSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined) return undefined;
  if (!(signal instanceof AbortSignal)) throw new Error("Browser signaling wait abort signal is invalid.");
  return signal;
}

function wireSignals(signaling: BrowserSignaling, pc: RTCPeerConnection, sid: string, keys: SessionKeys, answerOffers: boolean): { dispose: () => void; failure: Promise<never> } {
  const queuedCandidates: Extract<SignalPayload, { kind: "candidate" }>[] = [];
  const replayGuard = new WebRtcSignalReplayGuard(answerOffers);
  let disposed = false;
  let failed = false;
  let failSignal!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    failSignal = reject;
  });
  failure.catch(() => {});
  const dispose = () => {
    disposed = true;
    queuedCandidates.length = 0;
    signaling.off("signal", onSignal);
    signaling.off("error", onError);
    signaling.off("close", onClose);
  };
  const fail = (error: Error) => {
    if (failed || disposed) return;
    failed = true;
    failSignal(error);
    safeBrowserSend(signaling, { type: "bye", sid, reason: "signal_error" });
    pc.close();
    dispose();
  };
  const onError = (message: BrowserSignalingEvent) => {
    if (!isServerMessage(message)) return;
    fail(message.type === "error" ? new BrowserSignalingError(message.code) : new Error("Signaling error"));
  };
  const onClose = () => {
    fail(new Error("Signaling socket closed."));
  };
  const onSignal = async (message: BrowserSignalingEvent) => {
    try {
      if (disposed) return;
      if (!isServerMessage(message)) return;
      if (message.type !== "signal" || message.sid !== sid) return;
      const peerRole = keys.role === "sender" ? "receiver" : "sender";
      if (!verifySignalAuthTag(keys.signalAuthKey, sid, peerRole, message.signal)) {
        throw new Error("Authenticated WebRTC signal check failed. Wrong code or signaling MITM.");
      }
      const signal = message.signal.kind === "candidate" ? copyCandidateSignal(message.signal) : message.signal;
      replayGuard.accept(signal);
      if (signal.kind === "candidate" && !pc.remoteDescription) {
        if (queuedCandidates.length >= MAX_QUEUED_ICE_CANDIDATES) throw new Error("Too many queued ICE candidates before SDP.");
        queuedCandidates.push(signal);
        return;
      }
      if (signal.kind === "candidate") {
        await pc.addIceCandidate(signal.candidate);
      } else {
        await pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp });
        if (disposed) return;
        if (signal.kind === "offer" && answerOffers) {
          const answer = await pc.createAnswer();
          if (disposed) return;
          await pc.setLocalDescription(answer);
          if (disposed) return;
          const answerSdp = requireSdp(pc.localDescription?.sdp ?? answer.sdp);
          safeBrowserSend(signaling, { type: "signal", sid, signal: { kind: "answer", sdp: answerSdp, auth: sdpAuthTag(keys.signalAuthKey, sid, keys.role, "answer", answerSdp) } });
        }
        while (!disposed && queuedCandidates.length > 0) {
          const candidate = queuedCandidates.shift()!;
          if (candidate.kind === "candidate") await pc.addIceCandidate(candidate.candidate);
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(safeErrorMessage(error)));
    }
  };
  if (signaling.isClosed()) {
    fail(new Error("Signaling socket closed."));
    return { dispose, failure };
  }
  signaling.on("signal", onSignal);
  signaling.on("error", onError);
  signaling.on("close", onClose);
  for (const message of signaling.drainSignalMessages()) {
    if (disposed) break;
    void onSignal(message);
  }
  return { dispose, failure };
}

function copyCandidateSignal(signal: Extract<SignalPayload, { kind: "candidate" }>): Extract<SignalPayload, { kind: "candidate" }> {
  const source = ownDataValue(signal, "candidate");
  const auth = ownDataValue(signal, "auth");
  if (!source || typeof source !== "object" || typeof auth !== "string") throw new Error("WebRTC candidate signal is invalid.");
  const candidateText = ownDataValue(source, "candidate");
  const sdpMid = ownDataValue(source, "sdpMid");
  const sdpMLineIndex = ownDataValue(source, "sdpMLineIndex");
  const usernameFragment = ownDataValue(source, "usernameFragment");
  const candidate: RTCIceCandidateInit = {};
  if (typeof candidateText === "string") candidate.candidate = candidateText;
  if (sdpMid !== undefined) candidate.sdpMid = sdpMid as string | null;
  if (sdpMLineIndex !== undefined) candidate.sdpMLineIndex = sdpMLineIndex as number | null;
  if (typeof usernameFragment === "string") candidate.usernameFragment = usernameFragment;
  return { kind: "candidate", candidate, auth };
}

function sendBrowserIceCandidate(signaling: BrowserSignaling, sid: string, signalAuthKey: Uint8Array, role: PakeRole, event: RTCPeerConnectionIceEvent): void {
  const localCandidate = localBrowserIceCandidateFromEvent(event);
  if (!localCandidate) return;
  const candidate = localBrowserIceCandidateInit(localCandidate);
  if (!candidate) return;
  safeBrowserSend(signaling, { type: "signal", sid, signal: { kind: "candidate", candidate, auth: signalAuthTag(signalAuthKey, sid, role, { kind: "candidate", candidate }) } });
}

function wireBrowserIceCandidates(signaling: BrowserSignaling, pc: RTCPeerConnection, sid: string, signalAuthKey: Uint8Array, role: PakeRole): () => void {
  const authKey = copySignalAuthKey(signalAuthKey);
  let disposed = false;
  const onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (disposed) return;
    try {
      sendBrowserIceCandidate(signaling, sid, authKey, role, event);
    } catch {
      dispose();
      safeBrowserSend(signaling, { type: "bye", sid, reason: "signal_error" });
      pc.close();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    authKey.fill(0);
    if (pc.onicecandidate === onIceCandidate) pc.onicecandidate = null;
  };
  pc.onicecandidate = onIceCandidate;
  return dispose;
}

function copySignalAuthKey(signalAuthKey: Uint8Array): Uint8Array {
  if (!(signalAuthKey instanceof Uint8Array) || Object.getPrototypeOf(signalAuthKey) !== Uint8Array.prototype || signalAuthKey.byteLength !== 32) {
    throw new Error("Signal auth key is invalid.");
  }
  const copy = new Uint8Array(signalAuthKey.byteLength);
  copy.set(signalAuthKey);
  return copy;
}

function localBrowserIceCandidateFromEvent(event: unknown): RTCIceCandidate | undefined {
  const candidate = typeof RTCPeerConnectionIceEvent !== "undefined" && event instanceof RTCPeerConnectionIceEvent ? event.candidate : ownDataValue(event, "candidate");
  return typeof RTCIceCandidate !== "undefined" && candidate instanceof RTCIceCandidate ? candidate : undefined;
}

function localBrowserIceCandidateInit(candidate: RTCIceCandidate): RTCIceCandidateInit | undefined {
  if (typeof RTCIceCandidate === "undefined" || !(candidate instanceof RTCIceCandidate)) return undefined;
  const toJSON = dataMethod(candidate, "toJSON");
  if (typeof toJSON !== "function") return undefined;
  return copyLocalIceCandidateInit(toJSON.call(candidate));
}

function copyLocalIceCandidateInit(source: unknown): RTCIceCandidateInit | undefined {
  if (!source || typeof source !== "object") return undefined;
  const candidateText = ownDataValue(source, "candidate");
  if (typeof candidateText !== "string" || candidateText.length === 0) return undefined;
  const sdpMid = ownDataValue(source, "sdpMid");
  const sdpMLineIndex = ownDataValue(source, "sdpMLineIndex");
  const usernameFragment = ownDataValue(source, "usernameFragment");
  const candidate: RTCIceCandidateInit = { candidate: candidateText };
  if (sdpMid === null || typeof sdpMid === "string") candidate.sdpMid = sdpMid;
  if (sdpMLineIndex === null || (typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 65535)) {
    candidate.sdpMLineIndex = sdpMLineIndex;
  }
  if (typeof usernameFragment === "string") candidate.usernameFragment = usernameFragment;
  if ((candidate.sdpMid === null || candidate.sdpMid === undefined) && (candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined)) return undefined;
  return candidate;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function dataMethod(value: object, key: string): unknown {
  let current: object | null = value;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

function waitIncomingChannels(pc: RTCPeerConnection): Promise<{ control: RTCDataChannel; bulk: RTCDataChannel }> {
  const channels = new Map<string, RTCDataChannel>();
  return new Promise((resolve, reject) => {
    let settled = false;
    const closeCollectedChannels = () => {
      for (const channel of channels.values()) {
        try {
          channel.close();
        } catch {
          // The channel may already be closed by WebRTC teardown.
        }
      }
      channels.clear();
    };
    const cleanup = () => {
      clearTimeout(timer);
      pc.ondatachannel = null;
      pc.removeEventListener("connectionstatechange", failOnTerminalConnectionState);
    };
    const succeed = (value: { control: RTCDataChannel; bulk: RTCDataChannel }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeCollectedChannels();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Timed out waiting for data channels.")), CONNECT_TIMEOUT_MS);
    const failOnTerminalConnectionState = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        fail(new Error(`WebRTC connection ${pc.connectionState}.`));
      }
    };
    pc.addEventListener("connectionstatechange", failOnTerminalConnectionState);
    pc.ondatachannel = (event) => {
      const channel = incomingBrowserDataChannel(event);
      if (!channel) {
        fail(new Error("Unexpected DataChannel parameters."));
        return;
      }
      const label = browserDataChannelLabel(channel);
      if (!isExpectedDataChannel(channel, label)) {
        closeBrowserDataChannel(channel);
        fail(new Error("Unexpected DataChannel parameters."));
        return;
      }
      if (channels.has(label)) {
        closeBrowserDataChannel(channel);
        fail(new Error(`Duplicate DataChannel ${label}.`));
        return;
      }
      channel.binaryType = "arraybuffer";
      channels.set(label, channel);
      const control = channels.get("control");
      const bulk = channels.get("bulk");
      if (control && bulk) {
        succeed({ control, bulk });
      }
    };
    failOnTerminalConnectionState();
  });
}

function incomingBrowserDataChannel(event: RTCDataChannelEvent): RTCDataChannel | undefined {
  const channel = typeof RTCDataChannelEvent !== "undefined" && event instanceof RTCDataChannelEvent ? event.channel : ownDataValue(event, "channel");
  return isSafeBrowserDataChannel(channel) ? channel : undefined;
}

function isSafeBrowserDataChannel(channel: unknown): channel is RTCDataChannel {
  return typeof RTCDataChannel !== "undefined" && channel instanceof RTCDataChannel;
}

function browserDataChannelLabel(channel: RTCDataChannel): string | undefined {
  if (!isSafeBrowserDataChannel(channel)) return undefined;
  const label = channel.label;
  return typeof label === "string" ? label : undefined;
}

function closeBrowserDataChannel(channel: RTCDataChannel): void {
  if (!isSafeBrowserDataChannel(channel)) return;
  channel.close();
}

function isExpectedDataChannel(channel: RTCDataChannel, label: string | undefined): label is "control" | "bulk" {
  return (label === "control" || label === "bulk") && channel.ordered && channel.maxPacketLifeTime === null && channel.maxRetransmits === null;
}

function waitOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  if (channel.readyState === "closing" || channel.readyState === "closed") return Promise.reject(new Error(`${channel.label} channel is ${channel.readyState}.`));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const failIfTerminal = () => {
      if (channel.readyState === "closing" || channel.readyState === "closed") fail(`${channel.label} channel is ${channel.readyState}.`);
    };
    const succeedIfOpen = () => {
      if (channel.readyState === "open") succeed();
    };
    const timer = setTimeout(() => fail(`${channel.label} channel did not open.`), CONNECT_TIMEOUT_MS);
    channel.onopen = succeed;
    channel.onclose = () => fail(`${channel.label} channel closed before opening.`);
    channel.onerror = () => fail(`${channel.label} channel failed`);
    failIfTerminal();
    succeedIfOpen();
  });
}

function waitPeerConnected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      pc.onconnectionstatechange = null;
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("WebRTC connection timed out."), CONNECT_TIMEOUT_MS);
    const handleConnectionState = () => {
      if (pc.connectionState === "connected") {
        succeed();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        fail(`WebRTC connection ${pc.connectionState}.`);
      }
    };
    pc.onconnectionstatechange = handleConnectionState;
    handleConnectionState();
  });
}

async function waitBackpressure(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "closing" || channel.readyState === "closed") return Promise.reject(new Error(`${channel.label} channel is ${channel.readyState}.`));
  if (channel.bufferedAmount <= DATA_CHANNEL_BUFFER_HIGH) return;
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let interval: ReturnType<typeof setInterval>;
    let timer: ReturnType<typeof setTimeout>;
    const previousLow = channel.onbufferedamountlow;
    const previousClose = channel.onclose;
    const previousError = channel.onerror;
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timer);
      channel.onbufferedamountlow = previousLow;
      channel.onclose = previousClose;
      channel.onerror = previousError;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const failIfTerminal = () => {
      if (channel.readyState === "closing" || channel.readyState === "closed") fail(`${channel.label} channel is ${channel.readyState}.`);
    };
    interval = setInterval(() => {
      if (channel.bufferedAmount <= DATA_CHANNEL_BUFFER_LOW) finish();
    }, 25);
    timer = setTimeout(() => fail(`DataChannel ${channel.label} backpressure did not drain.`), TRANSFER_CONTROL_TIMEOUT_MS);
    channel.onbufferedamountlow = finish;
    channel.onclose = (event) => {
      previousClose?.call(channel, event);
      fail(`DataChannel ${channel.label} closed while draining.`);
    };
    channel.onerror = (event) => {
      previousError?.call(channel, event);
      fail(`DataChannel ${channel.label} failed while draining.`);
    };
    failIfTerminal();
  });
}

async function sendControl(channel: RTCDataChannel, keys: SessionKeys, message: ControlMessage, throwIfStopped?: () => void | Promise<void>): Promise<void> {
  const sealed = await sealControl(keys, message);
  await throwIfStopped?.();
  channel.send(sealed);
}

function receiveQueueByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer && Object.getPrototypeOf(data) === ArrayBuffer.prototype) return data.byteLength;
  if (data instanceof Uint8Array && isCanonicalDataChannelBytes(data)) return TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(data) ?? RECEIVE_QUEUE_MAX_BYTES + 1;
  if (typeof Blob !== "undefined" && data instanceof Blob) return Number.isFinite(data.size) ? data.size : RECEIVE_QUEUE_MAX_BYTES + 1;
  return RECEIVE_QUEUE_MAX_BYTES + 1;
}

function safeBrowserSend(signaling: BrowserSignaling | undefined, message: Parameters<BrowserSignaling["send"]>[0]): void {
  try {
    signaling?.send(message);
  } catch {
    // Best-effort signaling; local cleanup paths handle closed sockets.
  }
}

type BrowserWritableReceiveFile = {
  name: string;
  partName: string;
  writable: FileSystemWritableFileStream;
  fileHandle: FileSystemFileHandle;
  directory: FileSystemDirectoryHandle;
  resumeKey?: string;
  hash?: Sha256;
  bytes?: number;
  expectedSeq?: number;
};

async function createBrowserReceiveFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  size: number,
  resumeKey: string | undefined,
  resume: boolean,
  opaqueOutputNames: boolean,
  resumeKeyPersistent = false
): Promise<BrowserWritableReceiveFile> {
  if (resume) {
    if (!resumeKey) throw new Error("Browser resume key is required.");
    if (!resumeKeyPersistent) throw new Error("Browser resume key store unavailable.");
    const resumed = await resumeBrowserPartialFile(directory, name, size, resumeKey, opaqueOutputNames);
    if (resumed) return resumed;
    const created = await createWritableFile(directory, name, opaqueOutputNames, resumeKey);
    rememberBrowserResumePartial(resumeKey, { partName: created.partName, updatedAt: Date.now() });
    return { ...created, resumeKey };
  }
  return createWritableFile(directory, name, opaqueOutputNames);
}

async function resumeBrowserPartialFile(directory: FileSystemDirectoryHandle, name: string, size: number, resumeKey: string, opaqueOutputNames: boolean): Promise<BrowserWritableReceiveFile | undefined> {
  const record = readBrowserResumePartial(resumeKey);
  if (!record) return undefined;
  assertBrowserOpaquePartFileName(record.partName);

  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(record.partName);
  } catch (error) {
    if (isNotFoundError(error)) {
      forgetBrowserResumePartial(resumeKey);
      return undefined;
    }
    throw error;
  }

  const file = await handle.getFile();
  const bytes = browserResumeOffset(file.size, size);
  const hash = await hashBrowserPartialPrefix(file, bytes, name);
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await writable.write({ type: "truncate", size: bytes });
    await writable.write({ type: "seek", position: bytes });
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return {
    name: browserFinalOutputName(name, opaqueOutputNames, resumeKey),
    partName: record.partName,
    writable,
    fileHandle: handle,
    directory,
    resumeKey,
    hash,
    bytes,
    expectedSeq: bytes === size ? Math.ceil(size / CHUNK_SIZE) : bytes / CHUNK_SIZE
  };
}

async function createWritableFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  opaqueOutputNames: boolean,
  stableOpaqueKey?: string
): Promise<{ name: string; partName: string; writable: FileSystemWritableFileStream; fileHandle: FileSystemFileHandle; directory: FileSystemDirectoryHandle }> {
  const finalName = browserFinalOutputName(name, opaqueOutputNames, stableOpaqueKey);
  const { name: partName, handle } = await createAvailableBrowserFile(directory, opaqueBrowserPartName(), browserPartCandidateName);
  try {
    return { name: finalName, partName, writable: await handle.createWritable({ keepExistingData: false }), fileHandle: handle, directory };
  } catch (error) {
    await directory.removeEntry(partName).catch(ignoreNotFoundError);
    throw error;
  }
}

function browserFinalOutputName(name: string, opaqueOutputNames: boolean, stableOpaqueKey?: string): string {
  if (!opaqueOutputNames) return randomizedBrowserOutputName(name);
  return opaqueBrowserOutputName(stableOpaqueKey === undefined ? undefined : browserOpaqueOutputToken(stableOpaqueKey));
}

function browserOpaqueOutputToken(stableOpaqueKey: string): string {
  if (!BROWSER_RESUME_STORAGE_ENTRY_KEY.test(stableOpaqueKey)) throw new Error("Browser opaque output key is invalid.");
  return stableOpaqueKey.slice(BROWSER_RESUME_KEY_PREFIX.length, BROWSER_RESUME_KEY_PREFIX.length + 32);
}

function browserResumeOffset(partialSize: number, expectedSize: number): number {
  if (!Number.isSafeInteger(partialSize) || partialSize < 0 || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_FILE_BYTES) {
    throw new Error("Browser resume partial size is invalid.");
  }
  if (partialSize >= expectedSize) return expectedSize;
  return Math.floor(partialSize / CHUNK_SIZE) * CHUNK_SIZE;
}

async function hashBrowserPartialPrefix(file: File, bytes: number, _label: string): Promise<Sha256> {
  const hash = createSha256();
  if (bytes === 0) return hash;
  const prefix = file.slice(0, bytes);
  if (prefix.size !== bytes) throw new Error("Could not read resumed browser partial.");
  const reader = prefix.stream().getReader();
  let readBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      try {
        readBytes += chunk.byteLength;
        if (readBytes > bytes) throw new Error("Could not read resumed browser partial.");
        hash.update(chunk);
      } finally {
        chunk.fill(0);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (readBytes !== bytes) throw new Error("Could not read resumed browser partial.");
  return hash;
}

async function browserResumeKey(manifest: FileManifest, file: TransferManifest["files"][number]): Promise<BrowserResumeKey> {
  const identity = browserResumeText.encode(canonicalBrowserResumeIdentity(manifest, file));
  const lookup = await browserResumeLookupKey();
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", lookup.key, identity));
  return { key: `${BROWSER_RESUME_KEY_PREFIX}${hexBytes(mac)}`, persistent: lookup.persistent };
}

async function browserResumeLookupKey(): Promise<BrowserResumeLookupKey> {
  browserResumeLookupKeyPromise ??= loadBrowserResumeLookupKey();
  return browserResumeLookupKeyPromise;
}

async function loadBrowserResumeLookupKey(): Promise<BrowserResumeLookupKey> {
  try {
    const db = await openBrowserResumeKeyDb();
    try {
      const stored = await readStoredBrowserResumeLookupKey(db);
      if (stored) return { key: stored, persistent: true };
      const created = await createBrowserResumeLookupKey();
      await storeBrowserResumeLookupKey(db, created);
      clearBrowserResumeRegistry();
      return { key: created, persistent: true };
    } finally {
      db.close();
    }
  } catch {
    clearBrowserResumeRegistry();
    return { key: await createBrowserResumeLookupKey(), persistent: false };
  }
}

function createBrowserResumeLookupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

function openBrowserResumeKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_RESUME_KEY_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BROWSER_RESUME_KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser resume key store failed."));
    request.onblocked = () => reject(new Error("Browser resume key store is blocked."));
  });
}

async function readStoredBrowserResumeLookupKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  const transaction = db.transaction(BROWSER_RESUME_KEY_STORE, "readonly");
  const value = await idbRequest<unknown>(transaction.objectStore(BROWSER_RESUME_KEY_STORE).get(BROWSER_RESUME_LOOKUP_KEY_ID));
  if (!isBrowserResumeLookupKey(value)) return undefined;
  return value;
}

async function storeBrowserResumeLookupKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  const transaction = db.transaction(BROWSER_RESUME_KEY_STORE, "readwrite");
  await idbRequest(transaction.objectStore(BROWSER_RESUME_KEY_STORE).put(key, BROWSER_RESUME_LOOKUP_KEY_ID));
  await idbTransactionDone(transaction);
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser resume key store failed."));
  });
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("Browser resume key store failed."));
    transaction.onabort = () => reject(new Error("Browser resume key store failed."));
  });
}

function isBrowserResumeLookupKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === "undefined" || !(value instanceof CryptoKey)) return false;
  const algorithm = value.algorithm;
  const hash = (algorithm as HmacKeyAlgorithm).hash;
  return (
    value.type === "secret" &&
    value.extractable === false &&
    algorithm.name === "HMAC" &&
    (algorithm as HmacKeyAlgorithm).length === 256 &&
    typeof hash === "object" &&
    hash !== null &&
    hash.name === "SHA-256" &&
    value.usages.length === 1 &&
    value.usages[0] === "sign"
  );
}

function hexBytes(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function canonicalBrowserResumeIdentity(manifest: FileManifest, file: TransferManifest["files"][number]): string {
  assertTransferManifestWithinLimits(manifest);
  const filesValue = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (!Array.isArray(filesValue) || typeof fileCount !== "number" || typeof totalBytes !== "number") {
    throw new Error("Browser resume manifest is invalid.");
  }
  const files = [];
  for (let index = 0; index < filesValue.length; index += 1) files.push(canonicalBrowserResumeFile(ownDataValue(filesValue, String(index))));
  return JSON.stringify({
    v: 1,
    t: "browser-resume",
    file: canonicalBrowserResumeFile(file),
    manifest: { fileCount, totalBytes, files }
  });
}

function canonicalBrowserResumeFile(value: unknown): { id: number; name: string; size: number; mime: string | null } {
  const id = ownDataValue(value, "id");
  const name = ownDataValue(value, "name");
  const size = ownDataValue(value, "size");
  const mime = ownDataValue(value, "mime");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id > 255 || typeof name !== "string" || typeof size !== "number") {
    throw new Error("Browser resume file identity is invalid.");
  }
  assertFileWithinLimits(name, size);
  if (mime !== undefined && typeof mime !== "string") throw new Error("Browser resume file identity is invalid.");
  return { id, name, size, mime: mime ?? null };
}

function readBrowserResumePartial(key: string): BrowserResumePartialRecord | undefined {
  const registry = readBrowserResumeRegistry();
  const value = ownDataValue(registry, key);
  return browserResumePartialRecordInput(value);
}

function rememberBrowserResumePartial(key: string, record: BrowserResumePartialRecord): void {
  const registry = readBrowserResumeRegistry();
  registry[key] = record;
  const now = Date.now();
  const entries = Object.entries(registry)
    .map(([entryKey, entryValue]) => [entryKey, browserResumePartialRecordInput(entryValue)] as const)
    .filter((entry): entry is readonly [string, BrowserResumePartialRecord] => {
      const record = entry[1];
      return record !== undefined && browserResumePartialRecordIsFresh(record, now);
    })
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_BROWSER_RESUME_RECORDS);
  writeBrowserResumeRegistry(Object.fromEntries(entries));
}

function forgetBrowserResumePartial(key: string): void {
  const registry = readBrowserResumeRegistry();
  delete registry[key];
  writeBrowserResumeRegistry(registry);
}

function readBrowserResumeRegistry(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(BROWSER_RESUME_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      clearBrowserResumeRegistry();
      return {};
    }
    return sanitizeBrowserResumeRegistry(parsed as Record<string, unknown>);
  } catch {
    clearBrowserResumeRegistry();
    return {};
  }
}

function writeBrowserResumeRegistry(registry: Record<string, unknown>): void {
  try {
    if (Object.keys(registry).length === 0) {
      window.localStorage.removeItem(BROWSER_RESUME_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(BROWSER_RESUME_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Resume records are opportunistic; transfer integrity does not depend on storage.
  }
}

function clearBrowserResumeRegistry(): void {
  try {
    window.localStorage.removeItem(BROWSER_RESUME_STORAGE_KEY);
  } catch {
    // Resume records are opportunistic; transfer integrity does not depend on storage.
  }
}

async function clearBrowserResumeState(): Promise<BrowserResumeClearResult> {
  const partNames = browserResumePartNames();
  let removed = 0;
  let folderSelected = false;
  let cleanupFailed = false;
  if (partNames.length > 0 && canPickBrowserDirectory()) {
    try {
      const directory = await window.showDirectoryPicker!();
      folderSelected = true;
      try {
        removed = await removeBrowserResumePartFiles(directory, partNames);
      } catch {
        cleanupFailed = true;
        // Folder cleanup is best-effort; origin state should still be cleared.
      }
    } catch {
      // Clearing origin state must still work if folder selection is cancelled.
    }
  }
  clearBrowserResumeRegistry();
  browserResumeLookupKeyPromise = undefined;
  await deleteBrowserResumeKeyDb();
  return { records: partNames.length, removed, folderSelected, cleanupFailed };
}

function browserResumePartNames(): string[] {
  const names = new Set<string>();
  for (const record of Object.values(readBrowserResumeRegistry())) {
    const parsed = browserResumePartialRecordInput(record);
    if (parsed) names.add(parsed.partName);
  }
  return [...names];
}

async function removeBrowserResumePartFiles(directory: FileSystemDirectoryHandle, partNames: readonly string[]): Promise<number> {
  let removed = 0;
  for (const partName of partNames) {
    try {
      assertBrowserOpaquePartFileName(partName);
      await directory.removeEntry(partName);
      removed += 1;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return removed;
}

function browserResumeClearMessage(result: BrowserResumeClearResult): string {
  if (result.records === 0) return "Cleared browser resume records.";
  if (result.folderSelected && result.cleanupFailed) return `Cleared browser resume records. Removed ${result.removed} saved partial file${result.removed === 1 ? "" : "s"} from the selected folder; some saved partial files could not be removed.`;
  if (result.folderSelected) return `Cleared browser resume records. Removed ${result.removed} saved partial file${result.removed === 1 ? "" : "s"} from the selected folder.`;
  if (canPickBrowserDirectory()) return "Cleared browser resume records. No folder was selected, so saved ff-*.part files may remain in previous receive folders.";
  return "Cleared browser resume records. Delete old ff-*.part files manually from receive folders you previously selected.";
}

function deleteBrowserResumeKeyDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BROWSER_RESUME_KEY_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Browser resume key store could not be cleared."));
    request.onblocked = () => reject(new Error("Browser resume key store is still open in another tab."));
  });
}

function pruneBrowserResumeRegistry(): void {
  readBrowserResumeRegistry();
}

function sanitizeBrowserResumeRegistry(registry: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, BrowserResumePartialRecord> = {};
  let changed = false;
  for (const [entryKey, entryValue] of Object.entries(registry)) {
    if (!BROWSER_RESUME_STORAGE_ENTRY_KEY.test(entryKey)) {
      changed = true;
      continue;
    }
    const record = browserResumePartialRecordInput(entryValue);
    if (!record) {
      changed = true;
      continue;
    }
    if (!browserResumePartialRecordIsFresh(record)) {
      changed = true;
      continue;
    }
    sanitized[entryKey] = record;
    if (!browserResumePartialRecordIsCanonical(entryValue, record)) changed = true;
  }
  if (changed) replaceBrowserResumeRegistry(sanitized);
  return sanitized;
}

function replaceBrowserResumeRegistry(registry: Record<string, unknown>): void {
  clearBrowserResumeRegistry();
  writeBrowserResumeRegistry(registry);
}

function browserResumePartialRecordIsCanonical(value: unknown, record: BrowserResumePartialRecord): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("partName") || !keys.includes("updatedAt")) return false;
  return ownDataValue(value, "partName") === record.partName && ownDataValue(value, "updatedAt") === record.updatedAt;
}

function browserResumePartialRecordIsFresh(record: BrowserResumePartialRecord, now = Date.now()): boolean {
  return record.updatedAt <= now && now - record.updatedAt <= BROWSER_RESUME_RECORD_TTL_MS;
}

function browserResumePartialRecordInput(value: unknown): BrowserResumePartialRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const partName = ownDataValue(value, "partName");
  const updatedAt = ownDataValue(value, "updatedAt");
  if (
    typeof partName !== "string" ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined;
  }
  try {
    assertBrowserOpaquePartFileName(partName);
  } catch {
    return undefined;
  }
  return { partName, updatedAt };
}

async function discardBrowserPartialFile(state: BrowserReceiveState): Promise<void> {
  try {
    await state.writable?.abort();
  } catch {
    // Closed streams cannot always be aborted after a verification failure.
  }
  if (!state.directory) return;
  if (state.publishedName) await state.directory.removeEntry(state.publishedName).catch(ignoreNotFoundError);
  if (state.partName) await state.directory.removeEntry(state.partName).catch(ignoreNotFoundError);
  if (!state.publishedName && !state.partName) await state.directory.removeEntry(state.name).catch(ignoreNotFoundError);
}

async function preserveBrowserPartialFile(state: BrowserReceiveState): Promise<void> {
  if (!state.writable) return;
  try {
    await state.writable.close();
  } catch (error) {
    try {
      await state.writable.abort();
    } catch {
      // Preserve the close error; abort is only best-effort cleanup.
    }
    throw error;
  }
}

async function publishBrowserPartFile(state: BrowserReceiveState, expectedSha256: string, throwIfReceiveStopped: () => void): Promise<string> {
  if (!state.directory || !state.fileHandle || !state.partName) throw new Error("Missing browser partial file handle.");
  throwIfReceiveStopped();
  const created = await createAvailableBrowserFile(state.directory, state.name, browserFinalCandidateName);
  const finalName = created.name;
  let finalCreated = false;
  try {
    finalCreated = true;
    throwIfReceiveStopped();
    await copyWritableFile(state.fileHandle, created.handle, state.size);
    throwIfReceiveStopped();
    await verifyWritableFile(created.handle, finalName, state.size, expectedSha256);
    throwIfReceiveStopped();
    await state.directory.removeEntry(state.partName);
    throwIfReceiveStopped();
    return finalName;
  } catch (error) {
    if (finalCreated) await state.directory.removeEntry(finalName).catch(ignoreNotFoundError);
    throw error;
  }
}

async function copyWritableFile(sourceHandle: FileSystemFileHandle, targetHandle: FileSystemFileHandle, expectedSize: number): Promise<void> {
  const source = await sourceHandle.getFile();
  if (source.size !== expectedSize) throw new Error("Browser partial file size changed before publish.");
  const reader = source.stream().getReader();
  let writable: FileSystemWritableFileStream | undefined;
  let closed = false;
  let copiedBytes = 0;
  try {
    writable = await targetHandle.createWritable({ keepExistingData: false });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      copiedBytes += chunk.byteLength;
      if (copiedBytes > expectedSize) throw new Error("Browser partial file size changed during publish.");
      const copy = new Uint8Array(chunk.byteLength) as Uint8Array<ArrayBuffer>;
      copy.set(chunk);
      try {
        await writable.write(copy);
      } finally {
        copy.fill(0);
        chunk.fill(0);
      }
    }
    if (copiedBytes !== expectedSize) throw new Error("Browser partial file size changed during publish.");
    await writable.close();
    closed = true;
  } catch (error) {
    if (writable && !closed) {
      try {
        await writable.abort();
      } catch {
        // The writable stream may already be closed by the browser.
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function verifyWritableFile(handle: FileSystemFileHandle, _name: string, expectedSize: number, expectedSha256: string): Promise<void> {
  const file = await handle.getFile();
  if (file.size !== expectedSize) throw new Error("Written file size mismatch.");
  const hash = createSha256();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      try {
        hash.update(chunk);
      } finally {
        chunk.fill(0);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (digestHex(hash) !== expectedSha256) throw new Error("Written file hash mismatch.");
}

function updateProgress(target: HTMLElement, label: string, bytes: number, totalBytes: number, startedAt: number): void {
  const rate = bytes / Math.max((Date.now() - startedAt) / 1000, 0.1);
  target.textContent = `${label} ${formatBytes(bytes)} / ${formatBytes(totalBytes)} (${formatRate(rate)})`;
}

const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer && Object.getPrototypeOf(data) === ArrayBuffer.prototype) return new Uint8Array(data);
  if (data instanceof Blob) throw new Error("Unexpected Blob chunk");
  if (data instanceof Uint8Array && isCanonicalDataChannelBytes(data)) return data;
  throw new Error("Unsupported chunk data");
}

function isCanonicalDataChannelBytes(data: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Uint8Array.prototype) return false;
  const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(data);
  return Number.isSafeInteger(byteLength) && byteLength >= 0;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function requireElement<T extends HTMLElement>(element: T | null, label: string): T {
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}

function setStatus(element: HTMLElement, status: string): void {
  element.textContent = status;
}

function setLog(element: HTMLElement, message: string): void {
  element.textContent = sanitizeDisplayText(message);
}

function updateOperationControls(): void {
  const busy = operationBusy();
  serverUrl.disabled = busy;
  serverIce.disabled = busy;
  relayOnly.disabled = busy;
  folderOnly.disabled = busy;
  opaqueNames.disabled = busy;
  sendCode.disabled = busy;
  fileInput.disabled = busy;
  sendButton.disabled = busy;
  receiveButton.disabled = busy;
  clearResumeButton.disabled = busy;
}

function operationBusy(): boolean {
  return sendBusy || receiveBusy;
}

function staticTrustedHtml(strings: TemplateStringsArray, ...values: never[]): string {
  if (values.length !== 0) throw new Error("Static HTML must not contain interpolated values.");
  const html = strings.join("");
  const trustedTypes = (window as unknown as {
    trustedTypes?: {
      createPolicy(name: string, rules: { createHTML(value: string): string }): { createHTML(value: string): unknown };
    };
  }).trustedTypes;
  const policy = trustedTypes?.createPolicy(STATIC_HTML_POLICY_NAME, {
    createHTML(value) {
      return value;
    }
  });
  return (policy?.createHTML(html) ?? html) as string;
}

function errorMessage(error: unknown): string {
  return sanitizeDisplayText(safeErrorMessage(error));
}

function topLevelBrowserErrorMessage(error: unknown, operation: "send" | "receive"): string {
  const message = safeErrorMessage(error);
  if (isBrowserNativeError(error) || containsPathLikeText(message)) {
    return operation === "send" ? "Browser send failed." : "Browser receive failed.";
  }
  return sanitizeDisplayText(message);
}

function isBrowserNativeError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException;
}

function containsPathLikeText(value: string): boolean {
  return /(^|[\s("'=])(?:\/|[A-Za-z]:[\\/])/.test(value);
}

function safeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const message = ownStringDataProperty(error, "message");
  return message && message.length > 0 ? message : "Unexpected error.";
}

function ownStringDataProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  let current: object | null = value;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}

function requireSdp(sdp: string | undefined): string {
  if (!sdp) throw new Error("WebRTC did not produce an SDP payload.");
  return sdp;
}

function pairRejectMessage(_reason: string | undefined): string {
  return "Transfer rejected.";
}

function defaultBrowserServerUrl(): string {
  const { protocol, hostname, host } = window.location;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  const localDev = loopback && window.location.port !== "8787";
  if (localDev) return DEFAULT_SERVER_URL;
  return `${protocol === "https:" || !loopback ? "wss" : "ws"}://${host}/v1/ws`;
}
