import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const sourceScript = new URL("../scripts/write-release-checksum.mjs", import.meta.url);

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-checksum-"));
  const scriptsDir = path.join(root, "scripts");
  const artifactDir = path.join(root, "release-artifacts");
  await fs.mkdir(scriptsDir);
  await fs.mkdir(artifactDir);
  await fs.copyFile(sourceScript, path.join(scriptsDir, "write-release-checksum.mjs"));
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "@victorhaine/p2p-transfer", version: "1.2.3" })}\n`);
  await fs.writeFile(path.join(artifactDir, "victorhaine-p2p-transfer-1.2.3.tgz"), Buffer.from("packed bytes"));
  return { artifactDir, root, script: path.join(scriptsDir, "write-release-checksum.mjs") };
}

test("release checksum writer emits the checksum for the exact packed tarball", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const expectedChecksum = createHash("sha256").update(Buffer.from("packed bytes")).digest("hex");
    assert.equal(await fs.readFile(path.join(artifactDir, "SHA256SUMS"), "utf8"), `${expectedChecksum}  victorhaine-p2p-transfer-1.2.3.tgz\n`);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release checksum writer rejects artifact directory widening without path leakage", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    await fs.writeFile(path.join(artifactDir, "extra.tgz"), Buffer.from("extra"));

    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release checksum generation failed:\nrelease artifact directory must contain exactly the expected tarball\./);
    assert.doesNotMatch(result.stderr, /ff-release-checksum-|at async|\.tgz/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release checksum writer does not leak raw filesystem paths on missing evidence", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    await fs.rm(path.join(artifactDir, "victorhaine-p2p-transfer-1.2.3.tgz"));

    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release checksum generation failed:\nrelease artifact directory must contain exactly the expected tarball\./);
    assert.doesNotMatch(result.stderr, /ff-release-checksum-|at async|victorhaine-p2p-transfer-1\.2\.3\.tgz/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release checksum writer rejects symlinked artifact directories without writing outside the project", { skip: process.platform === "win32" ? "directory symlink behavior differs on Windows." : false }, async () => {
  const { artifactDir, root, script } = await createFixture();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-checksum-outside-"));
  try {
    await fs.rm(artifactDir, { force: true, recursive: true });
    await fs.writeFile(path.join(outsideDir, "victorhaine-p2p-transfer-1.2.3.tgz"), Buffer.from("outside bytes"));
    await fs.symlink(outsideDir, artifactDir, "dir");

    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release checksum generation failed:\nrelease artifact directory must be a real directory\./);
    assert.doesNotMatch(result.stderr, /ff-release-checksum-|ff-release-checksum-outside-|at async|release-artifacts|victorhaine-p2p-transfer-1\.2\.3\.tgz/);
    await assert.rejects(() => fs.readFile(path.join(outsideDir, "SHA256SUMS"), "utf8"), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
    await fs.rm(outsideDir, { force: true, recursive: true });
  }
});
