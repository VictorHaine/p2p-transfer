import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertReviewedCryptoDependencies, assertReviewedDependencyEvidence, type ReviewedDependency } from "../src/cli/crypto-dependencies.js";
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

    const evidence = packageEvidenceFromResolvedFile(resolvedFile);
    assert.equal(evidence.root, packageRoot);
    assert.equal(evidence.name, "@scope/pkg");
    assert.equal(evidence.version, "1.2.3");
    assert.deepEqual(evidence.metadata, { name: "@scope/pkg", version: "1.2.3" });

    await writeFile(path.join(packageRoot, "package.json"), Buffer.alloc(128 * 1024 + 1, 0x20));
    assert.throws(() => packageEvidenceFromResolvedFile(resolvedFile), /Dependency package metadata is invalid\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI crypto dependency attestation rejects changed reviewed metadata", async () => {
  const reviewed: ReviewedDependency = {
    name: "@scope/pkg",
    version: "1.2.3",
    license: "MIT",
    repositoryUrl: "git+https://example.invalid/reviewed.git",
    homepage: "https://example.invalid/reviewed",
    type: "module",
    main: "./dist/index.cjs",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist", "LICENSE"],
    sideEffects: false,
    dependencies: { "@scope/dep": "4.5.6" },
    allowedScripts: { prepublishOnly: "npm test && npm run build" },
    exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" }, "./cpace": "./dist/cpace.js" }
  };
  const packageJson = {
    name: "@scope/pkg",
    version: "1.2.3",
    license: "MIT",
    repository: { type: "git", url: "git+https://example.invalid/reviewed.git" },
    homepage: "https://example.invalid/reviewed",
    type: "module",
    main: "./dist/index.cjs",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist", "LICENSE"],
    sideEffects: false,
    dependencies: { "@scope/dep": "4.5.6" },
    scripts: { build: "tsup", prepublishOnly: "npm test && npm run build" },
    exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" }, "./cpace": "./dist/cpace.js" }
  };

  assert.doesNotThrow(() => assertReviewedDependencyEvidence(packageEvidence(packageJson), reviewed));
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence({ ...packageJson, scripts: { ...packageJson.scripts, postinstall: "node install.js" } }), reviewed), /metadata/);
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence({ ...packageJson, scripts: { ...packageJson.scripts, prepublish: "node publish.js" } }), reviewed), /metadata/);
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence({ ...packageJson, exports: { ".": packageJson.exports["."] } }), reviewed), /metadata/);
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence({ ...packageJson, dependencies: { "@scope/dep": "^4.5.6" } }), reviewed), /metadata/);
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence({ ...packageJson, optionalDependencies: { "@scope/extra": "1.0.0" } }), reviewed), /metadata/);
  const { allowedScripts, ...unreviewedScriptPolicy } = reviewed;
  void allowedScripts;
  assert.throws(() => assertReviewedDependencyEvidence(packageEvidence(packageJson), unreviewedScriptPolicy), /metadata/);
});

function packageEvidence(metadata: Record<string, unknown>) {
  return {
    root: "/tmp/reviewed-package",
    name: metadata.name as string,
    version: metadata.version as string,
    metadata
  };
}
