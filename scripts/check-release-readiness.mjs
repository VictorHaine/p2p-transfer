#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DEFAULT_REPOSITORY = "VictorHaine/p2p-transfer";
const MAIN_RULESET_NAME = "p2p-transfer: protect main";
const TAG_RULESET_NAME = "p2p-transfer: protect release tags";
const NPM_ENVIRONMENT = "npm";
const REQUIRED_OAUTH_SCOPES = ["repo", "workflow"];
const MAX_ENV_VALUE_BYTES = 4_096;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class GitHubApiError extends Error {
  constructor(status, data) {
    super(githubApiErrorMessage(status, data));
    this.status = status;
  }
}

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Release readiness check failed:");
    console.error(`- ${readinessErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = githubToken();

  const auth = await githubWithHeaders(token, "GET", "/user");
  assertOAuthScopes(auth.headers.get("x-oauth-scopes") ?? "");
  await github(token, "GET", `/repos/${options.repository}`);
  await github(token, "GET", `/repos/${options.repository}/branches/main`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error("Remote main branch is missing. Push main before releasing.");
    throw error;
  });

  const rulesets = await github(token, "GET", `/repos/${options.repository}/rulesets?includes_parents=false`);
  assertRequiredRuleset(rulesets, MAIN_RULESET_NAME, "branch");
  assertRequiredRuleset(rulesets, TAG_RULESET_NAME, "tag");

  const environment = await github(token, "GET", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error("GitHub npm environment is missing.");
    throw error;
  });
  if (!Array.isArray(environment?.protection_rules) || environment.protection_rules.length < 1) {
    throw new Error("GitHub npm environment has no protection rules.");
  }

  console.log(JSON.stringify({ repository: options.repository, ok: true }, null, 2));
}

function assertOAuthScopes(rawScopes) {
  const scopes = new Set(
    rawScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
  );
  for (const scope of REQUIRED_OAUTH_SCOPES) {
    if (!scopes.has(scope)) throw new Error(`GitHub token is missing ${scope} scope.`);
  }
}

function assertRequiredRuleset(rulesets, name, target) {
  if (!Array.isArray(rulesets)) throw new Error("GitHub rulesets response was invalid.");
  const ruleset = rulesets.find((candidate) => candidate?.name === name);
  if (!ruleset) throw new Error(`GitHub ruleset is missing: ${name}.`);
  if (ruleset.target !== target || ruleset.enforcement !== "active") throw new Error(`GitHub ruleset is not active for ${target}: ${name}.`);
}

async function github(token, method, path, body) {
  return (await githubWithHeaders(token, method, path, body)).data;
}

async function githubWithHeaders(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) throw new GitHubApiError(response.status, data);
  return { data, headers: response.headers };
}

function githubApiErrorMessage(status, data) {
  if (data && typeof data === "object" && typeof data.message === "string" && data.message.length > 0 && data.message.length < 256) {
    return `GitHub API returned ${status}: ${data.message}`;
  }
  return `GitHub API returned ${status}.`;
}

function parseArgs(args) {
  const options = { repository: repositoryInput(envString("GITHUB_REPOSITORY") || DEFAULT_REPOSITORY) };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[++index];
      options.repository = repositoryInput(value);
    } else {
      throw new Error("Usage: node scripts/check-release-readiness.mjs [--repo owner/name]");
    }
  }
  return options;
}

function githubToken() {
  const token = envString("GITHUB_TOKEN") || envString("GH_TOKEN");
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN before running release preflight.");
  return token;
}

function repositoryInput(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) throw new Error("Repository must be owner/name.");
  return value;
}

function envString(name) {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === "") return undefined;
  if (typeof descriptor.value !== "string" || hasUnsafeEnvText(descriptor.value) || utf8ByteLengthExceeds(descriptor.value, MAX_ENV_VALUE_BYTES)) {
    throw new Error(`${name} must be a non-empty control-free string under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return descriptor.value;
}

function hasUnsafeEnvText(value) {
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value);
}

function readinessErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release readiness check failed with an internal error.";
  }
  return error.message;
}

function utf8ByteLengthExceeds(value, maxBytes) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
