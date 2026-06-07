import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { packageEvidenceFromResolvedFile, type DependencyEvidence } from "./dependency-metadata.js";

type NativeWebRtc = {
  RTCPeerConnection: { new (configuration?: RTCConfiguration): RTCPeerConnection };
  RTCDataChannel: { new (): RTCDataChannel };
  RTCIceCandidate: { new (candidateInitDict?: RTCIceCandidateInit): RTCIceCandidate };
};

const requireFromCli = createRequire(import.meta.url);
const REVIEWED_NATIVE_WEBRTC_DEPENDENCIES = {
  wrtc: {
    name: "@roamhq/wrtc",
    version: "0.10.0",
    license: "BSD-2-Clause",
    repository: { type: "git", url: "git+ssh://git@github.com/WonderInventions/node-webrtc.git" },
    homepage: "https://github.com/WonderInventions/node-webrtc",
    bugs: "https://github.com/WonderInventions/node-webrtc/issues",
    main: "lib/index.js",
    types: "types/index.d.ts",
    browser: "lib/browser.js",
    files: ["AUTHORS", "CHANGELOG.md", "lib", "types"],
    scripts: {
      patch: "patch-package --error-on-warn",
      build: "node scripts/build-from-source.js",
      "make-prebuilt": "node scripts/make-prebuilt.js",
      "install-example": "node scripts/install-example.js",
      lint: "eslint lib/*.js lib/**/*.js test/*.js test/**/*.js scripts/*.js",
      test: "node --expose-gc test/all.js",
      prepare: "husky"
    },
    optionalDependencies: {
      "@roamhq/wrtc-darwin-arm64": "0.10.0",
      "@roamhq/wrtc-darwin-x64": "0.10.0",
      "@roamhq/wrtc-linux-arm64": "0.10.0",
      "@roamhq/wrtc-linux-x64": "0.10.0",
      "@roamhq/wrtc-win32-x64": "0.10.0",
      domexception: "^4.0.0"
    }
  },
  domException: {
    name: "domexception",
    version: "4.0.0",
    license: "MIT",
    repository: "jsdom/domexception",
    main: "index.js",
    files: ["index.js", "webidl2js-wrapper.js", "lib/"],
    scripts: {
      prepare: "node scripts/generate.js",
      "init-wpt": "node scripts/get-latest-platform-tests.js",
      pretest: "npm run prepare && npm run init-wpt",
      test: "mocha",
      lint: "eslint ."
    },
    dependencies: { "webidl-conversions": "^7.0.0" }
  },
  prebuilts: {
    "darwin-arm64": { name: "@roamhq/wrtc-darwin-arm64", version: "0.10.0", license: "BSD-2-Clause", repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" } },
    "darwin-x64": { name: "@roamhq/wrtc-darwin-x64", version: "0.10.0", license: "BSD-2-Clause", repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" } },
    "linux-arm64": { name: "@roamhq/wrtc-linux-arm64", version: "0.10.0", license: "BSD-2-Clause", repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" } },
    "linux-x64": { name: "@roamhq/wrtc-linux-x64", version: "0.10.0", license: "BSD-2-Clause", repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" } },
    "win32-x64": { name: "@roamhq/wrtc-win32-x64", version: "0.10.0", license: "BSD-2-Clause", repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" } }
  }
} as const;

export type ReviewedNativeDependency = {
  name: string;
  version: string;
  license?: string;
  repository?: unknown;
  homepage?: string;
  bugs?: string;
  main?: string;
  types?: string;
  browser?: string;
  files?: readonly string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

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
    assertReviewedNativeDependencyEvidence(wrtc, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.wrtc);
    assertNoNativeFallbackSurfaces(wrtc.root, reviewedPlatformTriple());
    const requireFromWrtc = createRequire(path.join(wrtc.root, "package.json"));

    const prebuiltName = reviewedPlatformPrebuiltName();
    const prebuiltBinary = resolveReviewedPrebuiltBinary(requireFromWrtc, prebuiltName);
    const prebuilt = packageEvidenceFromResolvedFile(prebuiltBinary);
    assertReviewedNativeDependencyEvidence(prebuilt, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts[reviewedPlatformTriple()]);
    assertResolvedFileWithinPackageRoot(prebuiltBinary, prebuilt.root, "Reviewed native WebRTC prebuilt binary");
    assertLoadReviewedNativePrebuilt(prebuiltBinary);

    const domException = packageEvidenceFromResolvedFile(requireFromWrtc.resolve("domexception"));
    assertReviewedNativeDependencyEvidence(domException, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.domException);
    verified = true;
  } catch {
    throw new Error("Reviewed native WebRTC dependency metadata is not installed.");
  }
}

export function assertNoNativeFallbackSurfaces(packageRoot: string, triple: string = reviewedPlatformTriple()): void {
  const entries = readdirSync(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^build-[a-z0-9_-]+$/u.test(entry.name)) {
      throw new Error("Native WebRTC package contains unreviewed local build outputs.");
    }
  }
  const nestedPrebuilt = path.join(packageRoot, "node_modules", `@roamhq/wrtc-${triple}`);
  try {
    lstatSync(nestedPrebuilt);
    throw new Error("Native WebRTC package contains unreviewed nested prebuilt outputs.");
  } catch (error) {
    if (isMissingPathError(error)) return;
    if (error instanceof Error && error.message === "Native WebRTC package contains unreviewed nested prebuilt outputs.") throw error;
    throw new Error("Native WebRTC package contains unreviewed nested prebuilt outputs.");
  }
}

function resolveReviewedPrebuiltBinary(requireFromWrtc: NodeRequire, prebuiltName: string): string {
  return requireFromWrtc.resolve(`${prebuiltName}/wrtc.node`);
}

function assertResolvedFileWithinPackageRoot(resolvedFile: string, packageRoot: string, label: string): void {
  const resolvedReal = realpathSync(resolvedFile);
  const rootReal = realpathSync(packageRoot);
  const relative = path.relative(rootReal, resolvedReal);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error(`${label} is outside the reviewed package.`);
  }
  if (!lstatSync(resolvedReal).isFile()) throw new Error(`${label} is not a regular file.`);
}

function assertLoadReviewedNativePrebuilt(prebuiltBinary: string): void {
  const binding = requireFromCli(prebuiltBinary) as unknown;
  for (const key of ["RTCPeerConnection", "RTCDataChannel", "setDOMException"]) {
    if (!binding || typeof binding !== "object") throw new Error("Reviewed native WebRTC prebuilt is invalid.");
    const descriptor = Object.getOwnPropertyDescriptor(binding, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error("Reviewed native WebRTC prebuilt is invalid.");
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && "value" in descriptor && descriptor.value === "ENOENT");
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

export function assertReviewedNativeDependencyEvidence(actual: DependencyEvidence, expected: ReviewedNativeDependency): void {
  if (actual.name !== expected.name || actual.version !== expected.version) throw new Error("Native WebRTC dependency evidence is invalid.");
  const metadata = actual.metadata;
  assertNativeMetadata(metadata, "license", expected.license);
  assertNativeMetadata(metadata, "repository", expected.repository);
  assertNativeMetadata(metadata, "homepage", expected.homepage);
  assertNativeMetadata(metadata, "bugs", expected.bugs);
  assertNativeMetadata(metadata, "main", expected.main);
  assertNativeMetadata(metadata, "types", expected.types);
  assertNativeMetadata(metadata, "browser", expected.browser);
  assertNativeMetadata(metadata, "files", expected.files);
  assertNativeMetadata(metadata, "scripts", expected.scripts);
  assertNativeMetadata(metadata, "dependencies", expected.dependencies);
  assertNativeMetadata(metadata, "optionalDependencies", expected.optionalDependencies);
  assertNativeMetadata(metadata, "peerDependencies", expected.peerDependencies);
}

function assertNativeMetadata(metadata: Record<string, unknown>, key: string, expected: unknown): void {
  const value = ownNativeMetadataValue(metadata, key);
  if (expected === undefined) {
    if (value !== undefined) throw new Error("Native WebRTC dependency evidence is invalid.");
    return;
  }
  if (!sameJsonValue(value, expected)) throw new Error("Native WebRTC dependency evidence is invalid.");
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]));
  }
  return left === right;
}

function ownNativeMetadataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw new Error("Native WebRTC dependency evidence is invalid.");
  return descriptor.value;
}
