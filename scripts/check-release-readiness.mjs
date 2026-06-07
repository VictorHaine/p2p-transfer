#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DEFAULT_REPOSITORY = "VictorHaine/p2p-transfer";
const MAIN_RULESET_NAME = "p2p-transfer: protect main";
const TAG_RULESET_NAME = "p2p-transfer: protect release tags";
const NPM_ENVIRONMENT = "npm";
const REQUIRED_OAUTH_SCOPES = ["repo", "workflow"];

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
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN before running release preflight.");

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
  const options = { repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Repository must be owner/name.");
      options.repository = value;
    } else {
      throw new Error("Usage: node scripts/check-release-readiness.mjs [--repo owner/name]");
    }
  }
  return options;
}

function readinessErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release readiness check failed with an internal error.";
  }
  return error.message;
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
