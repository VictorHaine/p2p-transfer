import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const sourceScript = new URL("../scripts/write-release-notes.mjs", import.meta.url);

async function createFixture(options: { changelog?: string; packageJson?: unknown } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-notes-"));
  const scriptsDir = path.join(root, "scripts");
  const artifactDir = path.join(root, "release-artifacts");
  await fs.mkdir(scriptsDir);
  await fs.mkdir(artifactDir);
  await fs.copyFile(sourceScript, path.join(scriptsDir, "write-release-notes.mjs"));
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(options.packageJson ?? { name: "@victorhaine/p2p-transfer", version: "1.2.3" })}\n`);
  await fs.writeFile(
    path.join(root, "CHANGELOG.md"),
    options.changelog ??
      [
        "# Changelog",
        "",
        "## 1.2.4 - 2026-06-07",
        "",
        "- Future fix.",
        "",
        "## 1.2.3 - 2026-06-06",
        "",
        "Current release.",
        "",
        "- Added the checked thing.",
        "",
        "## 1.2.2 - 2026-06-05",
        "",
        "- Previous fix.",
        ""
      ].join("\n")
  );
  return { artifactDir, root, script: path.join(scriptsDir, "write-release-notes.mjs") };
}

test("release notes writer emits only the current package changelog section", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(await fs.readFile(path.join(artifactDir, "RELEASE_NOTES.md"), "utf8"), "Current release.\n\n- Added the checked thing.\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release notes writer check mode validates notes without writing", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    await assert.rejects(() => fs.readFile(path.join(artifactDir, "RELEASE_NOTES.md"), "utf8"), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release notes writer check mode rejects missing notes before artifact creation", async () => {
  const { artifactDir, root, script } = await createFixture({
    changelog: "# Changelog\n\n## 9.9.9 - 2026-06-06\n\nWrong release.\n"
  });
  try {
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release notes generation failed:\nchangelog does not contain release notes for the package version\./);
    await assert.rejects(() => fs.readFile(path.join(artifactDir, "RELEASE_NOTES.md"), "utf8"), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release notes writer accepts bracketed changelog version headings", async () => {
  const { artifactDir, root, script } = await createFixture({
    changelog: "# Changelog\n\n## [1.2.3] - 2026-06-06\n\nBracketed release.\n"
  });
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(await fs.readFile(path.join(artifactDir, "RELEASE_NOTES.md"), "utf8"), "Bracketed release.\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release notes writer rejects missing version notes without path leakage", async () => {
  const { root, script } = await createFixture({
    changelog: "# Changelog\n\n## 9.9.9 - 2026-06-06\n\nWrong release.\n"
  });
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release notes generation failed:\nchangelog does not contain release notes for the package version\./);
    assert.doesNotMatch(result.stderr, /ff-release-notes-|at async|CHANGELOG|package\.json/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release notes writer refuses to overwrite an existing notes file", async () => {
  const { artifactDir, root, script } = await createFixture();
  try {
    await fs.writeFile(path.join(artifactDir, "RELEASE_NOTES.md"), "stale notes\n");
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release notes generation failed:\nrelease notes generation failed\./);
    assert.equal(await fs.readFile(path.join(artifactDir, "RELEASE_NOTES.md"), "utf8"), "stale notes\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
