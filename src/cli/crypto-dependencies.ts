import path from "node:path";
import { createRequire } from "node:module";
import { packageEvidenceFromResolvedFile, sha256FileEvidenceFromResolvedFile, type DependencyEvidence } from "./dependency-metadata.js";

const requireFromCli = createRequire(import.meta.url);
const REVIEWED_CRYPTO_DEPENDENCIES = {
  pake: {
    name: "@cipherman/pake-js",
    version: "0.1.1",
    license: "MIT",
    repositoryUrl: "git+https://github.com/alicommit-malp/pake-js.git",
    homepage: "https://github.com/alicommit-malp/pake-js#readme",
    type: "module",
    main: "./dist/index.cjs",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist", "README.md", "SECURITY.md", "THREAT_MODEL.md", "CHANGELOG.md", "LICENSE"],
    sideEffects: false,
    dependencies: { "@noble/curves": "^1.6.0" },
    resolvedFiles: {
      "dist/index.cjs": "3acc7e2184b3f9cd7fe01797d15cfe4a6dc07ced0ea48312ae0389e5d519f94d"
    },
    allowedScripts: {
      prepublishOnly: "npm run clean && npm run typecheck && npm run lint && npm run test && npm run build"
    },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" },
      "./spake2plus": { types: "./dist/spake2plus/index.d.ts", import: "./dist/spake2plus/index.js", require: "./dist/spake2plus/index.cjs" },
      "./cpace": { types: "./dist/cpace/index.d.ts", import: "./dist/cpace/index.js", require: "./dist/cpace/index.cjs" }
    }
  },
  pakeCurves: {
    name: "@noble/curves",
    version: "1.9.7",
    license: "MIT",
    repositoryUrl: "git+https://github.com/paulmillr/noble-curves.git",
    homepage: "https://paulmillr.com/noble/",
    main: "index.js",
    files: ["*.js", "*.js.map", "*.d.ts", "*.d.ts.map", "esm", "src", "abstract", "!oprf.*", "!webcrypto.*"],
    sideEffects: false,
    dependencies: { "@noble/hashes": "1.8.0" },
    resolvedFiles: {
      "_shortw_utils.js": "1a44701bd94ad867d6aa8db17e34419d658ed9ca523ca72caa855c9b653dffba",
      "abstract/curve.js": "b2ef0dbeff436119e37a334664d963543a206113b3fd64751d569843b3bc8fbf",
      "abstract/edwards.js": "e70868d1264a20c8f8d27d9a77d605311cfeee5f77320d5c1ab296dd1f3eb7e8",
      "abstract/hash-to-curve.js": "ee7191cac74b34f790e9b2c8fc9f3db1fde5d2a23ceeb70e7c4eec97f9a36320",
      "abstract/modular.js": "82be07e6154b3783e73df561c2bc3a0bf7ed6ea4424282da03dc94b4f20ee967",
      "abstract/montgomery.js": "baa8963dee6aa4040e7595739d0c397cc3bf29bdef027148776115c436cbfd68",
      "abstract/weierstrass.js": "149fd490c6871c20a538103ce711b9fc706dc217d889aeafb438572729b0f0dc",
      "ed25519.js": "33df162c066fcaef63f82118d296dcbb49ab94dc729e76c9dc5dea67f6f1da09",
      "nist.js": "8e5255870c92d027980735de232255e11e492affd421e205c386dfa6d74df01c",
      "p256.js": "ceb26fc3b95ac670bfa789de5971065738b154073a84ea478d9a397a95f3d258",
      "utils.js": "ada99f7eb2cc1a8ade552b5d980ea510678b3fc3bd00f7f1278af98824ccb89f"
    },
    requiredExports: {
      "./ed25519": { import: "./esm/ed25519.js", require: "./ed25519.js" },
      "./ed25519.js": { import: "./esm/ed25519.js", require: "./ed25519.js" }
    }
  },
  curvesHashes: {
    name: "@noble/hashes",
    version: "1.8.0",
    license: "MIT",
    repositoryUrl: "git+https://github.com/paulmillr/noble-hashes.git",
    homepage: "https://paulmillr.com/noble/",
    files: ["/*.js", "/*.js.map", "/*.d.ts", "/*.d.ts.map", "esm", "src/*.ts"],
    sideEffects: false,
    resolvedFiles: {
      "_md.js": "4eaf0ae8f8191c50acdab7c3de7f335bf24845e4b562bdbc3e9f61cb7a873831",
      "_u64.js": "9b109bb57c0d8852bda12136f0f588ffea2a1a3c0f4241bdbb3727cd449976ae",
      "cryptoNode.js": "7d96258d2ff9da048ceb1fe88fb68172c5f952e461dda65fd08f30e20b5416ae",
      "hmac.js": "1e0e4081a255691a1bae9148d9c5795e3439980d4ecb346a5e62a9c7fb3764a4",
      "sha2.js": "53b6dc30db76a7c4e4b9370049e7a3c01bbb5507d058c084e97ccb3ee050faa4",
      "utils.js": "7edf19720c345e1cb76e8d3a9306f3344457d4e03576bbb0b3e1ffd0a42d0d30"
    },
    requiredExports: {
      "./sha2": { import: "./esm/sha2.js", require: "./sha2.js" },
      "./sha2.js": { import: "./esm/sha2.js", require: "./sha2.js" }
    }
  },
  directHashes: {
    name: "@noble/hashes",
    version: "2.2.0",
    license: "MIT",
    repositoryUrl: "git+https://github.com/paulmillr/noble-hashes.git",
    homepage: "https://paulmillr.com/noble/",
    type: "module",
    main: "index.js",
    module: "index.js",
    types: "index.d.ts",
    files: ["*.js", "*.js.map", "*.d.ts", "*.d.ts.map", "src"],
    sideEffects: false,
    resolvedFiles: {
      "_md.js": "8227b9b5cabf078a9d7f7317f7a1ace6e46627539aa9364667aec724e1636f14",
      "_u64.js": "766b91a693a798f9d3cde97b25db4a6d0cef66b2ca21153d3d42424d37878870",
      "hkdf.js": "c0de209ef30cc76c14781d7746e6802b44eb17b7bfad6c07e5c17c5806c9836d",
      "hmac.js": "137ed94227806b351a55b09801287a4dba72d2a35d3838730becf641271bc3dd",
      "legacy.js": "4722d1db35565d162f60f56065a6c283397188f582255b2a3cef809837b254cd",
      "sha2.js": "0fb8e3c3f2c73a890be2524ac5d2542aaed4decff69e561231a86131203b3973",
      "utils.js": "e2adfc13c846487feff0410bd5508a1d66f5ebadc3188f3a40a6b55449981e2f"
    },
    requiredExports: {
      ".": "./index.js",
      "./hkdf.js": "./hkdf.js",
      "./hmac.js": "./hmac.js",
      "./sha2.js": "./sha2.js",
      "./utils.js": "./utils.js"
    }
  }
} as const;
const REVIEWED_SCRIPT_SURFACE = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"] as const;

export type ReviewedDependency = {
  name: string;
  version: string;
  license?: string;
  repositoryUrl?: string;
  homepage?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  files?: readonly string[];
  sideEffects?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  resolvedFiles?: Record<string, string>;
  allowedScripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  requiredExports?: Record<string, unknown>;
};

let verified = false;

export function assertReviewedCryptoDependencies(): void {
  if (verified) return;
  try {
    const pake = packageEvidenceFromResolvedFile(requireFromCli.resolve("@cipherman/pake-js"));
    assertReviewedDependencyEvidence(pake, REVIEWED_CRYPTO_DEPENDENCIES.pake);
    assertReviewedDependencyFileEvidence(pake, REVIEWED_CRYPTO_DEPENDENCIES.pake);

    const requireFromPake = createRequire(path.join(pake.root, "package.json"));
    const pakeCurvesResolved = requireFromPake.resolve("@noble/curves/ed25519.js");
    const pakeCurves = packageEvidenceFromResolvedFile(pakeCurvesResolved);
    assertReviewedDependencyEvidence(pakeCurves, REVIEWED_CRYPTO_DEPENDENCIES.pakeCurves);
    assertReviewedDependencyFileEvidence(pakeCurves, REVIEWED_CRYPTO_DEPENDENCIES.pakeCurves);

    const requireFromCurves = createRequire(path.join(pakeCurves.root, "package.json"));
    const curvesHashesResolved = requireFromCurves.resolve("@noble/hashes/sha2.js");
    const curvesHashes = packageEvidenceFromResolvedFile(curvesHashesResolved);
    assertReviewedDependencyEvidence(curvesHashes, REVIEWED_CRYPTO_DEPENDENCIES.curvesHashes);
    assertReviewedDependencyFileEvidence(curvesHashes, REVIEWED_CRYPTO_DEPENDENCIES.curvesHashes);

    const directHashesResolved = requireFromCli.resolve("@noble/hashes/hkdf.js");
    const directHashes = packageEvidenceFromResolvedFile(directHashesResolved);
    assertReviewedDependencyEvidence(directHashes, REVIEWED_CRYPTO_DEPENDENCIES.directHashes);
    assertReviewedDependencyFileEvidence(directHashes, REVIEWED_CRYPTO_DEPENDENCIES.directHashes);
    verified = true;
  } catch {
    throw new Error("Reviewed cryptographic dependency metadata is not installed.");
  }
}

export function assertReviewedDependencyFileEvidence(actual: DependencyEvidence & { root: string }, expected: ReviewedDependency): void {
  if (expected.resolvedFiles === undefined) return;
  for (const [relative, digest] of Object.entries(expected.resolvedFiles)) {
    if (!isSafeReviewedRelativeFile(relative)) throw new Error("Reviewed cryptographic dependency file changed.");
    const resolvedFile = path.join(actual.root, relative);
    const normalized = path.relative(actual.root, resolvedFile).split(path.sep).join("/");
    if (normalized !== relative || sha256FileEvidenceFromResolvedFile(resolvedFile) !== digest) {
      throw new Error("Reviewed cryptographic dependency file changed.");
    }
  }
}

function isSafeReviewedRelativeFile(relative: string): boolean {
  return relative.length > 0 && !path.isAbsolute(relative) && !relative.split("/").includes("..") && !relative.endsWith("/");
}

export function assertReviewedDependencyEvidence(actual: DependencyEvidence, expected: ReviewedDependency): void {
  if (actual.name !== expected.name || actual.version !== expected.version) {
    throw new Error("Reviewed cryptographic dependency metadata is not installed.");
  }
  const metadata = actual.metadata;
  assertOptionalString(metadata, "license", expected.license);
  assertRepositoryUrl(metadata, expected.repositoryUrl);
  assertOptionalString(metadata, "homepage", expected.homepage);
  assertOptionalString(metadata, "type", expected.type);
  assertOptionalString(metadata, "main", expected.main);
  assertOptionalString(metadata, "module", expected.module);
  assertOptionalString(metadata, "types", expected.types);
  assertExactJson(metadata, "files", expected.files);
  assertExactJson(metadata, "sideEffects", expected.sideEffects);
  assertExactJson(metadata, "dependencies", expected.dependencies);
  assertExactJson(metadata, "optionalDependencies", expected.optionalDependencies);
  assertExactJson(metadata, "peerDependencies", expected.peerDependencies);
  assertReviewedScripts(metadata, expected.allowedScripts ?? {});
  if (expected.exports) assertExactJson(metadata, "exports", expected.exports);
  if (expected.requiredExports) assertRequiredExports(metadata, expected.requiredExports);
}

function assertOptionalString(metadata: Record<string, unknown>, key: string, expected: string | undefined): void {
  const value = ownMetadataValue(metadata, key);
  if (expected === undefined) {
    if (value !== undefined) throw new Error("Reviewed cryptographic dependency metadata changed.");
    return;
  }
  if (value !== expected) throw new Error("Reviewed cryptographic dependency metadata changed.");
}

function assertRepositoryUrl(metadata: Record<string, unknown>, expected: string | undefined): void {
  if (expected === undefined) return;
  const repository = ownMetadataValue(metadata, "repository");
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new Error("Reviewed cryptographic dependency metadata changed.");
  if (ownMetadataValue(repository as Record<string, unknown>, "url") !== expected) throw new Error("Reviewed cryptographic dependency metadata changed.");
}

function assertReviewedScripts(metadata: Record<string, unknown>, allowedScripts: Record<string, string>): void {
  const scripts = ownMetadataValue(metadata, "scripts");
  if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts))) throw new Error("Reviewed cryptographic dependency metadata changed.");
  const scriptRecord = (scripts ?? {}) as Record<string, unknown>;
  for (const key of REVIEWED_SCRIPT_SURFACE) {
    if (ownMetadataValue(scriptRecord, key) !== undefined && !Object.hasOwn(allowedScripts, key)) throw new Error("Reviewed cryptographic dependency metadata changed.");
  }
  for (const [key, expected] of Object.entries(allowedScripts)) {
    if (ownMetadataValue(scriptRecord, key) !== expected) throw new Error("Reviewed cryptographic dependency metadata changed.");
  }
}

function assertRequiredExports(metadata: Record<string, unknown>, expected: Record<string, unknown>): void {
  const exportsValue = ownMetadataValue(metadata, "exports");
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) throw new Error("Reviewed cryptographic dependency metadata changed.");
  for (const [key, value] of Object.entries(expected)) {
    if (!sameJsonValue(ownMetadataValue(exportsValue as Record<string, unknown>, key), value)) {
      throw new Error("Reviewed cryptographic dependency metadata changed.");
    }
  }
}

function assertExactJson(metadata: Record<string, unknown>, key: string, expected: unknown): void {
  const value = ownMetadataValue(metadata, key);
  if (expected === undefined) {
    if (value !== undefined) throw new Error("Reviewed cryptographic dependency metadata changed.");
    return;
  }
  if (!sameJsonValue(value, expected)) throw new Error("Reviewed cryptographic dependency metadata changed.");
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownMetadataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw new Error("Reviewed cryptographic dependency metadata changed.");
  return descriptor.value;
}
