#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DEFAULT_REPOSITORY = "VictorHaine/p2p-transfer";
const MAIN_RULESET_NAME = "p2p-transfer: protect main";
const TAG_RULESET_NAME = "p2p-transfer: protect release tags";
const NPM_ENVIRONMENT = "npm";
const NPM_DEPLOYMENT_TAG_POLICY = "v*.*.*";
const RELEASE_TAG_REF_PATTERN = `refs/tags/${NPM_DEPLOYMENT_TAG_POLICY}`;
const GITHUB_ACTIONS_INTEGRATION_ID = 15368;
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
  "platform smoke / ubuntu-24.04-arm / node 22.22.3",
  "platform smoke / ubuntu-24.04-arm / node 24.13.1",
  "platform smoke / macos-15 / node 22.22.3",
  "platform smoke / macos-15 / node 24.13.1",
  "platform smoke / macos-15-intel / node 22.22.3",
  "platform smoke / macos-15-intel / node 24.13.1",
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
  if (options.apply && !options.requireMain) throw new Error("--allow-missing-main is only allowed with --dry-run.");
  const token = await githubToken(options);
  const authenticatedLogin = requiredAuthenticatedLogin(await github(token, "GET", "/user"));

  const repo = await github(token, "GET", `/repos/${options.repository}`);
  if (!repo || typeof repo.id !== "number") throw new Error("GitHub repository response was invalid.");
  const repositorySecurity = repositorySecurityStatus(repo);
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
  const dependencyVulnerabilityAlerts = await dependencyVulnerabilityAlertsStatus(token, options.repository);
  const privateVulnerabilityReporting = await privateVulnerabilityReportingStatus(token, options.repository);

  if (!options.apply) {
    console.log(JSON.stringify({ repository: options.repository, mode: "dry-run", rulesets: desired, environment: environmentStatus(environment), desiredEnvironment, dependencyVulnerabilityAlerts, privateVulnerabilityReporting, repositorySecurity }, null, 2));
    return;
  }

  const verifiedDependencyVulnerabilityAlerts = await ensureDependencyVulnerabilityAlerts(token, options.repository, dependencyVulnerabilityAlerts);
  const verifiedPrivateVulnerabilityReporting = await ensurePrivateVulnerabilityReporting(token, options.repository, privateVulnerabilityReporting);
  const verifiedRepositorySecurity = await ensureRepositorySecurity(token, options.repository, repositorySecurity);

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
  if (!status.disablesAdminBypass) {
    throw new Error("The npm environment must disable admin bypass.");
  }
  if (!status.usesCustomDeploymentPolicies) {
    throw new Error("The npm environment must restrict deployments to custom policies.");
  }
  assertEnvironmentDoesNotSelfReviewDeadlock(environment, authenticatedLogin);
  environment = await github(token, "GET", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}`);
  const verifiedEnvironmentStatus = environmentStatus(environment);
  assertNpmEnvironmentStatus(verifiedEnvironmentStatus);
  assertEnvironmentDoesNotSelfReviewDeadlock(environment, authenticatedLogin);
  await assertPersistedNpmEnvironmentApproverPermissions(token, options.repository, environment, authenticatedLogin);
  await ensureNpmDeploymentPolicy(token, options.repository);
  assertNpmDeploymentPolicies(await github(token, "GET", `/repos/${options.repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}/deployment-branch-policies?per_page=100`));

  for (const ruleset of desired) {
    const existing = existingByName.get(ruleset.name);
    if (existing && typeof existing.id === "number") {
      await github(token, "PUT", `/repos/${options.repository}/rulesets/${existing.id}`, ruleset);
      continue;
    }
    await github(token, "POST", `/repos/${options.repository}/rulesets`, ruleset);
  }
  await assertPersistedRulesets(token, options.repository);

  console.log(
    JSON.stringify(
      {
        repository: options.repository,
        mode: "applied",
        rulesets: desired.map((ruleset) => ruleset.name),
        environment: status,
        dependencyVulnerabilityAlerts: verifiedDependencyVulnerabilityAlerts,
        privateVulnerabilityReporting: verifiedPrivateVulnerabilityReporting,
        repositorySecurity: verifiedRepositorySecurity
      },
      null,
      2
    )
  );
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
          required_status_checks: REQUIRED_CI_CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_INTEGRATION_ID }))
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
    bypass_actors: [],
    conditions: { ref_name: { include: [RELEASE_TAG_REF_PATTERN], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" }
    ]
  };
}

function existingRulesetsByName(rulesets) {
  if (!Array.isArray(rulesets)) throw new Error("GitHub rulesets response was invalid.");
  const expectedTargets = new Map([
    [MAIN_RULESET_NAME, "branch"],
    [TAG_RULESET_NAME, "tag"]
  ]);
  const byName = new Map();
  for (const ruleset of rulesets) {
    if (!ruleset || typeof ruleset !== "object" || typeof ruleset.name !== "string" || typeof ruleset.id !== "number" || typeof ruleset.target !== "string") {
      throw new Error("GitHub rulesets response was invalid.");
    }
    const expectedTarget = expectedTargets.get(ruleset.name);
    if (expectedTarget === undefined) throw new Error("GitHub rulesets response contained an unexpected ruleset.");
    if (ruleset.target !== expectedTarget) throw new Error("GitHub rulesets response contained an unexpected ruleset target.");
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
    can_admins_bypass: false,
    prevent_self_review: true,
    reviewers: await Promise.all(options.npmReviewers.map(async (login) => ({ type: "User", id: await npmReviewerUserId(token, options.repository, login) }))),
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  };
}

async function ensureNpmDeploymentPolicy(token, repository) {
  const policies = await github(token, "GET", `/repos/${repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}/deployment-branch-policies?per_page=100`);
  const existing = deploymentPoliciesByName(policies);
  for (const policy of existing.values()) {
    if (policy.name !== NPM_DEPLOYMENT_TAG_POLICY || (policy.type !== undefined && policy.type !== "tag")) {
      await github(token, "DELETE", `/repos/${repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}/deployment-branch-policies/${policy.id}`);
    }
  }
  if (!existing.has(NPM_DEPLOYMENT_TAG_POLICY) || (existing.get(NPM_DEPLOYMENT_TAG_POLICY).type !== undefined && existing.get(NPM_DEPLOYMENT_TAG_POLICY).type !== "tag")) {
    await github(token, "POST", `/repos/${repository}/environments/${encodeURIComponent(NPM_ENVIRONMENT)}/deployment-branch-policies`, { name: NPM_DEPLOYMENT_TAG_POLICY, type: "tag" });
  }
}

function deploymentPoliciesByName(response) {
  if (!response || typeof response !== "object" || !Array.isArray(response.branch_policies)) throw new Error("GitHub deployment branch policies response was invalid.");
  if (typeof response.total_count === "number" && response.total_count !== response.branch_policies.length) throw new Error("GitHub deployment branch policies response was paginated unexpectedly.");
  const byName = new Map();
  for (const policy of response.branch_policies) {
    if (!policy || typeof policy !== "object" || typeof policy.id !== "number" || typeof policy.name !== "string") {
      throw new Error("GitHub deployment branch policies response was invalid.");
    }
    if (policy.type !== undefined && policy.type !== "branch" && policy.type !== "tag") throw new Error("GitHub deployment branch policy type was invalid.");
    if (byName.has(policy.name)) throw new Error("GitHub deployment branch policies response contained duplicate names.");
    byName.set(policy.name, policy);
  }
  return byName;
}

async function userId(token, login) {
  const user = await github(token, "GET", `/users/${encodeURIComponent(login)}`);
  if (!user || typeof user.id !== "number") throw new Error("GitHub reviewer response was invalid.");
  return user.id;
}

async function npmReviewerUserId(token, repository, login) {
  await assertNpmReviewerCanApprove(token, repository, login);
  return userId(token, login);
}

async function assertNpmReviewerCanApprove(token, repository, login) {
  const response = await github(token, "GET", `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`).catch((error) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error("Npm environment reviewer must be a repository collaborator with write, maintain, or admin permission.");
    throw error;
  });
  const permission = response?.permission;
  if (permission !== "admin" && permission !== "maintain" && permission !== "write") {
    throw new Error("Npm environment reviewer must have write, maintain, or admin repository permission.");
  }
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

async function assertPersistedNpmEnvironmentApproverPermissions(token, repository, environment, authenticatedLogin) {
  const reviewers = npmEnvironmentUserReviewerLogins(environment);
  let eligibleNonSelfReviewers = 0;
  for (const login of reviewers) {
    if (login.toLowerCase() === authenticatedLogin.toLowerCase()) continue;
    await assertNpmReviewerCanApprove(token, repository, login);
    eligibleNonSelfReviewers += 1;
  }
  if (eligibleNonSelfReviewers < 1) {
    throw new Error("GitHub npm environment must include at least one non-self user reviewer with write, maintain, or admin repository permission.");
  }
}

function npmEnvironmentUserReviewerLogins(environment) {
  const requiredReviewers = Array.isArray(environment?.protection_rules) ? environment.protection_rules.find((rule) => rule?.type === "required_reviewers") : undefined;
  const reviewers = requiredReviewers?.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length < 1) throw new Error("GitHub npm environment required reviewers rule has no reviewers.");
  const logins = [];
  for (const reviewer of reviewers) {
    const login = reviewerLogin(reviewer);
    if (login) logins.push(login);
  }
  if (logins.length < 1) throw new Error("GitHub npm environment must include at least one user reviewer with write, maintain, or admin repository permission.");
  return logins;
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
    disablesAdminBypass: environment?.can_admins_bypass === false,
    usesCustomDeploymentPolicies: environment?.deployment_branch_policy?.protected_branches === false && environment?.deployment_branch_policy?.custom_branch_policies === true,
    deploymentBranchPolicy: environment?.deployment_branch_policy ?? null
  };
}

function repositorySecurityStatus(repository) {
  const security = repository?.security_and_analysis;
  return {
    secretScanning: securityFeatureStatus(security, "secret_scanning"),
    secretScanningPushProtection: securityFeatureStatus(security, "secret_scanning_push_protection"),
    dependabotSecurityUpdates: securityFeatureStatus(security, "dependabot_security_updates")
  };
}

function securityFeatureStatus(security, key) {
  const feature = security?.[key];
  const status = feature?.status;
  return status === "enabled" || status === "disabled" ? status : "unknown";
}

async function ensureRepositorySecurity(token, repository, status) {
  if (status.secretScanning !== "enabled" || status.secretScanningPushProtection !== "enabled") {
    await github(token, "PATCH", `/repos/${repository}`, {
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" }
      }
    });
  }
  if (status.dependabotSecurityUpdates !== "enabled") {
    await github(token, "PUT", `/repos/${repository}/automated-security-fixes`);
  }
  assertDependabotAutomatedSecurityFixes(await github(token, "GET", `/repos/${repository}/automated-security-fixes`));
  return assertRepositorySecurityStatus(repositorySecurityStatus(await github(token, "GET", `/repos/${repository}`)));
}

function assertRepositorySecurityStatus(status) {
  if (status.secretScanning !== "enabled") throw new Error("GitHub repository secret scanning must be enabled.");
  if (status.secretScanningPushProtection !== "enabled") throw new Error("GitHub repository secret scanning push protection must be enabled.");
  if (status.dependabotSecurityUpdates !== "enabled") throw new Error("GitHub repository Dependabot security updates must be enabled.");
  return status;
}

function assertDependabotAutomatedSecurityFixes(status) {
  if (!status || typeof status !== "object" || Array.isArray(status) || typeof status.enabled !== "boolean" || typeof status.paused !== "boolean") {
    throw new Error("GitHub Dependabot security updates status response was invalid.");
  }
  if (!status.enabled) throw new Error("GitHub repository Dependabot security updates must be enabled.");
  if (status.paused) throw new Error("GitHub repository Dependabot security updates must not be paused.");
}

function assertNpmEnvironmentStatus(status) {
  if (!status.hasRequiredReviewers) {
    throw new Error("The npm environment exists but has no required reviewers protection rule.");
  }
  if (!status.preventsSelfReview) {
    throw new Error("The npm environment must prevent self-review.");
  }
  if (!status.disablesAdminBypass) {
    throw new Error("The npm environment must disable admin bypass.");
  }
  if (!status.usesCustomDeploymentPolicies) {
    throw new Error("The npm environment must restrict deployments to custom policies.");
  }
}

function assertNpmDeploymentPolicies(response) {
  if (!response || typeof response !== "object" || !Array.isArray(response.branch_policies)) throw new Error("GitHub deployment branch policies response was invalid.");
  if (typeof response.total_count === "number" && response.total_count !== response.branch_policies.length) throw new Error("GitHub deployment branch policies response was paginated unexpectedly.");
  if (response.branch_policies.length !== 1) throw new Error("GitHub npm environment deployment policy is not exact.");
  const policy = response.branch_policies[0];
  if (!policy || typeof policy !== "object" || policy.name !== NPM_DEPLOYMENT_TAG_POLICY || policy.type !== "tag") {
    throw new Error("GitHub npm environment must deploy only from release tags.");
  }
}

async function assertPersistedRulesets(token, repository) {
  const rulesetsByName = existingRulesetsByName(await github(token, "GET", `/repos/${repository}/rulesets?includes_parents=false`));
  const mainRuleset = assertRequiredRuleset(rulesetsByName, MAIN_RULESET_NAME, "branch");
  const tagRuleset = assertRequiredRuleset(rulesetsByName, TAG_RULESET_NAME, "tag");
  assertMainRuleset(await github(token, "GET", `/repos/${repository}/rulesets/${mainRuleset.id}`));
  assertTagRuleset(await github(token, "GET", `/repos/${repository}/rulesets/${tagRuleset.id}`));
}

async function privateVulnerabilityReportingStatus(token, repository) {
  const status = await github(token, "GET", `/repos/${repository}/private-vulnerability-reporting`);
  return assertPrivateVulnerabilityReportingResponse(status);
}

async function dependencyVulnerabilityAlertsStatus(token, repository) {
  try {
    await github(token, "GET", `/repos/${repository}/vulnerability-alerts`);
    return { enabled: true };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return { enabled: false };
    throw error;
  }
}

async function ensureDependencyVulnerabilityAlerts(token, repository, status) {
  if (!status.enabled) await github(token, "PUT", `/repos/${repository}/vulnerability-alerts`);
  const verified = await dependencyVulnerabilityAlertsStatus(token, repository);
  if (!verified.enabled) throw new Error("GitHub dependency vulnerability alerts must be enabled.");
  return verified;
}

async function ensurePrivateVulnerabilityReporting(token, repository, status) {
  if (status.enabled) return status;
  await github(token, "PUT", `/repos/${repository}/private-vulnerability-reporting`);
  const verified = await privateVulnerabilityReportingStatus(token, repository);
  if (!verified.enabled) throw new Error("GitHub private vulnerability reporting must be enabled.");
  return verified;
}

function assertPrivateVulnerabilityReportingResponse(status) {
  if (!status || typeof status !== "object" || Array.isArray(status) || typeof status.enabled !== "boolean") {
    throw new Error("GitHub private vulnerability reporting status response was invalid.");
  }
  return { enabled: status.enabled };
}

function assertRequiredRuleset(rulesetsByName, name, target) {
  const ruleset = rulesetsByName.get(name);
  if (!ruleset) throw new Error(`GitHub ruleset is missing: ${name}.`);
  if (ruleset.target !== target || ruleset.enforcement !== "active") throw new Error(`GitHub ruleset is not active for ${target}: ${name}.`);
  if (typeof ruleset.id !== "number") throw new Error(`GitHub ruleset response is missing id: ${name}.`);
  return ruleset;
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
  assertRulesetBase(ruleset, TAG_RULESET_NAME, "tag", RELEASE_TAG_REF_PATTERN);
  assertNoBypassActors(ruleset, TAG_RULESET_NAME);
  const rules = rulesByType(ruleset, TAG_RULESET_NAME, ["deletion", "non_fast_forward"]);
  assertRulePresent(rules, "deletion", TAG_RULESET_NAME);
  assertRulePresent(rules, "non_fast_forward", TAG_RULESET_NAME);
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
  const contexts = [];
  for (const entry of actual) {
    if (!entry || typeof entry !== "object" || typeof entry.context !== "string") {
      throw new Error(`${name} required status checks are invalid.`);
    }
    if (entry.integration_id !== GITHUB_ACTIONS_INTEGRATION_ID) {
      throw new Error(`${name} required status checks are not pinned to GitHub Actions.`);
    }
    contexts.push(entry.context);
  }
  assertArrayIncludesExactly(contexts, expected, `${name} required status checks`);
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
  const options = { apply: false, repository: repositoryInput(envString("GITHUB_REPOSITORY") || DEFAULT_REPOSITORY), requireMain: true, tokenStdin: false, npmReviewers: [], npmReviewerKeys: new Set() };
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
    } else if (arg === "--token-stdin") {
      options.tokenStdin = true;
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
      throw new Error("Usage: node scripts/configure-github-release-controls.mjs [--dry-run|--apply] [--repo owner/name] [--dry-run --allow-missing-main] [--npm-reviewer login] [--prevent-self-review] [--token-stdin]");
    }
  }
  delete options.npmReviewerKeys;
  return options;
}

async function githubToken(options) {
  if (options.tokenStdin) {
    if (envString("GITHUB_TOKEN") || envString("GH_TOKEN")) throw new Error("Do not set GITHUB_TOKEN or GH_TOKEN when using --token-stdin.");
    return readStdinToken();
  }
  const token = envString("GITHUB_TOKEN") || envString("GH_TOKEN");
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN, or pipe a token with --token-stdin, with repository administration permission.");
  return token;
}

async function readStdinToken() {
  if (process.stdin.isTTY === true) throw new Error("Pipe GitHub token stdin; interactive terminal stdin is not accepted for --token-stdin.");
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error("GitHub token stdin was invalid.");
    total += chunk.byteLength;
    if (total > MAX_ENV_VALUE_BYTES + 2) throw new Error(`GitHub token stdin must be a non-empty control-free value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new Error("GitHub token stdin must be valid UTF-8.");
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.length < 1 || hasUnsafeEnvText(value) || utf8ByteLengthExceeds(value, MAX_ENV_VALUE_BYTES)) {
    throw new Error(`GitHub token stdin must be a non-empty control-free value under ${MAX_ENV_VALUE_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function repositoryInput(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) throw new Error("Repository must be owner/name.");
  if (value !== DEFAULT_REPOSITORY) throw new Error("Repository must match the release repository.");
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
