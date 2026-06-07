#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DEFAULT_REPOSITORY = "VictorHaine/p2p-transfer";
const MAIN_RULESET_NAME = "p2p-transfer: protect main";
const TAG_RULESET_NAME = "p2p-transfer: protect release tags";
const NPM_ENVIRONMENT = "npm";
const REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID = 5;
const REQUIRED_OAUTH_SCOPES = ["repo", "workflow"];
const REQUIRED_CI_CHECKS = [
  "verify",
  "browser interop",
  "dependency review",
  "production docker policy",
  "platform smoke / ubuntu-24.04 / node 22.22.3",
  "platform smoke / ubuntu-24.04 / node 24.13.1",
  "platform smoke / macos-15 / node 22.22.3",
  "platform smoke / macos-15 / node 24.13.1",
  "platform smoke / windows-2025 / node 22.22.3",
  "platform smoke / windows-2025 / node 24.13.1"
];
const MAX_ENV_VALUE_BYTES = 4_096;
const MAX_GITHUB_API_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
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
  assertTokenScopes(auth.headers);
  await github(token, "GET", `/repos/${options.repository}`);
  await github(token, "GET", `/repos/${options.repository}/branches/main`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error("Remote main branch is missing. Push main before releasing.");
    throw error;
  });

  const rulesets = await github(token, "GET", `/repos/${options.repository}/rulesets?includes_parents=false`);
  const mainRuleset = assertRequiredRuleset(rulesets, MAIN_RULESET_NAME, "branch");
  const tagRuleset = assertRequiredRuleset(rulesets, TAG_RULESET_NAME, "tag");
  assertMainRuleset(await rulesetDetails(token, options.repository, mainRuleset.id));
  assertTagRuleset(await rulesetDetails(token, options.repository, tagRuleset.id));

  const environment = await github(token, "GET", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error("GitHub npm environment is missing.");
    throw error;
  });
  assertNpmEnvironment(environment);

  console.log(JSON.stringify({ repository: options.repository, ok: true }, null, 2));
}

function assertTokenScopes(headers) {
  const rawScopes = headers.get("x-oauth-scopes") ?? "";
  if (rawScopes === "" && envString("GITHUB_ACTIONS") === "true") return;
  assertOAuthScopes(rawScopes);
}

function assertOAuthScopes(rawScopes) {
  const scopes = new Set(
    rawScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
  );
  for (const scope of REQUIRED_OAUTH_SCOPES) {
    if (!scopes.has(scope)) {
      const refresh = scope === "workflow" ? " Run `gh auth refresh -h github.com -s workflow`, then rerun release preflight." : "";
      throw new Error(`GitHub token is missing ${scope} scope.${refresh}`);
    }
  }
}

function assertNpmEnvironment(environment) {
  if (!Array.isArray(environment?.protection_rules) || environment.protection_rules.length < 1) {
    throw new Error("GitHub npm environment has no protection rules.");
  }
  const requiredReviewers = environment.protection_rules.find((rule) => rule?.type === "required_reviewers");
  if (!requiredReviewers) throw new Error("GitHub npm environment has no required reviewers protection rule.");
  if (requiredReviewers.prevent_self_review !== true) throw new Error("GitHub npm environment must prevent self-review.");
  if (!Array.isArray(requiredReviewers.reviewers) || requiredReviewers.reviewers.length < 1) {
    throw new Error("GitHub npm environment required reviewers rule has no reviewers.");
  }
}

function assertRequiredRuleset(rulesets, name, target) {
  if (!Array.isArray(rulesets)) throw new Error("GitHub rulesets response was invalid.");
  const ruleset = rulesets.find((candidate) => candidate?.name === name);
  if (!ruleset) throw new Error(`GitHub ruleset is missing: ${name}.`);
  if (ruleset.target !== target || ruleset.enforcement !== "active") throw new Error(`GitHub ruleset is not active for ${target}: ${name}.`);
  if (typeof ruleset.id !== "number") throw new Error(`GitHub ruleset response is missing id: ${name}.`);
  return ruleset;
}

async function rulesetDetails(token, repository, id) {
  return github(token, "GET", `/repos/${repository}/rulesets/${id}`);
}

function assertMainRuleset(ruleset) {
  assertRulesetBase(ruleset, MAIN_RULESET_NAME, "branch", "refs/heads/main");
  assertNoBypassActors(ruleset, MAIN_RULESET_NAME);
  const rules = rulesByType(ruleset, MAIN_RULESET_NAME, ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
  assertRulePresent(rules, "deletion", MAIN_RULESET_NAME);
  assertRulePresent(rules, "non_fast_forward", MAIN_RULESET_NAME);
  const pullRequest = assertRulePresent(rules, "pull_request", MAIN_RULESET_NAME);
  const pullRequestParameters = parameters(pullRequest, MAIN_RULESET_NAME, "pull_request");
  assertArrayIncludesExactly(pullRequestParameters.allowed_merge_methods, ["squash", "rebase"], `${MAIN_RULESET_NAME} pull request allowed merge methods`);
  assertBoolean(pullRequestParameters.dismiss_stale_reviews_on_push, true, `${MAIN_RULESET_NAME} stale review dismissal`);
  assertBoolean(pullRequestParameters.require_code_owner_review, true, `${MAIN_RULESET_NAME} code owner review`);
  assertBoolean(pullRequestParameters.require_last_push_approval, true, `${MAIN_RULESET_NAME} last push approval`);
  assertBoolean(pullRequestParameters.required_review_thread_resolution, true, `${MAIN_RULESET_NAME} review thread resolution`);
  if (pullRequestParameters.required_approving_review_count !== 1) throw new Error(`${MAIN_RULESET_NAME} approving review count is not enforced.`);
  const statusChecks = assertRulePresent(rules, "required_status_checks", MAIN_RULESET_NAME);
  const statusParameters = parameters(statusChecks, MAIN_RULESET_NAME, "required_status_checks");
  assertBoolean(statusParameters.strict_required_status_checks_policy, true, `${MAIN_RULESET_NAME} strict status checks`);
  assertStatusContexts(statusParameters.required_status_checks, REQUIRED_CI_CHECKS, MAIN_RULESET_NAME);
}

function assertTagRuleset(ruleset) {
  assertRulesetBase(ruleset, TAG_RULESET_NAME, "tag", "refs/tags/v*");
  const rules = rulesByType(ruleset, TAG_RULESET_NAME, ["creation", "deletion", "non_fast_forward"]);
  assertRulePresent(rules, "creation", TAG_RULESET_NAME);
  assertRulePresent(rules, "deletion", TAG_RULESET_NAME);
  assertRulePresent(rules, "non_fast_forward", TAG_RULESET_NAME);
  assertTagBypassActors(ruleset, TAG_RULESET_NAME);
}

function assertRulesetBase(ruleset, name, target, refName) {
  if (!ruleset || typeof ruleset !== "object") throw new Error(`GitHub ruleset details are invalid: ${name}.`);
  if (ruleset.name !== name || ruleset.target !== target || ruleset.enforcement !== "active") throw new Error(`GitHub ruleset details are not active for ${target}: ${name}.`);
  const refConditions = ruleset.conditions?.ref_name;
  const includes = refConditions?.include;
  if (!Array.isArray(includes) || includes.length !== 1 || includes[0] !== refName) throw new Error(`GitHub ruleset ref coverage is not exact for ${refName}: ${name}.`);
  const excludes = refConditions?.exclude;
  if (!Array.isArray(excludes) || excludes.length !== 0) throw new Error(`GitHub ruleset has ref exclusions: ${name}.`);
}

function assertNoBypassActors(ruleset, name) {
  if (!Array.isArray(ruleset?.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    throw new Error(`${name} must not allow bypass actors.`);
  }
}

function assertTagBypassActors(ruleset, name) {
  const bypass = ruleset?.bypass_actors;
  if (!Array.isArray(bypass) || bypass.length !== 1) throw new Error(`${name} bypass policy is not exact.`);
  const actor = bypass[0];
  if (actor?.actor_type !== "RepositoryRole" || actor?.actor_id !== REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID || actor?.bypass_mode !== "always") {
    throw new Error(`${name} admin bypass policy is not configured.`);
  }
}

function rulesByType(ruleset, name, expectedTypes) {
  if (!Array.isArray(ruleset?.rules)) throw new Error(`GitHub ruleset has no rules: ${ruleset?.name ?? "unknown"}.`);
  if (ruleset.rules.length !== expectedTypes.length) throw new Error(`${name} rules are not exact.`);
  const expected = new Set(expectedTypes);
  const rules = new Map();
  for (const rule of ruleset.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.type !== "string" || !expected.has(rule.type) || rules.has(rule.type)) {
      throw new Error(`${name} rules are not exact.`);
    }
    rules.set(rule.type, rule);
  }
  return rules;
}

function assertRulePresent(rules, type, name) {
  const rule = rules.get(type);
  if (!rule) throw new Error(`${name} is missing ${type} rule.`);
  return rule;
}

function parameters(rule, name, type) {
  if (!rule.parameters || typeof rule.parameters !== "object") throw new Error(`${name} ${type} rule parameters are invalid.`);
  return rule.parameters;
}

function assertArrayIncludesExactly(actual, expected, description) {
  if (!Array.isArray(actual) || actual.length !== expected.length || !expected.every((value) => actual.includes(value))) {
    throw new Error(`${description} are not enforced.`);
  }
}

function assertBoolean(actual, expected, description) {
  if (actual !== expected) throw new Error(`${description} is not enforced.`);
}

function assertStatusContexts(actual, expected, name) {
  if (!Array.isArray(actual)) throw new Error(`${name} required status checks are invalid.`);
  const contexts = actual.map((entry) => entry?.context).filter((context) => typeof context === "string");
  assertArrayIncludesExactly(contexts, expected, `${name} required status checks`);
}

async function github(token, method, path, body) {
  return (await githubWithHeaders(token, method, path, body)).data;
}

async function githubWithHeaders(token, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error("GitHub API request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await githubJson(response);
  if (!response.ok) throw new GitHubApiError(response.status, data);
  return { data, headers: response.headers };
}

async function githubJson(response) {
  const text = await boundedGithubResponseText(response);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub API response was not valid JSON.");
  }
}

async function boundedGithubResponseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("GitHub API response body was invalid.");
      total += value.byteLength;
      if (total > MAX_GITHUB_API_RESPONSE_BYTES) throw new Error("GitHub API response exceeded the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Keep the original GitHub API failure; lock release is best-effort cleanup.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("GitHub API response was not valid UTF-8.");
  }
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
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
