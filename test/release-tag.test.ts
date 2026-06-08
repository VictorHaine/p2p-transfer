import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const sourceScript = new URL("../scripts/check-release-tag.mjs", import.meta.url);

async function createFixture(
  packageJson = `${JSON.stringify({ name: "@victorhaine/p2p-transfer", version: "1.2.3" })}\n`,
  options: { tagType?: string } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-tag-"));
  const scriptsDir = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  await fs.mkdir(scriptsDir);
  await fs.mkdir(bin);
  await fs.copyFile(sourceScript, path.join(scriptsDir, "check-release-tag.mjs"));
  await fs.writeFile(path.join(root, "package.json"), packageJson);
  await writeFakeGit(bin, log, options.tagType ?? "tag");
  return { root, script: path.join(scriptsDir, "check-release-tag.mjs"), env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, log };
}

test("release tag verifier accepts the exact package version tag", async () => {
  const { root, script, env, log } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v1.2.3"), ...env }
    });
    const gitRequests = await fs.readFile(log, "utf8");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(gitRequests, "cat-file -t refs/tags/v1.2.3\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier rejects lightweight tags without echoing git output", async () => {
  const { root, script, env } = await createFixture(undefined, { tagType: "commit" });
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v1.2.3"), ...env }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- release tag must be an annotated tag\./);
    assert.doesNotMatch(result.stderr, /refs\/tags|commit|ff-release-tag-|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier rejects mismatches without echoing tag or package evidence", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v9.9.9"), ...envForProcess() }
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
      env: { ...releaseTagEnv(`${"v".repeat(257)}`), ...envForProcess() }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- GITHUB_REF_NAME must be a non-empty control-free string under 256 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /vvvv|ff-release-tag-|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier rejects control-bearing release tag environment values", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v1.2.3\nwith-control"), ...envForProcess() }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- GITHUB_REF_NAME must be a non-empty control-free string under 256 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /with-control|ff-release-tag-|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier rejects branch refs even when the ref name looks like a tag", async () => {
  const { root, script } = await createFixture();
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v1.2.3"), GITHUB_REF_TYPE: "branch", GITHUB_REF: "refs/heads/v1.2.3", ...envForProcess() }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- release workflow ref must be the matching tag ref\./);
    assert.doesNotMatch(result.stderr, /refs\/heads|ff-release-tag-|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("release tag verifier owns invalid package JSON failures", async () => {
  const { root, script } = await createFixture("{bad package evidence}\n");
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...releaseTagEnv("v1.2.3"), ...envForProcess() }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release tag verification failed:\n- package metadata is not valid JSON\./);
    assert.doesNotMatch(result.stderr, /bad package|ff-release-tag-|SyntaxError|at async/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

function releaseTagEnv(tag: string): NodeJS.ProcessEnv {
  return { ...process.env, GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/${tag}` };
}

function envForProcess(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "" };
}

async function writeFakeGit(bin: string, log: string, tagType: string) {
  const gitScript = path.join(bin, "git-node.mjs");
  await fs.writeFile(
    gitScript,
    `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n", "utf8");
if (args.length === 3 && args[0] === "cat-file" && args[1] === "-t" && args[2] === "refs/tags/v1.2.3") {
  console.log(${JSON.stringify(tagType)});
  process.exit(0);
}
console.error("PRIVATE KEY material and raw git output must not leak");
process.exit(2);
`,
    "utf8"
  );
  const git = path.join(bin, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    await fs.writeFile(git, `@echo off\r\n"${process.execPath}" "${gitScript}" %*\r\n`, "utf8");
  } else {
    await fs.writeFile(git, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(gitScript)} "$@"\n`, "utf8");
  }
  await fs.chmod(git, 0o755);
}
