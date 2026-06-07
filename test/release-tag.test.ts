import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const sourceScript = new URL("../scripts/check-release-tag.mjs", import.meta.url);

async function createFixture(packageJson = `${JSON.stringify({ name: "@victorhaine/p2p-transfer", version: "1.2.3" })}\n`) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-tag-"));
  const scriptsDir = path.join(root, "scripts");
  await fs.mkdir(scriptsDir);
  await fs.copyFile(sourceScript, path.join(scriptsDir, "check-release-tag.mjs"));
  await fs.writeFile(path.join(root, "package.json"), packageJson);
  return { root, script: path.join(scriptsDir, "check-release-tag.mjs") };
}

test("release tag verifier accepts the exact package version tag", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: "v1.2.3" }
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier rejects mismatches without echoing tag or package evidence", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: "v9.9.9" }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- release tag does not match package version\./);
    assert.doesNotMatch(result.stderr, /v9\.9\.9|1\.2\.3|ff-release-tag-|package\.json|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier byte-caps release tag environment values", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: `${"v".repeat(257)}` }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- GITHUB_REF_NAME must be a non-empty NUL-free string under 256 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /vvvv|ff-release-tag-|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier owns invalid package JSON failures", async () => {
  const { root, script } = await createFixture("{bad package evidence}\n");
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: "v1.2.3" }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- package metadata is not valid JSON\./);
    assert.doesNotMatch(result.stderr, /bad package|ff-release-tag-|SyntaxError|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
