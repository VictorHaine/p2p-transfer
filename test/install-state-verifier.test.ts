import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const verifierSource = await fs.readFile(new URL("../scripts/check-install-state.mjs", import.meta.url), "utf8");

test("installed-state verifier accepts matching minimal dependency evidence", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {}, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("installed-state verifier import has no filesystem verification side effects", async () => {
  const root = await writeVerifierFixture({
    packageJson: Buffer.from("{bad json that must not be read on import}\n"),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });
  try {
    const script = path.join(root, "scripts", "check-install-state.mjs");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(script).href)});`], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  } finally {
    await removeTestTemp(root);
  }
});

test("installed-state verifier rejects invalid utf-8 package and lockfile evidence", async () => {
  for (const fixture of [
    {
      packageJson: Buffer.from([0xff]),
      rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
      installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
    },
    {
      packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {}, devDependencies: {} })}\n`),
      rootLockfile: Buffer.from([0x6c, 0x6f, 0x63, 0x6b, 0xff]),
      installedLockfile: Buffer.from([0x6c, 0x6f, 0x63, 0x6b, 0xff])
    }
  ]) {
    const result = await runVerifierFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid UTF-8|invalid JSON evidence|could not verify lockfile evidence/);
  }
});

test("installed-state verifier owns invalid package JSON failures without stack paths", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from("{bad json from local workspace}\n"),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed dependency tree could not be verified:/);
  assert.match(result.stderr, /invalid JSON evidence at package\.json/);
  assert.doesNotMatch(result.stderr, /bad json|local workspace|check-install-state\.mjs|SyntaxError/);
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(result.root)));
});

test("installed-state verifier rejects duplicate direct dependency declarations", async () => {
  const packageJson = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { ws: "8.20.1" },
    devDependencies: { ws: "8.21.0" }
  };
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify(packageJson)}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Dependency ws must not be declared in both dependencies and devDependencies/);
});

test("installed-state verifier rejects non-registry or non-sha512 lockfile package resolutions", async () => {
  for (const resolution of [
    "resolution: {tarball: https://example.invalid/ws-8.20.1.tgz, integrity: sha512-fixture}",
    "resolution: {repo: git+https://example.invalid/ws.git, commit: 0123456789abcdef0123456789abcdef01234567}",
    "resolution: {directory: ../ws, type: directory}",
    "resolution: {integrity: sha1-fixture}",
    "engines: {node: '>=18'}"
  ]) {
    const packageJson = {
      name: "fixture",
      version: "1.0.0",
      dependencies: { ws: "8.20.1" },
      devDependencies: {}
    };
    const lockfile = fixtureLockfile("ws", "8.20.1", resolution);
    const result = await runVerifierFixture({
      packageJson: Buffer.from(`${JSON.stringify(packageJson)}\n`),
      rootLockfile: Buffer.from(lockfile),
      installedLockfile: Buffer.from(lockfile),
      installedPackages: {
        ws: { name: "ws", version: "8.20.1" }
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pnpm-lock\.yaml contains a non-registry or non-sha512 package resolution/);
    assert.doesNotMatch(result.stderr, /example\.invalid|0123456789abcdef|sha1-fixture|\.\.\/ws/);
  }
});

test("installed-state verifier does not echo invalid dependency names", async () => {
  const packageJson = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { "bad\nname": "1.0.0" },
    devDependencies: {}
  };
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify(packageJson)}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid dependency name in package\.json\./);
  assert.doesNotMatch(result.stderr, /bad\\nname|bad\nname/);
});

test("installed-state verifier does not echo invalid dependency version pins", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { ws: "8.20.1\nbad" }, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ws: expected exact semver package\.json pin/);
  assert.doesNotMatch(result.stderr, /8\.20\.1\\nbad|8\.20\.1\nbad/);
});

test("installed-state verifier does not echo raw filesystem errors for missing installed packages", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { ws: "8.20.1" }, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ws: could not read installed package evidence at node_modules\/ws\/package\.json/);
  assert.doesNotMatch(result.stderr, /ENOENT|lstat|no such file|\/node_modules\/ws\/package\.json/);
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(result.root)));
});

test("installed-state verifier rejects installed packages with the wrong identity", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { ws: "8.20.1" }, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedPackages: {
      ws: { name: "not-ws", version: "8.20.1" }
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ws: installed package identity does not match expected name/);
  assert.doesNotMatch(result.stderr, /not-ws/);
});

test("installed-state verifier does not echo invalid installed package metadata", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { ws: "8.20.1" }, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedPackages: {
      ws: { name: "bad\nname", version: "8.20.1" }
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ws: installed package identity is invalid/);
  assert.doesNotMatch(result.stderr, /bad\\nname|bad\nname/);
});

test("installed-state verifier does not echo mismatched installed package versions", async () => {
  const result = await runVerifierFixture({
    packageJson: Buffer.from(`${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { ws: "8.20.1" }, devDependencies: {} })}\n`),
    rootLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedLockfile: Buffer.from("lockfileVersion: '9.0'\n"),
    installedPackages: {
      ws: { name: "ws", version: "8.21.0" }
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ws: installed package version does not match package\.json pin/);
  assert.doesNotMatch(result.stderr, /8\.21\.0/);
});

async function runVerifierFixture(fixture: {
  packageJson: Buffer;
  rootLockfile: Buffer;
  installedLockfile: Buffer;
  installedPackages?: Record<string, { name: string; version: string }>;
}) {
  const root = await writeVerifierFixture(fixture);
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-install-state.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000
    });
    return { ...result, root };
  } finally {
    await removeTestTemp(root);
  }
}

async function writeVerifierFixture(fixture: {
  packageJson: Buffer;
  rootLockfile: Buffer;
  installedLockfile: Buffer;
  installedPackages?: Record<string, { name: string; version: string }>;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-install-state-"));
  const scriptsDir = path.join(root, "scripts");
  const installedLockDir = path.join(root, "node_modules", ".pnpm");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.mkdir(installedLockDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, "check-install-state.mjs"), verifierSource, { mode: 0o755 });
  await fs.writeFile(path.join(root, "package.json"), fixture.packageJson);
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), fixture.rootLockfile);
  await fs.writeFile(path.join(installedLockDir, "lock.yaml"), fixture.installedLockfile);
  for (const [name, packageJson] of Object.entries(fixture.installedPackages ?? {})) {
    const packageDir = path.join(root, "node_modules", ...name.split("/"));
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), `${JSON.stringify(packageJson)}\n`);
  }
  return root;
}

async function removeTestTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function fixtureLockfile(name: string, version: string, resolution: string): string {
  return `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ${name}:
        specifier: ${version}
        version: ${version}

packages:

  ${name}@${version}:
    ${resolution}

snapshots:

  ${name}@${version}:
    optional: false
`;
}
