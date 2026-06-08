import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
      "dist/cpace/index.js": "6724ffbbd017b5a495eb4c4428c6e7bec0f9eab6029474bc0b1382fbfed6d679"
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
      "esm/_shortw_utils.js": "d682f22ec3ed2aafcfbf38082f57d8cc5bd96b1d9ea5e1083d1799b3db089fca",
      "esm/abstract/curve.js": "3aa6e31b64ee99cfeaa4e64764e0d262d8736128ebd001a9e680bc9dcf66f01d",
      "esm/abstract/edwards.js": "94004e8dc1a805c1d27f0d14af4c9655cdfd43cb9732b6404ba0211fa731c046",
      "esm/abstract/hash-to-curve.js": "52d3315f4e9bf3ad9c901deaeb2fe861c6ea2f92ff8c9f792653b7751117413f",
      "esm/abstract/modular.js": "5b42d5ff746ac099400e96c036572548d71822bc0826de506922d66202e7ce4c",
      "esm/abstract/montgomery.js": "5ed0fbfba5a66691a187be5da5cd86177ec87352860cc28530742794a94d8bbf",
      "esm/ed25519.js": "9d1ec0fa0ad8e6e8d097e4231dcd4e874975edf4410cfe6b4340dde371852b84",
      "esm/utils.js": "f293043fc8020d5a928b4fd0c2b29b0d4aa23eca7b17f6b449484ba5e74ccdf3"
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
      "esm/_md.js": "cefb1557e7715cb2117c83f82ef3e3175c7e0391c80bd5795b2d4effc45fc582",
      "esm/_u64.js": "e48c0cfc10810439a4807b46db136ce603a3fa09b62584f513ef2f3ca496af54",
      "esm/cryptoNode.js": "26f80c6a85b6ef7bfd83b99d95b2b5ba8764397b9465feff32e81ba4e6416619",
      "esm/sha2.js": "e729088b82e5450bff54c3a0013582aa42e1fe8f58dd31f5967f6ebe34c52299",
      "esm/utils.js": "4cf4c1e05affedcb4fd584a43d76ae1a3711e34a36e2251b90c27e33ecc74fad"
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
  },
  wordlist: {
    name: "@scure/bip39",
    version: "2.2.0",
    license: "MIT",
    repositoryUrl: "git+https://github.com/paulmillr/scure-bip39.git",
    homepage: "https://paulmillr.com/noble/#scure",
    type: "module",
    main: "index.js",
    module: "index.js",
    types: "index.d.ts",
    files: ["index.js", "index.d.ts", "wordlists/*.js", "wordlists/*.d.ts", "src/index.ts"],
    sideEffects: false,
    dependencies: { "@noble/hashes": "2.2.0", "@scure/base": "2.2.0" },
    resolvedFiles: {
      "wordlists/english.js": "961d1c711e071b4a5bb698461cce45614cc487d9a45e99bb975a174f0ea2dbc4"
    },
    requiredExports: {
      ".": "./index.js",
      "./wordlists/english.js": "./wordlists/english.js"
    }
  },
  wordlistBase: {
    name: "@scure/base",
    version: "2.2.0",
    license: "MIT",
    repositoryUrl: "git+https://github.com/paulmillr/scure-base.git",
    homepage: "https://paulmillr.com/noble/#scure",
    type: "module",
    main: "index.js",
    module: "index.js",
    types: "index.d.ts",
    files: ["index.js", "index.js.map", "index.d.ts", "index.d.ts.map", "index.ts"],
    sideEffects: false,
    resolvedFiles: {
      "index.js": "69501488e8af95addf77a91cb4255292ff45fdd7a63bf4cae3d329d02fd330a7"
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
    const pake = packageEvidenceFromResolvedFile(fileURLToPath(import.meta.resolve("@cipherman/pake-js/cpace")));
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

    const wordlistResolved = requireFromCli.resolve("@scure/bip39/wordlists/english.js");
    const wordlist = packageEvidenceFromResolvedFile(wordlistResolved);
    assertReviewedDependencyEvidence(wordlist, REVIEWED_CRYPTO_DEPENDENCIES.wordlist);
    assertReviewedDependencyFileEvidence(wordlist, REVIEWED_CRYPTO_DEPENDENCIES.wordlist);

    const requireFromWordlist = createRequire(path.join(wordlist.root, "package.json"));
    const wordlistBaseResolved = requireFromWordlist.resolve("@scure/base");
    const wordlistBase = packageEvidenceFromResolvedFile(wordlistBaseResolved);
    assertReviewedDependencyEvidence(wordlistBase, REVIEWED_CRYPTO_DEPENDENCIES.wordlistBase);
    assertReviewedDependencyFileEvidence(wordlistBase, REVIEWED_CRYPTO_DEPENDENCIES.wordlistBase);
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
