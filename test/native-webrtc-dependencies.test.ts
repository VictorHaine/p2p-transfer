import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoNativeFallbackSurfaces, assertReviewedNativeDependencyEvidence, assertReviewedNativeDependencyFileEvidence, assertReviewedNativeWebRtcDependencies, nativeWebRtc, type ReviewedNativeDependency } from "../src/cli/native-webrtc.js";
import { sha256FileEvidenceFromResolvedFile } from "../src/cli/dependency-metadata.js";

const nativeWebrtcSource = fs.readFileSync(new URL("../src/cli/native-webrtc.ts", import.meta.url), "utf8");

test("CLI runtime native WebRTC dependency attestation accepts the reviewed install graph", () => {
  assert.doesNotThrow(() => assertReviewedNativeWebRtcDependencies());
});

test("native WebRTC loader exposes required constructors after attestation", () => {
  const wrtc = nativeWebRtc();
  assert.equal(typeof wrtc.RTCPeerConnection, "function");
  assert.equal(typeof wrtc.RTCDataChannel, "function");
  assert.equal(typeof wrtc.RTCIceCandidate, "function");
});

test("native WebRTC attestation rejects changed reviewed metadata", () => {
  const reviewed: ReviewedNativeDependency = {
    name: "@scope/native",
    version: "1.2.3",
    license: "BSD-2-Clause",
    repository: { type: "git", url: "git+https://example.invalid/native.git" },
    homepage: "https://example.invalid/native",
    bugs: "https://example.invalid/native/issues",
    main: "lib/index.js",
    types: "types/index.d.ts",
    browser: "lib/browser.js",
    files: ["lib", "types"],
    scripts: { prepare: "husky" },
    optionalDependencies: { "@scope/native-darwin-arm64": "1.2.3" }
  };
  const packageJson = {
    name: "@scope/native",
    version: "1.2.3",
    license: "BSD-2-Clause",
    repository: { type: "git", url: "git+https://example.invalid/native.git" },
    homepage: "https://example.invalid/native",
    bugs: "https://example.invalid/native/issues",
    main: "lib/index.js",
    types: "types/index.d.ts",
    browser: "lib/browser.js",
    files: ["lib", "types"],
    scripts: { prepare: "husky" },
    optionalDependencies: { "@scope/native-darwin-arm64": "1.2.3" }
  };

  assert.doesNotThrow(() => assertReviewedNativeDependencyEvidence(nativeEvidence(packageJson), reviewed));
  assert.throws(() => assertReviewedNativeDependencyEvidence(nativeEvidence({ ...packageJson, scripts: { prepare: "node install.js" } }), reviewed), /evidence/);
  assert.throws(() => assertReviewedNativeDependencyEvidence(nativeEvidence({ ...packageJson, optionalDependencies: { "@scope/native-darwin-arm64": "^1.2.3" } }), reviewed), /evidence/);
  assert.throws(() => assertReviewedNativeDependencyEvidence(nativeEvidence({ ...packageJson, dependencies: { "left-pad": "1.3.0" } }), reviewed), /evidence/);
});

test("native WebRTC file attestation hashes reviewed runtime files before load", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-wrtc-file-evidence-"));
  try {
    const packageRoot = path.join(root, "node_modules", "@scope", "native");
    const reviewedFile = path.join(packageRoot, "dist", "index.js");
    const content = "module.exports = { reviewed: true };\n";
    await mkdir(path.dirname(reviewedFile), { recursive: true });
    await writeFile(reviewedFile, content);
    const evidence = nativeEvidence({ name: "@scope/native", version: "1.2.3" }, packageRoot);
    const digest = createHash("sha256").update(content).digest("hex");

    assert.doesNotThrow(() => assertReviewedNativeDependencyFileEvidence(evidence, { name: "@scope/native", version: "1.2.3", resolvedFiles: { "dist/index.js": digest } }));
    assert.throws(() => assertReviewedNativeDependencyFileEvidence(evidence, { name: "@scope/native", version: "1.2.3", resolvedFiles: { "dist/index.js": "0".repeat(64) } }), /file evidence/);
    assert.throws(() => assertReviewedNativeDependencyFileEvidence(evidence, { name: "@scope/native", version: "1.2.3", resolvedFiles: { "../index.js": digest } }), /file evidence/);
    assert.throws(() => sha256FileEvidenceFromResolvedFile(reviewedFile, content.length - 1), /Dependency package file is invalid\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native WebRTC attestation rejects local build output precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-wrtc-build-output-"));
  try {
    await mkdir(path.join(root, "build-darwin-arm64"));
    assert.throws(() => assertNoNativeFallbackSurfaces(root, "darwin-arm64"), /Native WebRTC package contains unreviewed local build outputs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(nativeWebrtcSource, /assertNoNativeFallbackSurfaces\(wrtc\.root, reviewedPlatformTriple\(\)\)/);
  assert.match(nativeWebrtcSource, /readdirSync\(packageRoot, \{ withFileTypes: true \}\)/);
  assert.match(nativeWebrtcSource, /\^build-\[a-z0-9_-\]\+\$/);
  assert.match(nativeWebrtcSource, /Native WebRTC package contains unreviewed local build outputs\./);
});

test("native WebRTC attestation rejects nested prebuilt fallback precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-wrtc-nested-prebuilt-"));
  try {
    await mkdir(path.join(root, "node_modules", "@roamhq", "wrtc-darwin-arm64"), { recursive: true });
    assert.throws(() => assertNoNativeFallbackSurfaces(root, "darwin-arm64"), /Native WebRTC package contains unreviewed nested prebuilt outputs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(nativeWebrtcSource, /requireFromWrtc\.resolve\(`\$\{prebuiltName\}\/wrtc\.node`\)/);
  assert.match(nativeWebrtcSource, /assertResolvedFileWithinPackageRoot\(prebuiltBinary, prebuilt\.root, "Reviewed native WebRTC prebuilt binary"\)/);
  assert.match(nativeWebrtcSource, /assertReviewedNativeDependencyFileEvidence\(prebuilt, REVIEWED_NATIVE_WEBRTC_DEPENDENCIES\.prebuilts\[reviewedPlatformTriple\(\)\]\)/);
  assert.match(nativeWebrtcSource, /assertLoadReviewedNativePrebuilt\(prebuiltBinary\)/);
});

function nativeEvidence(metadata: Record<string, unknown>, root = "/tmp/reviewed-native-package") {
  return {
    root,
    name: metadata.name as string,
    version: metadata.version as string,
    metadata
  };
}
