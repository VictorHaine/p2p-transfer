import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

type NativeWebRtc = {
  RTCPeerConnection: { new (configuration?: RTCConfiguration): RTCPeerConnection };
  RTCDataChannel: { new (): RTCDataChannel };
  RTCIceCandidate: { new (candidateInitDict?: RTCIceCandidateInit): RTCIceCandidate };
};

type DependencyEvidence = {
  name: string;
  version: string;
};

const requireFromCli = createRequire(import.meta.url);
const REVIEWED_NATIVE_WEBRTC_DEPENDENCIES = {
  wrtc: { name: "@roamhq/wrtc", version: "0.10.0" },
  domException: { name: "domexception", version: "4.0.0" },
  prebuilts: {
    "darwin-arm64": { name: "@roamhq/wrtc-darwin-arm64", version: "0.10.0" },
    "darwin-x64": { name: "@roamhq/wrtc-darwin-x64", version: "0.10.0" },
    "linux-arm64": { name: "@roamhq/wrtc-linux-arm64", version: "0.10.0" },
    "linux-x64": { name: "@roamhq/wrtc-linux-x64", version: "0.10.0" },
    "win32-x64": { name: "@roamhq/wrtc-win32-x64", version: "0.10.0" }
  }
} as const;

let verified = false;
let loaded: NativeWebRtc | undefined;

export function nativeWebRtc(): NativeWebRtc {
  if (loaded) return loaded;
  assertReviewedNativeWebRtcDependencies();
  try {
    loaded = nativeWebRtcInput(requireFromCli("@roamhq/wrtc"));
    return loaded;
  } catch {
    throw new Error("Native WebRTC package could not be loaded.");
  }
}

export function assertReviewedNativeWebRtcDependencies(): void {
  if (verified) return;
  try {
    const wrtc = packageEvidenceFromResolvedFile(requireFromCli.resolve("@roamhq/wrtc"));
    assertEvidence(wrtc, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.wrtc);
    assertNoLocalNativeBuildOutputs(wrtc.root);
    const requireFromWrtc = createRequire(path.join(wrtc.root, "package.json"));

    const prebuiltName = reviewedPlatformPrebuiltName();
    const prebuilt = packageEvidenceFromResolvedFile(requireFromWrtc.resolve(prebuiltName));
    assertEvidence(prebuilt, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts[reviewedPlatformTriple()]);

    const domException = packageEvidenceFromResolvedFile(requireFromWrtc.resolve("domexception"));
    assertEvidence(domException, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.domException);
    verified = true;
  } catch {
    throw new Error("Reviewed native WebRTC dependency versions are not installed.");
  }
}

function assertNoLocalNativeBuildOutputs(packageRoot: string): void {
  const entries = readdirSync(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^build-[a-z0-9_-]+$/u.test(entry.name)) {
      throw new Error("Native WebRTC package contains unreviewed local build outputs.");
    }
  }
}

function nativeWebRtcInput(value: unknown): NativeWebRtc {
  const candidate = defaultExportValue(value);
  const RTCPeerConnection = constructorValue(candidate, "RTCPeerConnection") as NativeWebRtc["RTCPeerConnection"];
  const RTCDataChannel = constructorValue(candidate, "RTCDataChannel") as NativeWebRtc["RTCDataChannel"];
  const RTCIceCandidate = constructorValue(candidate, "RTCIceCandidate") as NativeWebRtc["RTCIceCandidate"];
  return { RTCPeerConnection, RTCDataChannel, RTCIceCandidate };
}

function defaultExportValue(value: unknown): unknown {
  if (value && typeof value === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(value, "default");
    if (descriptor && "value" in descriptor && descriptor.value !== undefined) return descriptor.value;
  }
  return value;
}

function constructorValue(value: unknown, key: keyof NativeWebRtc): unknown {
  if (!value || typeof value !== "object") throw new Error("Native WebRTC package is invalid.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("Native WebRTC package is invalid.");
  return descriptor.value as NativeWebRtc[keyof NativeWebRtc];
}

function reviewedPlatformPrebuiltName(): string {
  return REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts[reviewedPlatformTriple()].name;
}

function reviewedPlatformTriple(): keyof typeof REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts {
  const triple = `${os.platform()}-${os.arch()}`;
  if (
    triple === "darwin-arm64" ||
    triple === "darwin-x64" ||
    triple === "linux-arm64" ||
    triple === "linux-x64" ||
    triple === "win32-x64"
  ) {
    return triple;
  }
  throw new Error("Native WebRTC platform is unsupported.");
}

function assertEvidence(actual: DependencyEvidence, expected: { name: string; version: string }): void {
  if (actual.name !== expected.name || actual.version !== expected.version) throw new Error("Native WebRTC dependency evidence is invalid.");
}

function packageEvidenceFromResolvedFile(resolvedFile: string): DependencyEvidence & { root: string } {
  const root = packageRootFromResolvedFile(resolvedFile);
  const evidence = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (typeof evidence.name !== "string" || typeof evidence.version !== "string") {
    throw new Error("Dependency package metadata is invalid.");
  }
  return { root, name: evidence.name, version: evidence.version };
}

function packageRootFromResolvedFile(resolvedFile: string): string {
  let current = path.dirname(resolvedFile);
  for (;;) {
    try {
      const evidence = JSON.parse(readFileSync(path.join(current, "package.json"), "utf8")) as { name?: unknown };
      if (typeof evidence.name === "string") return current;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Dependency package metadata is missing.");
    current = parent;
  }
}
