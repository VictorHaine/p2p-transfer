import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_RELEASE_CHECKS = [
  "verify",
  "browser interop",
  "codeql analyze",
  "dependency review",
  "production docker policy",
  "platform smoke / ubuntu-24.04 / node 22.22.3",
  "platform smoke / ubuntu-24.04 / node 24.13.1",
  "platform smoke / macos-15 / node 22.22.3",
  "platform smoke / macos-15 / node 24.13.1",
  "platform smoke / windows-2025 / node 22.22.3",
  "platform smoke / windows-2025 / node 24.13.1"
];
const RELEASE_TEST_SHA = "0123456789abcdef0123456789abcdef01234567";

test("release publish script rejects static npm tokens before artifact work", () => {
  const result = runScript("scripts/publish-release-artifact.mjs", {
    NODE_AUTH_TOKEN: "static-token-that-must-not-publish",
    ...releaseTagEnv("v0.1.0")
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release publish failed:\n- NODE_AUTH_TOKEN must not be present for trusted publishing\./);
  assert.doesNotMatch(result.stderr, /release artifact directory|static-token|Error:/);
});

test("GitHub release script rejects malformed tags before artifact or GitHub API work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    GITHUB_REF_NAME: "bad-tag",
    GITHUB_REPOSITORY: "VictorHaine/p2p-transfer",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GITHUB_REF_NAME must be an exact release tag\./);
  assert.doesNotMatch(result.stderr, /bad-tag|release artifact directory|api\.github|token-that-must-not-be-used|Error:/);
});

test("release publish script rejects control-bearing env before artifact work", () => {
  const result = runScript("scripts/publish-release-artifact.mjs", {
    GITHUB_REF_NAME: "v0.1.0\nwith-control"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release publish failed:\n- GITHUB_REF_NAME must be a non-empty control-free environment value under 8192 UTF-8 bytes\./);
  assert.doesNotMatch(result.stderr, /with-control|release artifact directory|pnpm publish|Error:/);
});

test("GitHub release script rejects control-bearing env before artifact or GitHub API work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    GITHUB_REF_NAME: "v0.1.0\nwith-control",
    GITHUB_REPOSITORY: "VictorHaine/p2p-transfer",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GITHUB_REF_NAME must be a non-empty control-free environment value under 8192 UTF-8 bytes\./);
  assert.doesNotMatch(result.stderr, /with-control|release artifact directory|api\.github|token-that-must-not-be-used|Error:/);
});

test("GitHub release script rejects malformed repositories before artifact or GitHub API work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    ...releaseTagEnv("v0.1.0"),
    GITHUB_REPOSITORY: "not/a/repo/name",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GITHUB_REPOSITORY must be an exact owner\/name repository\./);
  assert.doesNotMatch(result.stderr, /not\/a\/repo|release artifact directory|api\.github|token-that-must-not-be-used|Error:/);
});

test("GitHub release script rejects branch refs before artifact or GitHub API work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    ...releaseTagEnv("v0.1.0"),
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF: "refs/heads/v0.1.0",
    GITHUB_REPOSITORY: "VictorHaine/p2p-transfer",
    GH_TOKEN: "token-that-must-not-be-used"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- release workflow ref must be the matching tag ref\./);
  assert.doesNotMatch(result.stderr, /refs\/heads|release artifact directory|api\.github|token-that-must-not-be-used|Error:/);
});

test("GitHub release script rejects control-bearing tokens before artifact or GitHub API work", () => {
  const result = runScript("scripts/create-github-release.mjs", {
    ...releaseTagEnv("v0.1.0"),
    GITHUB_REPOSITORY: "VictorHaine/p2p-transfer",
    GH_TOKEN: "token-that-must-not-be-used\nwith-control"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub Release creation failed:\n- GH_TOKEN must be a non-empty control-free environment value under 8192 UTF-8 bytes\./);
  assert.doesNotMatch(result.stderr, /with-control|release artifact directory|api\.github|token-that-must-not-be-used|Error:/);
});

test("GitHub release API verifies the tag and uploads exact release assets", async () => {
  const { createGitHubRelease } = await import(`../scripts/create-github-release.mjs?release-api=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const uploads: Array<{ name: string | null; body: string; type: string | null }> = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      const body = init.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : typeof init.body === "string" ? init.body : "";
      requests.push({ method, url: parsed.origin + parsed.pathname + parsed.search, body });
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (parsed.origin === "https://api.github.com" && method === "GET" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0") {
        return json(200, { ref: "refs/tags/v0.1.0", object: { type: "commit", sha: RELEASE_TEST_SHA } });
      }
      if (parsed.origin === "https://api.github.com" && method === "POST" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases") {
        assert.deepEqual(JSON.parse(body), { tag_name: "v0.1.0", name: "v0.1.0", body: "scoped release notes", draft: true, prerelease: false });
        return json(201, { id: 99, tag_name: "v0.1.0", draft: true, upload_url: "https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets{?name,label}" });
      }
      if (parsed.origin === "https://uploads.github.com" && method === "POST" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases/99/assets") {
        const headers = init.headers as Record<string, string> | Headers | undefined;
        const type = headers instanceof Headers ? headers.get("content-type") : headers?.["content-type"] ?? null;
        uploads.push({ name: parsed.searchParams.get("name"), body, type });
        return json(201, { name: parsed.searchParams.get("name") });
      }
      if (parsed.origin === "https://api.github.com" && method === "PATCH" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases/99") {
        assert.deepEqual(JSON.parse(body), { draft: false });
        return json(200, { id: 99, tag_name: "v0.1.0", draft: false });
      }
      return json(500, {});
    };

    await createGitHubRelease("token-that-must-not-be-printed", "VictorHaine/p2p-transfer", "v0.1.0", RELEASE_TEST_SHA, "scoped release notes", [
      { name: "p2p-transfer-0.1.0.tgz", bytes: Buffer.from("tarball-bytes") },
      { name: "SHA256SUMS", bytes: Buffer.from("checksum-bytes") },
      { name: "SBOM.cdx.json", bytes: Buffer.from("{}") }
    ]);

    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "GET https://api.github.com/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0",
      "POST https://api.github.com/repos/VictorHaine/p2p-transfer/releases",
      "POST https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets?name=p2p-transfer-0.1.0.tgz",
      "POST https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets?name=SHA256SUMS",
      "POST https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets?name=SBOM.cdx.json",
      "PATCH https://api.github.com/repos/VictorHaine/p2p-transfer/releases/99"
    ]);
    assert.deepEqual(uploads, [
      { name: "p2p-transfer-0.1.0.tgz", body: "tarball-bytes", type: "application/gzip" },
      { name: "SHA256SUMS", body: "checksum-bytes", type: "text/plain; charset=utf-8" },
      { name: "SBOM.cdx.json", body: "{}", type: "application/json" }
    ]);
    assert.doesNotMatch(JSON.stringify(requests), /token-that-must-not-be-printed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release API errors do not echo remote bodies or tokens", async () => {
  const { createGitHubRelease } = await import(`../scripts/create-github-release.mjs?release-api-error=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "remote body token-that-must-not-be-printed /tmp/private-path" }), {
        status: 422,
        headers: { "content-type": "application/json" }
      });

    await assert.rejects(
      createGitHubRelease("token-that-must-not-be-printed", "VictorHaine/p2p-transfer", "v0.1.0", RELEASE_TEST_SHA, "scoped release notes", [
        { name: "p2p-transfer-0.1.0.tgz", bytes: Buffer.from("tarball-bytes") },
        { name: "SHA256SUMS", bytes: Buffer.from("checksum-bytes") },
        { name: "SBOM.cdx.json", bytes: Buffer.from("{}") }
      ]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "GitHub API request failed with HTTP status 422.");
        assert.doesNotMatch(error.message, /token-that-must-not-be-printed|remote body|private-path/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release API rejects tags that no longer point at the workflow commit", async () => {
  const { createGitHubRelease } = await import(`../scripts/create-github-release.mjs?release-tag-sha=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      requests.push(`${method} ${parsed.origin}${parsed.pathname}${parsed.search}`);
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (parsed.origin === "https://api.github.com" && method === "GET" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0") {
        return json(200, { ref: "refs/tags/v0.1.0", object: { type: "commit", sha: "fedcba9876543210fedcba9876543210fedcba98" } });
      }
      return json(500, {});
    };

    await assert.rejects(
      createGitHubRelease("token-that-must-not-be-printed", "VictorHaine/p2p-transfer", "v0.1.0", RELEASE_TEST_SHA, "scoped release notes", [
        { name: "p2p-transfer-0.1.0.tgz", bytes: Buffer.from("tarball-bytes") },
        { name: "SHA256SUMS", bytes: Buffer.from("checksum-bytes") },
        { name: "SBOM.cdx.json", bytes: Buffer.from("{}") }
      ]),
      /GitHub tag ref does not match the release workflow commit\./
    );
    assert.deepEqual(requests, ["GET https://api.github.com/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release API rejects incomplete release asset sets before network", async () => {
  const { createGitHubRelease } = await import(`../scripts/create-github-release.mjs?release-assets=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  let fetched = false;
  try {
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 500 });
    };

    await assert.rejects(
      createGitHubRelease("token-that-must-not-be-printed", "VictorHaine/p2p-transfer", "v0.1.0", RELEASE_TEST_SHA, "scoped release notes", [
        { name: "p2p-transfer-0.1.0.tgz", bytes: Buffer.from("tarball-bytes") },
        { name: "p2p-transfer-0.1.0-copy.tgz", bytes: Buffer.from("tarball-copy") },
        { name: "SHA256SUMS", bytes: Buffer.from("checksum-bytes") }
      ]),
      /release assets are invalid\./
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release API deletes draft releases when asset upload fails", async () => {
  const { createGitHubRelease } = await import(`../scripts/create-github-release.mjs?release-cleanup=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      requests.push(`${method} ${parsed.origin}${parsed.pathname}${parsed.search}`);
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (parsed.origin === "https://api.github.com" && method === "GET" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0") {
        return json(200, { ref: "refs/tags/v0.1.0", object: { type: "commit", sha: RELEASE_TEST_SHA } });
      }
      if (parsed.origin === "https://api.github.com" && method === "POST" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases") {
        return json(201, { id: 99, tag_name: "v0.1.0", draft: true, upload_url: "https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets{?name,label}" });
      }
      if (parsed.origin === "https://uploads.github.com" && method === "POST" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases/99/assets") {
        return json(parsed.searchParams.get("name") === "SHA256SUMS" ? 500 : 201, { name: parsed.searchParams.get("name") });
      }
      if (parsed.origin === "https://api.github.com" && method === "DELETE" && parsed.pathname === "/repos/VictorHaine/p2p-transfer/releases/99") {
        return new Response("", { status: 204 });
      }
      return json(500, {});
    };

    await assert.rejects(
      createGitHubRelease("token-that-must-not-be-printed", "VictorHaine/p2p-transfer", "v0.1.0", RELEASE_TEST_SHA, "scoped release notes", [
        { name: "p2p-transfer-0.1.0.tgz", bytes: Buffer.from("tarball-bytes") },
        { name: "SHA256SUMS", bytes: Buffer.from("checksum-bytes") },
        { name: "SBOM.cdx.json", bytes: Buffer.from("{}") }
      ]),
      /GitHub API request failed with HTTP status 500\./
    );
    assert.deepEqual(requests, [
      "GET https://api.github.com/repos/VictorHaine/p2p-transfer/git/ref/tags/v0.1.0",
      "POST https://api.github.com/repos/VictorHaine/p2p-transfer/releases",
      "POST https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets?name=p2p-transfer-0.1.0.tgz",
      "POST https://uploads.github.com/repos/VictorHaine/p2p-transfer/releases/99/assets?name=SHA256SUMS",
      "DELETE https://api.github.com/repos/VictorHaine/p2p-transfer/releases/99"
    ]);
    assert.equal(requests.some((request) => request.startsWith("PATCH ")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("release publish script rejects branch refs before artifact work", () => {
  const result = runScript("scripts/publish-release-artifact.mjs", {
    ...releaseTagEnv("v0.1.0"),
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF: "refs/heads/v0.1.0"
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release publish failed:\n- release workflow ref must be the matching tag ref\./);
  assert.doesNotMatch(result.stderr, /refs\/heads|release artifact directory|pnpm publish|Error:/);
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

test("npm bootstrap script rejects control-bearing tokens before package, registry, npmrc, or publish work", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-npm-bootstrap-"));
  const mock = path.join(tmp, "mock-npm-bootstrap-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_NPM_BOOTSTRAP_LOG;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  appendFileSync(log, (init.method ?? "GET") + " " + parsed.origin + parsed.pathname + "\\n", "utf8");
  if (parsed.origin === "https://registry.npmjs.org" && parsed.pathname === "/%40victorhaine%2Fp2p-transfer") {
    return new Response(JSON.stringify({ message: "missing package" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ message: "unexpected route" }), { status: 500, headers: { "content-type": "application/json" } });
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/bootstrap-npm-package.mjs",
      {
        FF_MOCK_NPM_BOOTSTRAP_LOG: log,
        NPM_BOOTSTRAP_TOKEN: "token-that-must-not-be-used\nregistry=https://evil.example"
      },
      ["--apply"],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /npm bootstrap failed:\n- NPM_BOOTSTRAP_TOKEN must be a non-empty control-free environment value under 8192 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /token-that-must-not-be-used|evil\.example|publish|Error:/);
    assert.equal(requests, "");
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
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

test("GitHub release controls do not apply with the missing-main bypass", () => {
  const result = runScript(
    "scripts/configure-github-release-controls.mjs",
    {
      GITHUB_TOKEN: "token-that-must-not-be-printed"
    },
    ["--apply", "--allow-missing-main"]
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub release control setup failed:\n- --allow-missing-main is only allowed with --dry-run\./);
  assert.doesNotMatch(result.stderr, /token-that-must-not-be-printed|Error:|api\.github/);
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
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/branches/main") return json(200, { name: "main" });
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
      ["--apply", "--npm-reviewer", "approver"],
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
      "GET /repos/VictorHaine/p2p-transfer/branches/main",
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
    assert.equal(requests.length, 12);
    const environmentPut = requests[7];
    const deploymentPolicyPost = requests[9];
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

test("GitHub release controls reject unexpected existing rulesets before applying", async () => {
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
  const path = parsed.pathname + parsed.search;
  appendFileSync(log, method + " " + path + "\\n", "utf8");
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (parsed.origin !== "https://api.github.com") return json(500, {});
  if (method === "GET" && path === "/user") return json(200, { login: "operator" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer") return json(200, { id: 1 });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/branches/main") return json(200, { name: "main" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm") return json(200, {
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: "approver" } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets?includes_parents=false") return json(200, [
    { id: 101, name: "p2p-transfer: protect main", target: "branch" },
    { id: 202, name: "unexpected legacy tag rule", target: "tag" }
  ]);
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
      ["--apply"],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8");

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /GitHub release control setup failed:\n- GitHub rulesets response contained an unexpected ruleset\./);
    assert.doesNotMatch(result.stderr, /unexpected legacy tag rule|token-that-must-not-be-printed|Error:/);
    assert.doesNotMatch(requests, /^PUT |^POST /m);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

test("release preflight aggregates remote failures without leaking API bodies", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-preflight-"));
  const mock = path.join(tmp, "mock-release-preflight-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_PREFLIGHT_LOG;

function record(method, origin, path) {
  appendFileSync(log, method + " " + origin + path + "\\n", "utf8");
}

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const method = init.method ?? "GET";
  const path = parsed.pathname + parsed.search;
  record(method, parsed.origin, path);
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (parsed.origin === "https://registry.npmjs.org" && method === "GET" && path === "/%40victorhaine%2Fp2p-transfer") {
    return json(404, { message: "raw npm package name must not be echoed" });
  }
  if (parsed.origin !== "https://api.github.com") return json(500, { message: "unexpected origin" });
  if (method === "GET" && path === "/user") return json(200, { login: "operator" }, { "x-oauth-scopes": "repo" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer") return json(200, { id: 1 });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/branches/main") return json(404, { message: "raw main branch API body" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/actions/secrets/RELEASE_PREFLIGHT_TOKEN") return json(404, { message: "raw secret API body" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets?includes_parents=false") return json(200, []);
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm") return json(200, {
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies?per_page=100") return json(200, { total_count: 0, branch_policies: [] });
  return json(500, { message: "unexpected mock route" });
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/check-release-readiness.mjs",
      {
        FF_MOCK_PREFLIGHT_LOG: log,
        GITHUB_TOKEN: "token-that-must-not-be-printed"
      },
      [],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8");

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release readiness check failed:/);
    assert.match(result.stderr, /npm package is missing; bootstrap a lower throwaway version before trusted publishing\./);
    assert.match(result.stderr, /GitHub token is missing workflow scope\. Run `gh auth refresh -h github\.com -s workflow`, then rerun release preflight\./);
    assert.match(result.stderr, /Remote main branch is missing\. Push main before releasing\./);
    assert.match(result.stderr, /GitHub Actions secret RELEASE_PREFLIGHT_TOKEN is missing\./);
    assert.match(result.stderr, /GitHub rulesets response contained unexpected or missing rulesets\./);
    assert.match(result.stderr, /GitHub npm environment required reviewers rule has no reviewers\./);
    assert.match(result.stderr, /GitHub npm environment deployment policy is not exact\./);
    assert.doesNotMatch(result.stderr, /token-that-must-not-be-printed|raw npm package name|raw main branch|raw secret|unexpected mock route|api\.github|registry\.npmjs|Error:/);
    assert.match(requests, /^GET https:\/\/registry\.npmjs\.org\/%40victorhaine%2Fp2p-transfer\nGET https:\/\/api\.github\.com\/user\n/);
    assert.match(requests, /GET https:\/\/api\.github\.com\/repos\/VictorHaine\/p2p-transfer\/actions\/secrets\/RELEASE_PREFLIGHT_TOKEN\n/);
    assert.match(requests, /GET https:\/\/api\.github\.com\/repos\/VictorHaine\/p2p-transfer\/environments\/npm\/deployment-branch-policies\?per_page=100\n/);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

test("release preflight rejects control-bearing GitHub tokens before package or network work", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-preflight-token-"));
  const mock = path.join(tmp, "mock-release-preflight-token-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_PREFLIGHT_TOKEN_LOG;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  appendFileSync(log, (init.method ?? "GET") + " " + parsed.origin + parsed.pathname + "\\n", "utf8");
  return new Response(JSON.stringify({ message: "unexpected network" }), { status: 500, headers: { "content-type": "application/json" } });
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/check-release-readiness.mjs",
      {
        FF_MOCK_PREFLIGHT_TOKEN_LOG: log,
        GITHUB_TOKEN: "token-that-must-not-be-used\nworkflow=true"
      },
      [],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release readiness check failed:\n- GITHUB_TOKEN must be a non-empty control-free string under 4096 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /token-that-must-not-be-used|workflow=true|unexpected network|api\.github|registry\.npmjs|Error:/);
    assert.equal(requests, "");
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

test("release preflight rejects control-bearing GitHub Actions mode before package or network work", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-preflight-actions-"));
  const mock = path.join(tmp, "mock-release-preflight-actions-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_PREFLIGHT_ACTIONS_LOG;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  appendFileSync(log, (init.method ?? "GET") + " " + parsed.origin + parsed.pathname + "\\n", "utf8");
  return new Response(JSON.stringify({ message: "unexpected network" }), { status: 500, headers: { "content-type": "application/json" } });
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/check-release-readiness.mjs",
      {
        FF_MOCK_PREFLIGHT_ACTIONS_LOG: log,
        GITHUB_ACTIONS: "true\nwith-control",
        GITHUB_TOKEN: "token-that-must-not-be-used"
      },
      [],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release readiness check failed:\n- GITHUB_ACTIONS must be a non-empty control-free string under 4096 UTF-8 bytes\./);
    assert.doesNotMatch(result.stderr, /token-that-must-not-be-used|with-control|unexpected network|api\.github|registry\.npmjs|Error:/);
    assert.equal(requests, "");
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
});

test("release workflow preflight verifies the full remote gate with a repo-scoped token", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-release-preflight-"));
  const mock = path.join(tmp, "mock-release-preflight-fetch.mjs");
  const log = path.join(tmp, "requests.log");
  try {
    await fs.writeFile(
      mock,
      `
import { appendFileSync } from "node:fs";

const log = process.env.FF_MOCK_PREFLIGHT_LOG;
const requiredChecks = ${JSON.stringify(REQUIRED_RELEASE_CHECKS)};
const tagRulesetRef = process.env.FF_MOCK_TAG_RULESET_REF ?? "refs/tags/v*.*.*";

function record(method, origin, path) {
  appendFileSync(log, method + " " + origin + path + "\\n", "utf8");
}

function mainRuleset() {
  return {
    id: 101,
    name: "p2p-transfer: protect main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash", "rebase"],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true
        }
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: requiredChecks.map((context) => ({ context, integration_id: 15368 }))
        }
      }
    ]
  };
}

function tagRuleset() {
  return {
    id: 202,
    name: "p2p-transfer: protect release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
    conditions: { ref_name: { include: [tagRulesetRef], exclude: [] } },
    rules: [{ type: "creation" }, { type: "deletion" }, { type: "non_fast_forward" }]
  };
}

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const method = init.method ?? "GET";
  const path = parsed.pathname + parsed.search;
  record(method, parsed.origin, path);
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (parsed.origin === "https://registry.npmjs.org" && method === "GET" && path === "/%40victorhaine%2Fp2p-transfer") return json(200, { versions: { "0.0.0-bootstrap.0": {} } });
  if (parsed.origin !== "https://api.github.com") return json(500, {});
  if (method === "GET" && path === "/user") return json(200, { login: "operator" }, { "x-oauth-scopes": "repo" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer") return json(200, { id: 1 });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/branches/main") return json(200, { name: "main" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/actions/secrets/RELEASE_PREFLIGHT_TOKEN") return json(200, { name: "RELEASE_PREFLIGHT_TOKEN", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets?includes_parents=false") return json(200, [
    { id: 101, name: "p2p-transfer: protect main", target: "branch", enforcement: "active" },
    { id: 202, name: "p2p-transfer: protect release tags", target: "tag", enforcement: "active" }
  ]);
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets/101") return json(200, mainRuleset());
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/rulesets/202") return json(200, tagRuleset());
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm") return json(200, {
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: "approver" } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  });
  if (method === "GET" && path === "/repos/VictorHaine/p2p-transfer/environments/npm/deployment-branch-policies?per_page=100") return json(200, { total_count: 1, branch_policies: [{ id: 77, name: "v*.*.*", type: "tag" }] });
  return json(500, {});
};
`,
      "utf8"
    );

    const result = runScriptWithNodeArgs(
      "scripts/check-release-readiness.mjs",
      {
        FF_MOCK_PREFLIGHT_LOG: log,
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "token-that-must-not-be-printed"
      },
      [],
      ["--import", mock]
    );
    const requests = await fs.readFile(log, "utf8");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { repository: "VictorHaine/p2p-transfer", ok: true });
    assert.doesNotMatch(result.stdout, /token-that-must-not-be-printed|approver|RELEASE_PREFLIGHT_TOKEN|0\.0\.0-bootstrap/);
    assert.match(requests, /^GET https:\/\/registry\.npmjs\.org\/%40victorhaine%2Fp2p-transfer\nGET https:\/\/api\.github\.com\/user\n/);
    assert.match(requests, /GET https:\/\/api\.github\.com\/repos\/VictorHaine\/p2p-transfer\/rulesets\/101\n/);
    assert.match(requests, /GET https:\/\/api\.github\.com\/repos\/VictorHaine\/p2p-transfer\/rulesets\/202\n/);
    assert.match(requests, /GET https:\/\/api\.github\.com\/repos\/VictorHaine\/p2p-transfer\/environments\/npm\/deployment-branch-policies\?per_page=100\n$/);

    const broadTagRulesetResult = runScriptWithNodeArgs(
      "scripts/check-release-readiness.mjs",
      {
        FF_MOCK_PREFLIGHT_LOG: log,
        FF_MOCK_TAG_RULESET_REF: "refs/tags/v*",
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "token-that-must-not-be-printed"
      },
      [],
      ["--import", mock]
    );
    assert.notEqual(broadTagRulesetResult.status, 0);
    assert.equal(broadTagRulesetResult.stdout, "");
    assert.match(
      broadTagRulesetResult.stderr,
      /GitHub ruleset ref coverage is not exact for refs\/tags\/v\*\.\*\.\*: p2p-transfer: protect release tags\./
    );
    assert.doesNotMatch(broadTagRulesetResult.stderr, /token-that-must-not-be-printed|refs\/tags\/v\*[^.]/);
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

function releaseTagEnv(tag: string): Record<string, string> {
  return { GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: RELEASE_TEST_SHA };
}
