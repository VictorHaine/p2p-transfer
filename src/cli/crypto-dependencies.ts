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
    resolvedFile: "dist/index.cjs",
    resolvedFileSha256: "3acc7e2184b3f9cd7fe01797d15cfe4a6dc07ced0ea48312ae0389e5d519f94d",
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
    resolvedFile: "ed25519.js",
    resolvedFileSha256: "33df162c066fcaef63f82118d296dcbb49ab94dc729e76c9dc5dea67f6f1da09",
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
    resolvedFile: "sha2.js",
    resolvedFileSha256: "53b6dc30db76a7c4e4b9370049e7a3c01bbb5507d058c084e97ccb3ee050faa4",
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
    resolvedFile: "hkdf.js",
    resolvedFileSha256: "c0de209ef30cc76c14781d7746e6802b44eb17b7bfad6c07e5c17c5806c9836d",
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
  resolvedFile?: string;
  resolvedFileSha256?: string;
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
    assertReviewedDependencyFileEvidence(requireFromCli.resolve("@cipherman/pake-js"), pake, REVIEWED_CRYPTO_DEPENDENCIES.pake);

    const requireFromPake = createRequire(path.join(pake.root, "package.json"));
    const pakeCurvesResolved = requireFromPake.resolve("@noble/curves/ed25519.js");
    const pakeCurves = packageEvidenceFromResolvedFile(pakeCurvesResolved);
    assertReviewedDependencyEvidence(pakeCurves, REVIEWED_CRYPTO_DEPENDENCIES.pakeCurves);
    assertReviewedDependencyFileEvidence(pakeCurvesResolved, pakeCurves, REVIEWED_CRYPTO_DEPENDENCIES.pakeCurves);

    const requireFromCurves = createRequire(path.join(pakeCurves.root, "package.json"));
    const curvesHashesResolved = requireFromCurves.resolve("@noble/hashes/sha2.js");
    const curvesHashes = packageEvidenceFromResolvedFile(curvesHashesResolved);
    assertReviewedDependencyEvidence(curvesHashes, REVIEWED_CRYPTO_DEPENDENCIES.curvesHashes);
    assertReviewedDependencyFileEvidence(curvesHashesResolved, curvesHashes, REVIEWED_CRYPTO_DEPENDENCIES.curvesHashes);

    const directHashesResolved = requireFromCli.resolve("@noble/hashes/hkdf.js");
    const directHashes = packageEvidenceFromResolvedFile(directHashesResolved);
    assertReviewedDependencyEvidence(directHashes, REVIEWED_CRYPTO_DEPENDENCIES.directHashes);
    assertReviewedDependencyFileEvidence(directHashesResolved, directHashes, REVIEWED_CRYPTO_DEPENDENCIES.directHashes);
    verified = true;
  } catch {
    throw new Error("Reviewed cryptographic dependency metadata is not installed.");
  }
}

export function assertReviewedDependencyFileEvidence(resolvedFile: string, actual: DependencyEvidence & { root: string }, expected: ReviewedDependency): void {
  if (expected.resolvedFile === undefined || expected.resolvedFileSha256 === undefined) return;
  const relative = path.relative(actual.root, resolvedFile).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative) || relative !== expected.resolvedFile) {
    throw new Error("Reviewed cryptographic dependency file changed.");
  }
  if (sha256FileEvidenceFromResolvedFile(resolvedFile) !== expected.resolvedFileSha256) {
    throw new Error("Reviewed cryptographic dependency file changed.");
  }
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
