import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { packageEvidenceFromResolvedFile, sha256FileEvidenceFromResolvedFile, type DependencyEvidence } from "./dependency-metadata.js";

type NativeWebRtc = {
  RTCPeerConnection: { new (configuration?: RTCConfiguration): RTCPeerConnection };
  RTCDataChannel: { new (): RTCDataChannel };
  RTCIceCandidate: { new (candidateInitDict?: RTCIceCandidateInit): RTCIceCandidate };
};

const requireFromCli = createRequire(import.meta.url);
const MAX_NATIVE_WEBRTC_FILE_BYTES = 64 * 1024 * 1024;
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
    resolvedFiles: {
      "lib/binding.js": "855729de6ed99559225d489ca316421e05d5dbc950578017ebe5be7eff2c9475",
      "lib/browser.js": "b39d3f5606da5d31702da82f75cbbc41d3edc7bce8041f19c26be146cd21bb2e",
      "lib/datachannelevent.js": "3c68e710ee352bbfa9f47a46a915a595899c74c2f82a676f7d4fbcea2db28041",
      "lib/datachannelmessageevent.js": "53436df6b796d413ca0e94294f21ebe7c5e9ae73b0af7bcd8aca951f88bd514d",
      "lib/error.js": "4df8733d81ebb929b095d26ae9037ecc642338a47146358261a481cf75a4fe21",
      "lib/eventtarget.js": "9771b85de597873816e5abeac68d5cb1b159e66d0e65f2895145b1286d45cb42",
      "lib/icecandidate.js": "4e46a3702e3af8b85119304f39a1ac90a2e35157babf2ea5b50ddd45c7b14b0c",
      "lib/index.js": "3340521d1c72f51f6ab9eade422270b5764e8eb2acf8474a451399d77957a12f",
      "lib/mediadevices.js": "644f6e9c1c56cf5e427d6a1ddd1a988dd5bf967d6b5d1bd1f752d35031f5b864",
      "lib/peerconnection.js": "f7f0b6e979971aaffeae63b5485c0d6cb6e6d5cbf774838a97aae7478bf1bf44",
      "lib/rtcpeerconnectioniceerrorevent.js": "cb50427826edc60d2a70bcb9de2bdef0383d9f705a68a714985cce5c48928b2f",
      "lib/rtcpeerconnectioniceevent.js": "a0acbea6fb7884d40cca997a23a3e144fa025e248e4fa1302242f728aa3ecc19",
      "lib/sessiondescription.js": "e189f9a88ff070e228595962cc6cdcca7527645fd788e56e74d22f3597b4f768"
    },
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
    resolvedFiles: {
      "index.js": "3abf3c410669e5a9693379a9ed3a2cea9a82e5dff8d0faacd510cc8cd0557a93",
      "lib/DOMException-impl.js": "a9da20a1200a5be420adaf13e455790c3086deb0f37213c9b94f05a62ed53333",
      "lib/DOMException.js": "531fc73fc4eb0b29177d09a450052c4656056d86c1ed326848f15fdb34143d19",
      "lib/Function.js": "913cb6a510a344fd81bdfd45c5053bc63352d31331e4e97daf6bb9baf8317910",
      "lib/VoidFunction.js": "9b404e93615b95bd26051da63d631d134ae8c7ff057d2324d094abed18ff8dcc",
      "lib/utils.js": "3dce521ab525a11eb5d817a78bf3308a8ab2e16b73c5c288f81c8d6ad496fa2e",
      "webidl2js-wrapper.js": "7bf1497eb2f68d9f7de614c8d30e854e2015c534df7ac63c96b02e4405986673"
    },
    scripts: {
      prepare: "node scripts/generate.js",
      "init-wpt": "node scripts/get-latest-platform-tests.js",
      pretest: "npm run prepare && npm run init-wpt",
      test: "mocha",
      lint: "eslint ."
    },
    dependencies: { "webidl-conversions": "^7.0.0" }
  },
  webidlConversions: {
    name: "webidl-conversions",
    version: "7.0.0",
    license: "BSD-2-Clause",
    repository: "jsdom/webidl-conversions",
    main: "lib/index.js",
    files: ["lib/"],
    resolvedFiles: {
      "lib/index.js": "c3b203d992b46905b610d240313d72e96d04b756942d9612878104ee12b107d4"
    },
    scripts: {
      lint: "eslint .",
      test: "mocha test/*.js",
      "test-no-sab": "mocha --parallel --jobs 2 --require test/helpers/delete-sab.js test/*.js",
      coverage: "nyc mocha test/*.js"
    }
  },
  prebuilts: {
    "darwin-arm64": {
      name: "@roamhq/wrtc-darwin-arm64",
      version: "0.10.0",
      license: "BSD-2-Clause",
      repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" },
      resolvedFiles: {
        "index.js": "6d77257c9d50361fcc2286ed02bbcb0ffda7ffa204211d05c51b21c22e3b02fe",
        "wrtc.node": "844f7e2ed329c652b9f07f26c8aa46930d72f6c8220dba2e63038bbe2e73cdf5"
      }
    },
    "darwin-x64": {
      name: "@roamhq/wrtc-darwin-x64",
      version: "0.10.0",
      license: "BSD-2-Clause",
      repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" },
      resolvedFiles: {
        "index.js": "6d77257c9d50361fcc2286ed02bbcb0ffda7ffa204211d05c51b21c22e3b02fe",
        "wrtc.node": "910e4b82e7cad29998529df19c4b265ab154dc2a2a8df5861474552c6e99af14"
      }
    },
    "linux-arm64": {
      name: "@roamhq/wrtc-linux-arm64",
      version: "0.10.0",
      license: "BSD-2-Clause",
      repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" },
      resolvedFiles: {
        "index.js": "6d77257c9d50361fcc2286ed02bbcb0ffda7ffa204211d05c51b21c22e3b02fe",
        "wrtc.node": "78636a264bb350c8b7d074916ca2a4897a369d1623958dfc1d5daec183433b93"
      }
    },
    "linux-x64": {
      name: "@roamhq/wrtc-linux-x64",
      version: "0.10.0",
      license: "BSD-2-Clause",
      repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" },
      resolvedFiles: {
        "index.js": "6d77257c9d50361fcc2286ed02bbcb0ffda7ffa204211d05c51b21c22e3b02fe",
        "wrtc.node": "a629f3ee4aa32a097361270f719007e62325068dac347086218027ce4274302f"
      }
    },
    "win32-x64": {
      name: "@roamhq/wrtc-win32-x64",
      version: "0.10.0",
      license: "BSD-2-Clause",
      repository: { type: "git", url: "git+https://github.com/WonderInventions/node-webrtc.git" },
      resolvedFiles: {
        "index.js": "6d77257c9d50361fcc2286ed02bbcb0ffda7ffa204211d05c51b21c22e3b02fe",
        "wrtc.node": "ca5d94c351e2cff49df4aedb7b3a22f7e8aee19926d0b6bbe9e60689153196e7"
      }
    }
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
  resolvedFiles?: Record<string, string>;
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
    assertReviewedNativeDependencyFileEvidence(wrtc, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.wrtc);
    assertNoNativeFallbackSurfaces(wrtc.root, reviewedPlatformTriple());
    const requireFromWrtc = createRequire(path.join(wrtc.root, "package.json"));

    const prebuiltName = reviewedPlatformPrebuiltName();
    const prebuiltBinary = resolveReviewedPrebuiltBinary(requireFromWrtc, prebuiltName);
    const prebuilt = packageEvidenceFromResolvedFile(prebuiltBinary);
    assertReviewedNativeDependencyEvidence(prebuilt, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts[reviewedPlatformTriple()]);
    assertResolvedFileWithinPackageRoot(prebuiltBinary, prebuilt.root, "Reviewed native WebRTC prebuilt binary");
    assertReviewedNativeDependencyFileEvidence(prebuilt, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.prebuilts[reviewedPlatformTriple()]);
    assertLoadReviewedNativePrebuilt(prebuiltBinary);

    const domException = packageEvidenceFromResolvedFile(requireFromWrtc.resolve("domexception"));
    assertReviewedNativeDependencyEvidence(domException, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.domException);
    assertReviewedNativeDependencyFileEvidence(domException, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.domException);

    const requireFromDomException = createRequire(path.join(domException.root, "package.json"));
    const webidlConversions = packageEvidenceFromResolvedFile(requireFromDomException.resolve("webidl-conversions"));
    assertReviewedNativeDependencyEvidence(webidlConversions, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.webidlConversions);
    assertReviewedNativeDependencyFileEvidence(webidlConversions, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES.webidlConversions);
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
  let nestedPrebuiltExists = false;
  try {
    lstatSync(nestedPrebuilt);
    nestedPrebuiltExists = true;
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw new Error("Native WebRTC package contains unreviewed nested prebuilt outputs.");
  }
  if (nestedPrebuiltExists) throw new Error("Native WebRTC package contains unreviewed nested prebuilt outputs.");
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

export function assertReviewedNativeDependencyFileEvidence(actual: DependencyEvidence & { root: string }, expected: ReviewedNativeDependency): void {
  if (expected.resolvedFiles === undefined) return;
  for (const [relative, digest] of Object.entries(expected.resolvedFiles)) {
    if (!isSafeReviewedRelativeFile(relative)) throw new Error("Native WebRTC dependency file evidence is invalid.");
    const resolvedFile = path.join(actual.root, relative);
    const normalized = path.relative(actual.root, resolvedFile).split(path.sep).join("/");
    if (normalized !== relative || sha256FileEvidenceFromResolvedFile(resolvedFile, MAX_NATIVE_WEBRTC_FILE_BYTES) !== digest) {
      throw new Error("Native WebRTC dependency file evidence is invalid.");
    }
  }
}

function isSafeReviewedRelativeFile(relative: string): boolean {
  return relative.length > 0 && !path.isAbsolute(relative) && !relative.split("/").includes("..") && !relative.endsWith("/");
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
