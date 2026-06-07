#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DEFAULT_REPOSITORY = "VictorHaine/p2p-transfer";
const MAIN_RULESET_NAME = "p2p-transfer: protect main";
const TAG_RULESET_NAME = "p2p-transfer: protect release tags";
const NPM_ENVIRONMENT = "npm";
const REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID = 5;
const MAX_NPM_ENVIRONMENT_REVIEWERS = 6;
const MAX_ENV_VALUE_BYTES = 4_096;
const MAX_GITHUB_API_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const REQUIRED_CI_CHECKS = [
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

class GitHubApiError extends Error {
  constructor(status) {
    super(githubApiErrorMessage(status));
    this.status = status;
  }
}

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("GitHub release control setup failed:");
    console.error(`- ${setupErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = githubToken();
  const authenticatedLogin = requiredAuthenticatedLogin(await github(token, "GET", "/user"));

  const repo = await github(token, "GET", `/repos/${options.repository}`);
  if (!repo || typeof repo.id !== "number") throw new Error("GitHub repository response was invalid.");
  if (options.requireMain) await requireRemoteMain(token, options.repository);

  const desired = [mainRuleset(), tagRuleset()];
  assertNoSelfReviewDeadlock(options.npmReviewers, authenticatedLogin);
  const desiredEnvironment = options.npmReviewers.length > 0 ? await npmEnvironmentConfig(token, options) : undefined;
  let environment = await github(token, "GET", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  });
  const existingRulesets = await github(token, "GET", `/repos/${options.repository}/rulesets?includes_parents=false`);
  const existingByName = existingRulesetsByName(existingRulesets);

  if (!options.apply) {
    console.log(JSON.stringify({ repository: options.repository, mode: "dry-run", rulesets: desired, environment: environmentStatus(environment), desiredEnvironment }, null, 2));
    return;
  }

  if (desiredEnvironment) {
    environment = await github(token, "PUT", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}`, desiredEnvironment);
  }
  if (!environment) throw new Error("Create the npm environment before applying release controls.");
  const status = environmentStatus(environment);
  if (!status.hasRequiredReviewers) {
    throw new Error("The npm environment exists but has no required reviewers protection rule.");
  }
  if (!status.preventsSelfReview) {
    throw new Error("The npm environment must prevent self-review.");
  }
  assertEnvironmentDoesNotSelfReviewDeadlock(environment, authenticatedLogin);

  for (const ruleset of desired) {
    const existing = existingByName.get(ruleset.name);
    if (existing && typeof existing.id === "number") {
      await github(token, "PUT", `/repos/${options.repository}/rulesets/${existing.id}`, ruleset);
      continue;
    }
    await github(token, "POST", `/repos/${options.repository}/rulesets`, ruleset);
  }

  console.log(JSON.stringify({ repository: options.repository, mode: "applied", rulesets: desired.map((ruleset) => ruleset.name), environment: status }, null, 2));
}

function mainRuleset() {
  return {
    name: MAIN_RULESET_NAME,
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
          do_not_enforce_on_create: true,
          strict_required_status_checks_policy: true,
          required_status_checks: REQUIRED_CI_CHECKS.map((context) => ({ context }))
        }
      }
    ]
  };
}

function tagRuleset() {
  return {
    name: TAG_RULESET_NAME,
    target: "tag",
    enforcement: "active",
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID, bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [
      { type: "creation" },
      { type: "deletion" },
      { type: "non_fast_forward" }
    ]
  };
}

function existingRulesetsByName(rulesets) {
  if (!Array.isArray(rulesets)) throw new Error("GitHub rulesets response was invalid.");
  const byName = new Map();
  for (const ruleset of rulesets) {
    if (!ruleset || typeof ruleset !== "object" || typeof ruleset.name !== "string" || typeof ruleset.id !== "number") {
      throw new Error("GitHub rulesets response was invalid.");
    }
    if (byName.has(ruleset.name)) throw new Error("GitHub rulesets response contained duplicate names.");
    byName.set(ruleset.name, ruleset);
  }
  return byName;
}

async function requireRemoteMain(token, repository) {
  await github(token, "GET", `/repos/${repository}/branches/main`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new Error("Push main before applying GitHub release controls.");
    }
    throw error;
  });
}

async function npmEnvironmentConfig(token, options) {
  return {
    wait_timer: 0,
    prevent_self_review: true,
    reviewers: await Promise.all(options.npmReviewers.map(async (login) => ({ type: "User", id: await userId(token, login) }))),
    deployment_branch_policy: null
  };
}

async function userId(token, login) {
  const user = await github(token, "GET", `/users/${encodeURIComponent(login)}`);
  if (!user || typeof user.id !== "number") throw new Error("GitHub reviewer response was invalid.");
  return user.id;
}

function requiredAuthenticatedLogin(user) {
  const login = user?.login;
  if (typeof login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new Error("Authenticated GitHub user response was invalid.");
  return login;
}

function assertNoSelfReviewDeadlock(reviewers, authenticatedLogin) {
  if (reviewers.length === 1 && reviewers[0].toLowerCase() === authenticatedLogin.toLowerCase()) {
    throw new Error("Npm environment sole reviewer must not be the authenticated release setup operator.");
  }
}

function assertEnvironmentDoesNotSelfReviewDeadlock(environment, authenticatedLogin) {
  const requiredReviewers = Array.isArray(environment?.protection_rules) ? environment.protection_rules.find((rule) => rule?.type === "required_reviewers") : undefined;
  const reviewers = requiredReviewers?.reviewers;
  if (Array.isArray(reviewers) && reviewers.length === 1 && reviewerLogin(reviewers[0])?.toLowerCase() === authenticatedLogin.toLowerCase()) {
    throw new Error("The npm environment sole required reviewer is the authenticated release setup operator.");
  }
}

function reviewerLogin(reviewerEntry) {
  const type = reviewerEntry?.type ?? reviewerEntry?.reviewer?.type;
  if (type !== "User") return undefined;
  const login = reviewerEntry?.reviewer?.login ?? reviewerEntry?.login;
  return typeof login === "string" ? login : undefined;
}

function environmentStatus(environment) {
  const requiredReviewers = Array.isArray(environment?.protection_rules) ? environment.protection_rules.find((rule) => rule?.type === "required_reviewers") : undefined;
  return {
    name: NPM_ENVIRONMENT,
    exists: !!environment,
    hasProtectionRules: Array.isArray(environment?.protection_rules) && environment.protection_rules.length > 0,
    hasRequiredReviewers: !!requiredReviewers && Array.isArray(requiredReviewers.reviewers) && requiredReviewers.reviewers.length > 0,
    preventsSelfReview: requiredReviewers?.prevent_self_review === true,
    deploymentBranchPolicy: environment?.deployment_branch_policy ?? null
  };
}

async function github(token, method, path, body) {
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
  if (!response.ok) throw new GitHubApiError(response.status);
  return data;
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

function githubApiErrorMessage(status) {
  return `GitHub API returned ${status}.`;
}

function parseArgs(args) {
  const options = { apply: false, repository: repositoryInput(envString("GITHUB_REPOSITORY") || DEFAULT_REPOSITORY), requireMain: true, npmReviewers: [], npmReviewerKeys: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--allow-missing-main") {
      options.requireMain = false;
    } else if (arg === "--repo") {
      const value = args[++index];
      options.repository = repositoryInput(value);
    } else if (arg === "--npm-reviewer") {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error("Npm environment reviewer must be a GitHub username.");
      const reviewerKey = value.toLowerCase();
      if (options.npmReviewerKeys.has(reviewerKey)) throw new Error("Npm environment reviewers must be unique.");
      if (options.npmReviewers.length >= MAX_NPM_ENVIRONMENT_REVIEWERS) throw new Error(`Npm environment can have at most ${MAX_NPM_ENVIRONMENT_REVIEWERS} reviewers.`);
      options.npmReviewerKeys.add(reviewerKey);
      options.npmReviewers.push(value);
    } else if (arg === "--prevent-self-review") {
      continue;
    } else if (arg === "--allow-self-review") {
      throw new Error("GitHub npm environment self-review must stay disabled.");
    } else {
      throw new Error("Usage: node scripts/configure-github-release-controls.mjs [--dry-run|--apply] [--repo owner/name] [--allow-missing-main] [--npm-reviewer login] [--prevent-self-review]");
    }
  }
  delete options.npmReviewerKeys;
  return options;
}

function githubToken() {
  const token = envString("GITHUB_TOKEN") || envString("GH_TOKEN");
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN with repository administration permission.");
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

function setupErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "GitHub release control setup failed with an internal error.";
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
