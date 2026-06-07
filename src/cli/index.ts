#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { Command } from "commander";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  DEFAULT_SERVER_URL,
  MAX_FILE_BYTES,
  MAX_QUEUED_ICE_CANDIDATES,
  PAIR_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECEIVER_MAX_PREPAIR_ATTEMPTS
} from "../shared/constants.js";
import { formatBytes } from "../shared/format.js";
import { assertTransferManifestWithinLimits, safeFileName } from "../shared/limits.js";
import { isServerMessage, type FileManifest, type ServerMessage, type SignalPayload } from "../shared/messages.js";
import { sanitizeDisplayText, sanitizeStructuredOutput } from "../shared/output-safety.js";
import { PACKAGE_VERSION } from "../shared/package-info.js";
import { WebRtcSignalReplayGuard } from "../shared/signal-replay.js";
import { codeInputUtf8ByteLengthExceeds, generateCode, normalizeCode, parseCode } from "../shared/wordlist.js";
import type { SessionKeys } from "../shared/security.js";
import { cloneIceServers } from "../shared/ice.js";
import { assertReviewedCryptoDependencies } from "./crypto-dependencies.js";
import { buildManifest, closeSendFiles, ensureOutputDir } from "./files.js";
import { redactLocalPathEvidence } from "./error-redaction.js";
import { classifyExitCode, safeErrorMessage } from "./exit-codes.js";
import { onInterrupt, withInterrupt } from "./interrupt.js";
import { SignalingClient, SignalingError, SignalingWaitTimeoutError, waitForMessage } from "./signaling.js";
import { unrefTimer } from "./timers.js";

type CommonOptions = {
  server: string;
  json?: boolean;
  verbose?: boolean;
  relay?: boolean;
  serverIce?: boolean;
  quiet?: boolean;
  redactOutput?: boolean;
  requirePrivateInput?: boolean;
  localPrivateMode?: boolean;
  noColor?: boolean;
};

type RecvOptions = CommonOptions & {
  out: string;
  yes?: boolean;
  code?: string;
  codeStdin?: boolean;
  codeEnv?: string;
  resume?: boolean;
  opaqueOutputNames?: boolean;
};

type SendOptions = CommonOptions & {
  codeStdin?: boolean;
  codeEnv?: string;
  filesStdin?: boolean;
};

type RecvCommandOptions = Omit<RecvOptions, "out"> & {
  out?: string;
};

type ResolvedRecvCode = {
  parsedCode: ReturnType<typeof parseRequiredCode>;
  supplied: boolean;
};

const RECEIVE_CODE_GENERATION_ATTEMPTS = 10;
const ICE_CONFIG_GRACE_MS = 1_000;
const CLI_STDIN_MAX_BYTES = 512 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEND_ARGV_TELEMETRY_WARNING = "Warning: receiver codes or local file paths passed as arguments can be captured by shell history, process lists, or endpoint telemetry. Use --code-stdin/--code-env and --files-stdin for private input.";
const RECV_ARGV_TELEMETRY_WARNING = "Warning: receive codes passed as arguments can be captured by shell history, process lists, or endpoint telemetry. Use --code-stdin/--code-env for private input.";

type SecurityModule = typeof import("../shared/security.js");
type RtcModule = typeof import("./rtc.js");
type SecureModule = typeof import("./secure.js");
type TransferModule = typeof import("./transfer.js");
type ReviewedCliRuntime = {
  security: SecurityModule;
  rtc: RtcModule;
  secure: SecureModule;
  transfer: TransferModule;
};
type CliPeer = ReturnType<RtcModule["createPeer"]>;

let reviewedCliRuntimePromise: Promise<ReviewedCliRuntime> | undefined;

process.title = "ff";

const program = new Command();

program
  .name("ff")
  .description("Peer-to-peer file transfer over WebRTC.")
  .version(`${PACKAGE_VERSION} protocol ${PROTOCOL_VERSION}`)
  .option("--server <url>", "signaling server WebSocket URL", DEFAULT_SERVER_URL)
  .option("--relay", "force TURN relay candidates when TURN is configured")
  .option("--no-server-ice", "ignore signaling-provided ICE servers and use built-in public STUN only")
  .option("--json", "emit machine-readable events")
  .option("--quiet", "suppress human-readable progress output")
  .option("--redact-output", "redact transfer codes, SAS, file metadata, and byte counts from CLI output, JSON events, and error text")
  .option("--require-private-input", "reject receive codes and send code/file paths supplied through argv")
  .option("--local-private-mode", "enable local CLI privacy guardrails: private input, redacted output, and opaque receive names")
  .option("--no-color", "disable color output")
  .option("--verbose", "show debug details");

program
  .command("recv")
  .description("receive files")
  .option("--out <dir>", "output directory")
  .option("-y, --yes", "auto-accept incoming transfers")
  .option("--resume", "resume from chunk-aligned CLI partial files left in the output directory")
  .option("--opaque-output-names", "write received files to opaque ff-<token> names instead of peer-supplied basenames")
  .option("--code <code>", "use a supplied code like 12345678-two-words")
  .option("--code-stdin", "read a supplied receive code from piped stdin")
  .option("--code-env <name>", "read a supplied receive code from an environment variable")
  .action(async (options: RecvCommandOptions) => {
    const merged: RecvOptions = { ...program.opts<CommonOptions>(), ...options, out: options.out ?? process.cwd() };
    applyLocalPrivateMode(merged);
    return runWithExit(() => recv(merged), merged);
  });

program
  .command("send")
  .description("send files")
  .argument("[code]", "receiver code")
  .argument("[files...]", "files to send")
  .option("--code-stdin", "read the receiver code from piped stdin instead of argv")
  .option("--code-env <name>", "read the receiver code from an environment variable instead of argv")
  .option("--files-stdin", "read newline-delimited file paths from stdin instead of argv")
  .action(async (code: string | undefined, files: string[], options: SendOptions) => {
    const merged = { ...program.opts<CommonOptions>(), ...options };
    applyLocalPrivateMode(merged);
    return runWithExit(async () => {
      const inputs = await resolveSendInputs(code, files, merged);
      return send(normalizeCode(inputs.code), inputs.files, merged);
    }, merged);
  });

program.parse();

function applyLocalPrivateMode<T extends CommonOptions>(options: T): T {
  if (!options.localPrivateMode) return options;
  options.redactOutput = true;
  options.requirePrivateInput = true;
  (options as T & { opaqueOutputNames?: boolean }).opaqueOutputNames = true;
  return options;
}

async function reviewedCliRuntime(): Promise<ReviewedCliRuntime> {
  if (!reviewedCliRuntimePromise) {
    assertReviewedCryptoDependencies();
    reviewedCliRuntimePromise = Promise.all([import("../shared/security.js"), import("./rtc.js"), import("./secure.js"), import("./transfer.js")]).then(([security, rtc, secure, transfer]) => ({
      security,
      rtc,
      secure,
      transfer
    }));
  }
  return reviewedCliRuntimePromise;
}

async function recv(options: RecvOptions): Promise<void> {
  const suppliedCode = await resolveRecvCode(options);
  const runtime = await reviewedCliRuntime();
  const outDir = await ensureOutputDir(options.out);

  const signaling = await openSignaling(options.server);
  let peer: CliPeer | undefined;
  let keys: SessionKeys | undefined;
  let sid: string | undefined;
  let parsedCode: ReturnType<typeof parseRequiredCode> | undefined;
  let completed = false;
  let iceServers = cloneIceServers(DEFAULT_ICE_SERVERS);
  let unwireSignals: (() => void) | undefined;
  const useServerIce = shouldUseServerIce(options);
  if (useServerIce) {
    signaling.on("ice-config", (message: unknown) => {
      if (!isServerMessage(message)) return;
      if (message.type === "ice-config") iceServers = cloneIceServers(message.iceServers);
    });
    iceServers = signaling.currentIceServers() ?? iceServers;
  }

  const interrupt = onInterrupt(() => {
    safeBye(signaling, sid, "cancelled");
    peer?.close();
    signaling.close();
  });

  try {
    await withInterrupt(
      (async () => {
        const registeredCode = await registerReceiver(signaling, suppliedCode);
        parsedCode = registeredCode.parsedCode;
        const registered = registeredCode.registered;
        printRegisteredReceiver(options, parsedCode.handle, registered, registeredCode.supplied);

        for (let pairRequestRetry = 0; ; pairRequestRetry += 1) {
          const joined = await waitForConfirmedReceiverSession(runtime, signaling, parsedCode.handle, options);
          sid = joined.sid;
          keys = joined.keys;
          printSecureSession(options, keys.sas);
          let manifest: FileManifest;
          let sealedManifest: string;
          try {
            const request = await waitForMessage(signaling, "pair-request", PAIR_TIMEOUT_MS, joined.sid);
            sealedManifest = request.sealedManifest;
            manifest = await runtime.security.openManifest<FileManifest>(keys, request.sealedManifest);
            assertTransferManifestWithinLimits(manifest);
          } catch (error) {
            if (pairRequestRetry >= RECEIVER_MAX_PREPAIR_ATTEMPTS - 1) throw error;
            safeSend(signaling, { type: "bye", sid: joined.sid, reason: "prepair_retry" });
            runtime.security.wipeSessionKeys(keys);
            keys = undefined;
            sid = undefined;
            const restored = await waitForMessage(signaling, "registered", CONNECT_TIMEOUT_MS);
            assertRegisteredRendezvous(restored, parsedCode.rendezvous);
            printPrepairRetry(options, pairRequestRetry + 1, restored.code);
            human(options, "Ignored an invalid transfer request. Still waiting...");
            continue;
          }
          const accepted = await showManifestAndMaybeAccept(manifest, options, keys.sas);
          if (!accepted) {
            safeSend(signaling, { type: "pair-reject", sid: joined.sid, reason: "user_declined", auth: runtime.security.pairDecisionAuthTag(keys.signalAuthKey, joined.sid, "receiver", "reject", sealedManifest, "user_declined") });
            throw new Error("Transfer declined.");
          }

          signaling.send({ type: "pair-accept", sid: joined.sid, auth: runtime.security.pairDecisionAuthTag(keys.signalAuthKey, joined.sid, "receiver", "accept", sealedManifest) });
          iceServers = await getIceServersAfterAccept(signaling, iceServers, useServerIce);

          peer = runtime.rtc.createPeer(joined.sid, iceServers, signaling, keys.signalAuthKey, "receiver", options.relay);
          const channels = waitForIncomingChannels(runtime, peer.pc);
          const signalWire = wireSignals(runtime, signaling, peer.pc, joined.sid, keys, true);
          unwireSignals = signalWire.dispose;

          const { control, bulk } = await Promise.race([channels, signalWire.failure]);
          await Promise.race([Promise.all([runtime.rtc.waitForDataChannelOpen(control), runtime.rtc.waitForDataChannelOpen(bulk), peer.waitConnected()]), signalWire.failure]);
          signalWire.dispose();
          unwireSignals = undefined;
          human(options, "Connected. Receiving files...");
          await runtime.transfer.receiveFiles(
            control,
            bulk,
            keys,
            outDir,
            options.json,
            options.quiet,
            undefined,
            manifest,
            Boolean(options.resume),
            Boolean(options.redactOutput),
            Boolean(options.opaqueOutputNames)
          );
          safeSend(signaling, { type: "bye", sid: joined.sid, reason: "complete" });
          completed = true;
          break;
        }
      })(),
      interrupt
    );
  } finally {
    interrupt.dispose();
    if (!completed) safeBye(signaling, sid, interrupt.interrupted ? "cancelled" : "error");
    unwireSignals?.();
    runtime.security.wipeSessionKeys(keys);
    peer?.close();
    signaling.close();
  }
}

async function registerReceiver(
  signaling: SignalingClient,
  suppliedCode?: ResolvedRecvCode
): Promise<{ parsedCode: ReturnType<typeof parseRequiredCode>; registered: Extract<ServerMessage, { type: "registered" }>; supplied: boolean }> {
  const attempts = suppliedCode ? 1 : RECEIVE_CODE_GENERATION_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const parsedCode = suppliedCode?.parsedCode ?? parseRequiredCode(normalizeCode(generateCode()));
    signaling.send({ type: "register", role: "receiver", code: parsedCode.rendezvous, protocolVersion: PROTOCOL_VERSION });
    try {
      const registered = await waitForMessage(signaling, "registered", CONNECT_TIMEOUT_MS);
      assertRegisteredRendezvous(registered, parsedCode.rendezvous);
      return { parsedCode, registered, supplied: suppliedCode?.supplied ?? false };
    } catch (error) {
      if (!suppliedCode && error instanceof SignalingError && error.code === "code_taken") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a receive code after repeated collisions.");
}

function printRegisteredReceiver(options: RecvOptions, handle: string, registered: Extract<ServerMessage, { type: "registered" }>, supplied: boolean): void {
  if (options.redactOutput) {
    print(options, supplied ? { event: "registered", codeSupplied: true, codeRedacted: true, expiresInSec: registered.expiresInSec } : { event: "registered", codeRedacted: true, expiresInSec: registered.expiresInSec });
    human(options, supplied ? "Ready to receive with the supplied code. Code redacted." : "Ready to receive. Code redacted.");
    return;
  }
  if (supplied) {
    print(options, { event: "registered", codeSupplied: true, rendezvous: registered.code, expiresInSec: registered.expiresInSec });
    human(options, "Ready to receive with the supplied code.");
    return;
  }
  print(options, { event: "registered", code: handle, rendezvous: registered.code, expiresInSec: registered.expiresInSec });
  human(options, `Ready to receive. Share this code: ${handle}`);
}

async function waitForConfirmedReceiverSession(
  runtime: ReviewedCliRuntime,
  signaling: SignalingClient,
  code: string,
  options: RecvOptions
): Promise<{ sid: string; keys: SessionKeys }> {
  const expectedRendezvous = parseRequiredCode(code).rendezvous;
  for (let attempt = 1; attempt <= RECEIVER_MAX_PREPAIR_ATTEMPTS; attempt += 1) {
    const joined = await waitForMessage(signaling, "peer-joined", PAIR_TIMEOUT_MS);
    try {
      return { sid: joined.sid, keys: await runtime.secure.establishKeys(signaling, joined.sid, "receiver", code) };
    } catch (error) {
      if (!isPrePairRetryable(error) || attempt >= RECEIVER_MAX_PREPAIR_ATTEMPTS) throw error;
      safeSend(signaling, { type: "bye", sid: joined.sid, reason: "prepair_retry" });
      const registered = await waitForMessage(signaling, "registered", CONNECT_TIMEOUT_MS);
      assertRegisteredRendezvous(registered, expectedRendezvous);
      printPrepairRetry(options, attempt, registered.code);
      human(options, "Ignored an invalid pairing attempt. Still waiting...");
    }
  }
  throw new Error("Too many invalid pairing attempts.");
}

function printPrepairRetry(options: CommonOptions, attempt: number, rendezvous: string): void {
  print(options, options.redactOutput ? { event: "prepair_retry", attempt, rendezvousRedacted: true } : { event: "prepair_retry", attempt, rendezvous });
}

function printSecureSession(options: CommonOptions, sas: string): void {
  print(options, options.redactOutput ? { event: "secure_session", sasRedacted: true } : { event: "secure_session", sas });
}

function isPrePairRetryable(error: unknown): boolean {
  const message = safeErrorMessage(error);
  return /PAKE confirmation failed|invalid PAKE|Peer disconnected|Timed out waiting for (?:pake|confirm)/i.test(message);
}

function shouldUseServerIce(options: CommonOptions): boolean {
  return options.serverIce !== false;
}

async function getIceServersAfterAccept(signaling: SignalingClient, fallback: RTCIceServer[], useServerIce: boolean): Promise<RTCIceServer[]> {
  if (!useServerIce) return cloneIceServers(fallback);
  const cached = signaling.currentIceServers();
  if (cached) return cached;
  try {
    return cloneIceServers((await waitForMessage(signaling, "ice-config", ICE_CONFIG_GRACE_MS)).iceServers);
  } catch (error) {
    if (error instanceof SignalingWaitTimeoutError && error.type === "ice-config") return cloneIceServers(fallback);
    throw error;
  }
}

async function send(code: string, paths: string[], options: CommonOptions): Promise<void> {
  const parsedCode = parseRequiredCode(code);
  const runtime = await reviewedCliRuntime();
  const { files, manifest } = await buildManifest(paths);
  let signaling: SignalingClient | undefined;
  let peer: CliPeer | undefined;
  let keys: SessionKeys | undefined;
  let sid: string | undefined;
  let completed = false;
  let interrupted = false;
  let iceServers = cloneIceServers(DEFAULT_ICE_SERVERS);
  let unwireSignals: (() => void) | undefined;
  const useServerIce = shouldUseServerIce(options);

  try {
    signaling = await openSignaling(options.server);
    if (useServerIce) {
      signaling.on("ice-config", (message: unknown) => {
        if (!isServerMessage(message)) return;
        if (message.type === "ice-config") iceServers = cloneIceServers(message.iceServers);
      });
      iceServers = signaling.currentIceServers() ?? iceServers;
    }

    const interrupt = onInterrupt(() => {
      interrupted = true;
      if (signaling) safeBye(signaling, sid, "cancelled");
      peer?.close();
      signaling?.close();
    });

    try {
      await withInterrupt(
        (async () => {
          signaling.send({ type: "connect", role: "sender", code: parsedCode.rendezvous, protocolVersion: PROTOCOL_VERSION });
          const joined = await waitForMessage(signaling, "peer-joined", CONNECT_TIMEOUT_MS);
          sid = joined.sid;
          keys = await runtime.secure.establishKeys(signaling, joined.sid, "sender", parsedCode.handle);
          const publicManifest = redactManifest(manifest);
          const sealedManifest = await runtime.security.sealManifest(keys, manifest);
          signaling.send({ type: "pair-request", sid: joined.sid, manifest: publicManifest, sealedManifest });
          print(options, options.redactOutput ? { event: "pair_requested", manifestRedacted: true } : { event: "pair_requested", sid: joined.sid, files: manifest.fileCount, totalBytes: manifest.totalBytes });
          printSecureSession(options, keys.sas);
          human(options, options.redactOutput ? "Waiting for receiver to accept transfer. SAS [redacted]" : `Waiting for receiver to accept ${manifest.fileCount} file(s), ${formatBytes(manifest.totalBytes)}. SAS ${keys.sas}`);
          await waitForPairAccept(runtime, signaling, joined.sid, keys, sealedManifest);
          iceServers = await getIceServersAfterAccept(signaling, iceServers, useServerIce);

          peer = runtime.rtc.createPeer(joined.sid, iceServers, signaling, keys.signalAuthKey, "sender", options.relay);
          const signalWire = wireSignals(runtime, signaling, peer.pc, joined.sid, keys, false);
          unwireSignals = signalWire.dispose;
          const control = peer.pc.createDataChannel("control", { ordered: true });
          const bulk = peer.pc.createDataChannel("bulk", { ordered: true });
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          const offerSdp = requireSdp(peer.pc.localDescription?.sdp ?? offer.sdp);
          signaling.send({ type: "signal", sid: joined.sid, signal: { kind: "offer", sdp: offerSdp, auth: runtime.security.sdpAuthTag(keys.signalAuthKey, joined.sid, "sender", "offer", offerSdp) } });

          await Promise.race([Promise.all([runtime.rtc.waitForDataChannelOpen(control), runtime.rtc.waitForDataChannelOpen(bulk), peer.waitConnected()]), signalWire.failure]);
          signalWire.dispose();
          unwireSignals = undefined;
          human(options, "Connected. Sending files...");
          await runtime.transfer.sendFiles(control, bulk, keys, files, options.json, options.quiet, Boolean(options.redactOutput));
          safeSend(signaling, { type: "bye", sid: joined.sid, reason: "complete" });
          completed = true;
        })(),
        interrupt
      );
    } finally {
      interrupt.dispose();
    }
  } finally {
    if (!completed && signaling) safeBye(signaling, sid, interrupted ? "cancelled" : "error");
    unwireSignals?.();
    await closeSendFiles(files);
    runtime.security.wipeSessionKeys(keys);
    peer?.close();
    signaling?.close();
  }
}

async function resolveRecvCode(options: RecvOptions): Promise<ResolvedRecvCode | undefined> {
  const sourceCount = Number(options.code !== undefined) + Number(Boolean(options.codeStdin)) + Number(options.codeEnv !== undefined);
  if (sourceCount === 0 && options.localPrivateMode) throw new Error("Receive code stdin or environment input is required by --local-private-mode.");
  if (sourceCount === 0) return undefined;
  if (sourceCount > 1) throw new Error("Use only one receive code input source.");
  if (options.code !== undefined) {
    rejectSensitiveRecvArgv(options);
    warnSensitiveRecvArgv(options);
  }
  const code = options.codeStdin ? await readCodeFromStdin("Receive code") : options.codeEnv !== undefined ? readCodeEnv(options.codeEnv) : options.code;
  return { parsedCode: parseRequiredCode(normalizeCode(code)), supplied: true };
}

async function resolveSendInputs(code: string | undefined, files: string[], options: SendOptions): Promise<{ code: string; files: string[] }> {
  if (options.codeStdin && options.codeEnv !== undefined) throw new Error("Use only one receiver code input source.");

  if (!options.codeStdin && options.codeEnv === undefined && !options.filesStdin) {
    if (!code) throw new Error("Receiver code is required.");
    if (files.length === 0) throw new Error("Choose at least one file.");
    rejectSensitiveSendArgv(options, true, true);
    warnSensitiveSendArgv(options);
    return { code, files };
  }

  if (options.codeStdin && options.filesStdin) {
    if (code !== undefined && code !== "-") throw new Error("Do not pass a receiver code in argv when using --code-stdin.");
    if (files.length > 0) throw new Error("Do not pass file paths in argv when using --files-stdin.");
    const stdinLines = splitStdinLines(await readBoundedStdin("Receiver code and file list"));
    const resolvedCode = stdinLines.shift();
    if (!resolvedCode) throw new Error("Receiver code is required.");
    if (stdinLines.length === 0) throw new Error("Choose at least one file.");
    return { code: resolvedCode, files: stdinLines };
  }

  let resolvedCode: string | undefined;
  if (options.codeStdin) {
    resolvedCode = await readCodeFromStdin("Receiver code");
  } else if (options.codeEnv !== undefined) {
    resolvedCode = readCodeEnv(options.codeEnv);
  } else {
    resolvedCode = code;
  }

  let resolvedFiles: string[];
  if (options.filesStdin) {
    if (files.length > 0 || (options.codeEnv !== undefined && code !== undefined && code !== "-")) throw new Error("Do not pass file paths in argv when using --files-stdin.");
    resolvedFiles = splitStdinLines(await readBoundedStdin("File list"));
  } else if (options.codeStdin || options.codeEnv !== undefined) {
    resolvedFiles = code !== undefined && code !== "-" ? [code, ...files] : files;
  } else {
    resolvedFiles = files;
  }

  if (!resolvedCode) throw new Error("Receiver code is required.");
  if (resolvedFiles.length === 0) throw new Error("Choose at least one file.");
  const codeFromArgv = !options.codeStdin && options.codeEnv === undefined && code !== undefined && code !== "-";
  const filesFromArgv = !options.filesStdin && resolvedFiles.length > 0;
  if (codeFromArgv || filesFromArgv) {
    rejectSensitiveSendArgv(options, codeFromArgv, filesFromArgv);
    warnSensitiveSendArgv(options);
  }
  return { code: resolvedCode, files: resolvedFiles };
}

async function readCodeFromStdin(label: string): Promise<string> {
  return readBoundedStdin(label);
}

function readCodeEnv(name: string): string {
  if (name.length > 128 || !ENV_NAME_PATTERN.test(name)) throw new Error("Environment variable name is invalid.");
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  const value = descriptor.value;
  delete process.env[name];
  if (typeof value !== "string" || value.length === 0 || codeInputUtf8ByteLengthExceeds(value)) {
    throw new Error(`Environment variable ${name} is invalid.`);
  }
  return value;
}

async function readBoundedStdin(label: string): Promise<string> {
  if (input.isTTY) throw new Error(`${label} requires piped stdin.`);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk)) throw new Error(`${label} input is invalid.`);
      total += chunk.byteLength;
      if (total > CLI_STDIN_MAX_BYTES) {
        chunk.fill(0);
        throw new Error(`${label} input exceeds ${CLI_STDIN_MAX_BYTES} bytes.`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, total);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`${label} input is not valid UTF-8.`);
    } finally {
      buffer.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function splitStdinLines(value: string): string[] {
  const lines = value.split(/\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function openSignaling(url: string): Promise<SignalingClient> {
  const client = new SignalingClient(url);
  await client.connect();
  return client;
}

async function showManifestAndMaybeAccept(manifest: FileManifest, options: RecvOptions, sas: string): Promise<boolean> {
  print(options, options.redactOutput ? { event: "pair_request", manifestRedacted: true, sasRedacted: true } : { event: "pair_request", files: manifest.files, totalBytes: manifest.totalBytes });
  if (!options.json && !options.quiet) {
    console.log(options.redactOutput ? "Incoming transfer. SAS [redacted]" : `Incoming transfer: ${manifest.fileCount} file(s), ${formatBytes(manifest.totalBytes)}. SAS ${sas}`);
    if (options.redactOutput) console.log("  - [redacted file list]");
    else for (const file of manifest.files) console.log(`  - ${safeFileName(file.name)} (${formatBytes(file.size)})`);
  }
  if (options.yes) return true;
  if (!input.isTTY) {
    human(options, "No TTY available; declining transfer. Re-run recv with --yes for headless mode.");
    return false;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Accept? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function waitForIncomingChannels(runtime: ReviewedCliRuntime, pc: RTCPeerConnection): Promise<{ control: RTCDataChannel; bulk: RTCDataChannel }> {
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
    unrefTimer(timer);
    const failOnTerminalConnectionState = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        fail(new Error(`WebRTC connection ${pc.connectionState}.`));
      }
    };
    pc.addEventListener("connectionstatechange", failOnTerminalConnectionState);
    pc.ondatachannel = (event) => {
      const channel = incomingDataChannel(runtime, event);
      if (!channel) {
        fail(new Error("Unexpected DataChannel parameters."));
        return;
      }
      const label = runtime.rtc.dataChannelLabel(channel);
      if (!isExpectedDataChannel(channel, label)) {
        runtime.rtc.closeDataChannel(channel);
        fail(new Error("Unexpected DataChannel parameters."));
        return;
      }
      if (channels.has(label)) {
        runtime.rtc.closeDataChannel(channel);
        fail(new Error(`Duplicate DataChannel ${label}.`));
        return;
      }
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

function incomingDataChannel(runtime: ReviewedCliRuntime, event: RTCDataChannelEvent): RTCDataChannel | undefined {
  const channel = ownDataValue(event, "channel");
  return runtime.rtc.isSafeIncomingDataChannel(channel) ? channel : undefined;
}

function isExpectedDataChannel(channel: RTCDataChannel, label: string | undefined): label is "control" | "bulk" {
  return (label === "control" || label === "bulk") && channel.ordered && isUnsetRetransmissionLimit(channel.maxPacketLifeTime) && isUnsetRetransmissionLimit(channel.maxRetransmits);
}

function isUnsetRetransmissionLimit(value: unknown): boolean {
  return value === null || value === 65535;
}

function waitForPairAccept(runtime: ReviewedCliRuntime, signaling: SignalingClient, sid: string, keys: SessionKeys, sealedManifest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for pair decision"));
    }, PAIR_TIMEOUT_MS);
    unrefTimer(timer);
    const onMessage = (message: unknown) => {
      if (!isServerMessage(message)) return;
      if ("sid" in message && message.sid !== sid) return;
      if (message.type === "pair-accept") {
        cleanup();
        if (runtime.security.verifyPairDecisionAuthTag(keys.signalAuthKey, sid, "receiver", "accept", sealedManifest, undefined, message.auth)) {
          resolve();
        } else {
          reject(new Error("Authenticated pair decision check failed. Wrong code or signaling MITM."));
        }
      } else if (message.type === "pair-reject") {
        cleanup();
        if (runtime.security.verifyPairDecisionAuthTag(keys.signalAuthKey, sid, "receiver", "reject", sealedManifest, message.reason, message.auth)) {
          reject(new Error(pairRejectMessage(message.reason)));
        } else {
          reject(new Error("Authenticated pair decision check failed. Wrong code or signaling MITM."));
        }
      } else if (message.type === "error") {
        cleanup();
        reject(new SignalingError(message.code));
      } else if (message.type === "peer-left") {
        cleanup();
        reject(new Error("Peer disconnected."));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Signaling socket closed."));
    };
    const onSocketError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onProtocolError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signaling.off("message", onMessage);
      signaling.off("close", onClose);
      signaling.off("socket-error", onSocketError);
      signaling.off("protocol-error", onProtocolError);
    };
    signaling.on("message", onMessage);
    signaling.on("close", onClose);
    signaling.on("socket-error", onSocketError);
    signaling.on("protocol-error", onProtocolError);
  });
}

function wireSignals(runtime: ReviewedCliRuntime, signaling: SignalingClient, pc: RTCPeerConnection, sid: string, keys: SessionKeys, answerOffers: boolean): { dispose: () => void; failure: Promise<never> } {
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
  };
  const fail = (error: Error) => {
    if (failed || disposed) return;
    failed = true;
    failSignal(error);
    safeSend(signaling, { type: "bye", sid, reason: "signal_error" });
    pc.close();
    dispose();
  };
  const onSignal = async (message: unknown) => {
    try {
      if (disposed) return;
      if (!isServerMessage(message)) return;
      if (message.type !== "signal" || message.sid !== sid) return;
      const peerRole = keys.role === "sender" ? "receiver" : "sender";
      if (!runtime.security.verifySignalAuthTag(keys.signalAuthKey, sid, peerRole, message.signal)) {
        throw new Error("Authenticated WebRTC signal check failed. Wrong code or signaling MITM.");
      }
      const signal = message.signal.kind === "candidate" ? copyCandidateSignal(message.signal) : message.signal;
      replayGuard.accept(signal);
      if (signal.kind === "candidate" && !pc.remoteDescription) {
        if (queuedCandidates.length >= MAX_QUEUED_ICE_CANDIDATES) throw new Error("Too many queued ICE candidates before SDP.");
        queuedCandidates.push(signal);
        return;
      }
      const kind = await runtime.rtc.handleSignal(pc, signal);
      if (disposed) return;
      if (kind === "offer" && answerOffers) {
        const answer = await pc.createAnswer();
        if (disposed) return;
        await pc.setLocalDescription(answer);
        if (disposed) return;
        const answerSdp = requireSdp(pc.localDescription?.sdp ?? answer.sdp);
        signaling.send({ type: "signal", sid, signal: { kind: "answer", sdp: answerSdp, auth: runtime.security.sdpAuthTag(keys.signalAuthKey, sid, keys.role, "answer", answerSdp) } });
      }
      if (pc.remoteDescription) {
        while (!disposed && queuedCandidates.length > 0) await runtime.rtc.handleSignal(pc, queuedCandidates.shift()!);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(safeErrorMessage(error)));
    }
  };
  signaling.on("signal", onSignal);
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

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function redactManifest(manifest: FileManifest): FileManifest {
  const files = ownDataValue(manifest, "files");
  const fileCount = ownDataValue(manifest, "fileCount");
  const totalBytes = ownDataValue(manifest, "totalBytes");
  if (
    !Array.isArray(files) ||
    typeof fileCount !== "number" ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 1 ||
    files.length !== fileCount ||
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0
  ) {
    throw new Error("Manifest is invalid.");
  }
  const redactedFiles: FileManifest["files"] = [];
  let remainingBytes = totalBytes;
  for (let index = 0; index < files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(files, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Manifest file entry is invalid.");
    const size = ownDataValue(descriptor.value, "size");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error("Manifest file size is invalid.");
    const redactedSize = Math.min(remainingBytes, MAX_FILE_BYTES);
    remainingBytes -= redactedSize;
    redactedFiles.push({ id: index, name: `encrypted-${index}`, size: redactedSize });
  }
  if (remainingBytes !== 0) throw new Error("Manifest is invalid.");
  return {
    fileCount,
    totalBytes,
    files: redactedFiles
  };
}

function requireSdp(sdp: string | undefined): string {
  if (!sdp) throw new Error("WebRTC did not produce an SDP payload.");
  return sdp;
}

function pairRejectMessage(_reason: string | undefined): string {
  return "Transfer rejected.";
}

function parseRequiredCode(code: string) {
  const parsed = parseCode(code);
  if (!parsed) throw new Error("Code must look like 12345678-two-words.");
  return parsed;
}

function assertRegisteredRendezvous(message: Extract<ServerMessage, { type: "registered" }>, expected: string): void {
  if (message.code !== expected) throw new Error("Signaling server returned a mismatched rendezvous code.");
}

function safeSend(signaling: SignalingClient, message: Parameters<SignalingClient["send"]>[0]): void {
  try {
    signaling.send(message);
  } catch {
    // Best-effort teardown; the socket may already be closed.
  }
}

function safeBye(signaling: SignalingClient, sid: string | undefined, reason: string): void {
  safeSend(signaling, sid === undefined ? { type: "bye", reason } : { type: "bye", sid, reason });
}

function print(options: CommonOptions, event: Record<string, unknown>): void {
  if (options.json) console.log(JSON.stringify(sanitizeStructuredOutput(event)));
}

function human(options: CommonOptions, message: string): void {
  if (!options.json && !options.quiet) console.log(sanitizeDisplayText(message));
}

function warnSensitiveSendArgv(options: CommonOptions): void {
  if (options.json || options.quiet || stderr.isTTY !== true) return;
  console.error(sanitizeDisplayText(SEND_ARGV_TELEMETRY_WARNING));
}

function warnSensitiveRecvArgv(options: CommonOptions): void {
  if (options.json || options.quiet || stderr.isTTY !== true) return;
  console.error(sanitizeDisplayText(RECV_ARGV_TELEMETRY_WARNING));
}

function rejectSensitiveSendArgv(options: CommonOptions, codeFromArgv: boolean, filesFromArgv: boolean): void {
  if (!options.requirePrivateInput) return;
  if (codeFromArgv && filesFromArgv) throw new Error("Receiver code and file path argv are disabled by --require-private-input. Use --code-stdin/--code-env and --files-stdin.");
  if (codeFromArgv) throw new Error("Receiver code argv is disabled by --require-private-input. Use --code-stdin or --code-env.");
  if (filesFromArgv) throw new Error("File path argv is disabled by --require-private-input. Use --files-stdin.");
}

function rejectSensitiveRecvArgv(options: CommonOptions): void {
  if (options.requirePrivateInput) throw new Error("Receive code argv is disabled by --require-private-input. Use --code-stdin or --code-env.");
}

async function runWithExit(fn: () => Promise<void>, options: CommonOptions): Promise<void> {
  try {
    await fn();
    process.exitCode = 0;
  } catch (error) {
    const code = classifyExitCode(error);
    printError(options, error, code);
    process.exitCode = code;
  }
}

function printError(options: CommonOptions, error: unknown, code: number): void {
  const message = sanitizeDisplayText(options.redactOutput ? redactedErrorMessage(code) : redactLocalPathEvidence(safeErrorMessage(error)));
  if (options.json) {
    console.error(JSON.stringify(sanitizeStructuredOutput({ event: "error", code, message })));
    return;
  }
  console.error(message);
}

function redactedErrorMessage(code: number): string {
  if (code === 2) return "Transfer declined.";
  if (code === 130) return "Interrupted.";
  return "Command failed. Re-run without --redact-output for details.";
}
