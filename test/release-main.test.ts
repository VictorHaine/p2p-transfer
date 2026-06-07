import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const sourceScript = new URL("../scripts/check-release-main.mjs", import.meta.url);

async function createGitFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-main-"));
  const origin = path.join(tmp, "origin.git");
  const root = path.join(tmp, "work");
  await runGit(["init", "--bare", "--initial-branch=main", origin], tmp);
  await fs.mkdir(root);
  await runGit(["init", "--initial-branch=main"], root);
  await runGit(["config", "user.email", "release@example.invalid"], root);
  await runGit(["config", "user.name", "Release Test"], root);
  await runGit(["config", "commit.gpgsign", "false"], root);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(sourceScript, path.join(root, "scripts", "check-release-main.mjs"));
  await fs.writeFile(path.join(root, "tracked.txt"), "main\n");
  await runGit(["add", "."], root);
  await runGit(["commit", "--no-gpg-sign", "--no-verify", "-m", "main"], root);
  await runGit(["remote", "add", "origin", origin], root);
  await runGit(["push", "-u", "origin", "main"], root);
  const mainSha = gitOutput(["rev-parse", "HEAD"], root);
  await runGit(["checkout", "-b", "side"], root);
  await fs.writeFile(path.join(root, "tracked.txt"), "side\n");
  await runGit(["commit", "--no-gpg-sign", "--no-verify", "-am", "side"], root);
  const sideSha = gitOutput(["rev-parse", "HEAD"], root);
  return { root, script: path.join(root, "scripts", "check-release-main.mjs"), mainSha, sideSha };
}

test("release main verifier accepts a tag commit reachable from origin main", async () => {
  const fixture = await createGitFixture();
  try {
    const result = runVerifier(fixture.script, fixture.mainSha);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(path.dirname(fixture.root), { force: true, recursive: true });
  }
});

test("release main verifier rejects commits that are not reachable from origin main", async () => {
  const fixture = await createGitFixture();
  try {
    const result = runVerifier(fixture.script, fixture.sideSha);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release main reachability check failed:\n- release tag commit is not reachable from main\./);
    assert.doesNotMatch(result.stderr, new RegExp(`${fixture.sideSha}|${escapeRegExp(fixture.root)}|origin\\.git|at async`));
  } finally {
    await fs.rm(path.dirname(fixture.root), { force: true, recursive: true });
  }
});

test("release main verifier validates the GitHub SHA environment value", async () => {
  const fixture = await createGitFixture();
  try {
    const result = runVerifier(fixture.script, "not-a-sha");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release main reachability check failed:\n- GITHUB_SHA must be a 40-character hex commit id\./);
    assert.doesNotMatch(result.stderr, /not-a-sha|ff-release-main-|at async/);
  } finally {
    await fs.rm(path.dirname(fixture.root), { force: true, recursive: true });
  }
});

function runVerifier(script: string, sha: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_SHA: sha }
  });
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function gitOutput(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
