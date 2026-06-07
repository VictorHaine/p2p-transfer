import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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

test("npm bootstrap script rejects unsupported arguments before token or publish work", () => {
  const result = runScript("scripts/bootstrap-npm-package.mjs", {
    NPM_BOOTSTRAP_TOKEN: "token-that-must-not-be-used"
  }, ["--apply", "--extra"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /npm bootstrap failed:\n- Usage: node scripts\/bootstrap-npm-package\.mjs \[--dry-run\|--apply\]/);
  assert.doesNotMatch(result.stderr, /token-that-must-not-be-used|npm registry|publish|Error:/);
});

test("GitHub release controls reject read-only npm reviewers before mutating environments", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-controls-"));
  const mock = path.join(tmp, "mock-github-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_GITHUB_LOG;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const method = init.method ?? "GET";
  const target = method + " " + parsed.pathname + parsed.search;
  appendFileSync(log, target + "\\n", "utf8");
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (parsed.origin !== "https://api.github.com") return json(500, {});
  if (target === "GET /user") return json(200, { login: "operator" });
  if (target === "GET /repos/VictorHaine/p2p-transfer") return json(200, { id: 1 });
  if (target === "GET /repos/VictorHaine/p2p-transfer/collaborators/read-only/permission") return json(200, { permission: "read", user: { login: "read-only" } });
  return json(500, {});
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/configure-github-release-controls.mjs",
      {
        FF_MOCK_GITHUB_LOG: log,
        GITHUB_TOKEN: "token-that-must-not-be-printed"
      },
      ["--dry-run", "--allow-missing-main", "--npm-reviewer", "read-only"],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8");

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /GitHub release control setup failed:\n- Npm environment reviewer must have write, maintain, or admin repository permission\./);
    assert.doesNotMatch(result.stderr, /token-that-must-not-be-printed|read-only|Error:|api\.github/);
    assert.match(requests, /^GET \/user\nGET \/repos\/VictorHaine\/p2p-transfer\nGET \/repos\/VictorHaine\/p2p-transfer\/collaborators\/read-only\/permission\n$/);
    assert.doesNotMatch(requests, /environments\/npm|rulesets|\/users\/read-only/);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

test("GitHub release controls apply environment and rulesets after reviewer validation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-controls-"));
  const mock = path.join(tmp, "mock-github-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_GITHUB_LOG;

function record(method, path, body) {
  appendFileSync(log, JSON.stringify({ method, path, body }) + "\\n", "utf8");
}

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const method = init.method ?? "GET";
  const path = parsed.pathname + parsed.search;
  const body = init.body === undefined ? undefined : JSON.parse(init.body);
  record(method, path, body);
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (parsed.origin !== "https://api.github.com") return json(500, {});
  if (method === "GET" && path === "/user") return json(200, { login: "operator" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer") return json(200, { id: 1 });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/collaborators/approver/permission") return json(200, { permission: "write", user: { login: "approver" } });
  if (method === "GET" && path === "/users/approver") return json(200, { id: 42, login: "approver" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm") return json(200, {
    can_admins_bypass: true,
    protection_rules: [],
    deployment_branch_policy: null
  });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets?includes_parents=false") return json(200, []);
  if (method === "PUT" && path === "/repos/VictorHaine/p2p-transfer/environments/npm") return json(200, {
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: "approver" } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies?per_page=100") return json(200, { total_count: 0, branch_policies: [] });
  if (method === "POST" && path === "/repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies") return json(201, { id: 77, name: "v*.*.*", type: "tag" });
  if (method === "POST" && path === "/repos/VictorHaine/p2p-transfer/rulesets") return json(201, { id: 88 });
  return json(500, {});
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/configure-github-release-controls.mjs",
      {
        FF_MOCK_GITHUB_LOG: log,
        GITHUB_TOKEN: "token-that-must-not-be-printed"
      },
      ["--apply", "--allow-missing-main", "--npm-reviewer", "approver"],
      ["--import", mock]
    );
    const requests = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; path: string; body?: unknown });
    const stdout = JSON.parse(result.stdout) as { mode: string; rulesets: string[] };
    const requestTargets = requests.map((request) => `${request.method} ${request.path}`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(stdout.mode, "applied");
    assert.deepEqual(stdout.rulesets, ["p2p-transfer: protect main", "p2p-transfer: protect release tags"]);
    assert.deepEqual(requestTargets, [
      "GET /user",
      "GET /repos/VictorHaine/p2p-transfer",
      "GET /repos/VictorHaine/p2p-transfer/collaborators/approver/permission",
      "GET /users/approver",
      "GET /repos/VictorHaine/p2p-transfer/environments/npm",
      "GET /repos/VictorHaine/p2p-transfer/rulesets?includes_parents=false",
      "PUT /repos/VictorHaine/p2p-transfer/environments/npm",
      "GET /repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies?per_page=100",
      "POST /repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies",
      "POST /repos/VictorHaine/p2p-transfer/rulesets",
      "POST /repos/VictorHaine/p2p-transfer/rulesets"
    ]);
    assert.equal(requests.length, 11);
    const environmentPut = requests[6];
    const deploymentPolicyPost = requests[8];
    assert.ok(environmentPut);
    assert.ok(deploymentPolicyPost);
    assert.deepEqual(environmentPut.body, {
      wait_timer: 0,
      can_admins_bypass: false,
      prevent_self_review: true,
      reviewers: [{ type: "User", id: 42 }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    });
    assert.deepEqual(deploymentPolicyPost.body, { name: "v*.*.*", type: "tag" });
    assert.doesNotMatch(result.stdout, /token-that-must-not-be-printed/);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

function runScript(script: string, env: Record<string, string>, args: string[] = []) {
  return runScriptWithNodeArgs(script, env, args, []);
}

function runScriptWithNodeArgs(script: string, env: Record<string, string>, args: string[] = [], nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env
    },
    timeout: 10_000
  });
}
