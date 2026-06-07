import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type DependencyEvidence = {
  name: string;
  version: string;
};

const requireFromCli = createRequire(import.meta.url);
const REVIEWED_CRYPTO_DEPENDENCIES = {
  pake: { name: "@cipherman/pake-js", version: "0.1.1" },
  pakeCurves: { name: "@noble/curves", version: "1.9.7" },
  curvesHashes: { name: "@noble/hashes", version: "1.8.0" },
  directHashes: { name: "@noble/hashes", version: "2.2.0" }
} as const;

let verified = false;

export function assertReviewedCryptoDependencies(): void {
  if (verified) return;
  try {
    const pake = packageEvidenceFromResolvedFile(requireFromCli.resolve("@cipherman/pake-js"));
    assertEvidence(pake, REVIEWED_CRYPTO_DEPENDENCIES.pake);

    const requireFromPake = createRequire(path.join(pake.root, "package.json"));
    const pakeCurves = packageEvidenceFromResolvedFile(requireFromPake.resolve("@noble/curves/ed25519.js"));
    assertEvidence(pakeCurves, REVIEWED_CRYPTO_DEPENDENCIES.pakeCurves);

    const requireFromCurves = createRequire(path.join(pakeCurves.root, "package.json"));
    const curvesHashes = packageEvidenceFromResolvedFile(requireFromCurves.resolve("@noble/hashes/sha2.js"));
    assertEvidence(curvesHashes, REVIEWED_CRYPTO_DEPENDENCIES.curvesHashes);

    const directHashes = packageEvidenceFromResolvedFile(requireFromCli.resolve("@noble/hashes/hkdf.js"));
    assertEvidence(directHashes, REVIEWED_CRYPTO_DEPENDENCIES.directHashes);
    verified = true;
  } catch {
    throw new Error("Reviewed cryptographic dependency versions are not installed.");
  }
}

function assertEvidence(actual: DependencyEvidence, expected: { name: string; version: string }): void {
  if (actual.name !== expected.name || actual.version !== expected.version) {
    throw new Error("Reviewed cryptographic dependency versions are not installed.");
  }
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
