import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release publish script rejects static npm tokens before artifact work", () => {
  const result = runScript("scripts/publish-release-artifact.mjs", {
    NODE_AUTH_TOKEN: "static-token-that-must-not-publish",
    GITHUB_REF_NAME: "v0.1.0"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release publish failed:\n- NODE_AUTH_TOKEN must not be present for trusted publishing\./);
  assert.doesNotMatch(result.stderr, /release artifact directory|static-token|Error:/);
});

test("GitHub release script rejects malformed tags before artifact or gh work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    GITHUB_REF_NAME: "bad-tag\nwith-control",
    GITHUB_REPOSITORY: "VictorHaine/p2p-transfer",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GITHUB_REF_NAME must be an exact release tag\./);
  assert.doesNotMatch(result.stderr, /bad-tag|with-control|release artifact directory|gh:|token-that-must-not-be-used|Error:/);
});

test("GitHub release script rejects malformed repositories before artifact or gh work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    GITHUB_REF_NAME: "v0.1.0",
    GITHUB_REPOSITORY: "not/a/repo/name",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GITHUB_REPOSITORY must be an exact owner\/name repository\./);
  assert.doesNotMatch(result.stderr, /not\/a\/repo|release artifact directory|gh:|token-that-must-not-be-used|Error:/);
});

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env
    },
    timeout: 10_000
  });
}
