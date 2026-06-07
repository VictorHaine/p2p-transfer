import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertReviewedCryptoDependencies } from "../src/cli/crypto-dependencies.js";
import { packageEvidenceFromResolvedFile } from "../src/cli/dependency-metadata.js";

test("CLI runtime crypto dependency attestation accepts the reviewed install graph", () => {
  assert.doesNotThrow(() => assertReviewedCryptoDependencies());
});

test("CLI dependency metadata attestation reads bounded package metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ff-dependency-metadata-"));
  try {
    const packageRoot = path.join(root, "node_modules", "@scope", "pkg");
    const resolvedFile = path.join(packageRoot, "dist", "index.js");
    await mkdir(path.dirname(resolvedFile), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }));
    await writeFile(resolvedFile, "");

    assert.deepEqual(packageEvidenceFromResolvedFile(resolvedFile), { root: packageRoot, name: "@scope/pkg", version: "1.2.3" });

    await writeFile(path.join(packageRoot, "package.json"), Buffer.alloc(128 * 1024 + 1, 0x20));
    assert.throws(() => packageEvidenceFromResolvedFile(resolvedFile), /Dependency package metadata is invalid\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
