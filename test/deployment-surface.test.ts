import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type PackageJson = {
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};

const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const codeqlWorkflow = fs.readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
const scorecardWorkflow = fs.readFileSync(new URL("../.github/workflows/scorecard.yml", import.meta.url), "utf8");
const dependencyReviewWorkflow = fs.readFileSync(new URL("../.github/workflows/dependency-review.yml", import.meta.url), "utf8");
const dependencyIntegrityWorkflow = fs.readFileSync(new URL("../.github/workflows/dependency-integrity.yml", import.meta.url), "utf8");
const codeowners = fs.readFileSync(new URL("../.github/CODEOWNERS", import.meta.url), "utf8");
const pullRequestTemplate = fs.readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");
const httpProbeScript = fs.readFileSync(new URL("../scripts/probe-http.mjs", import.meta.url), "utf8");
const releaseTagScript = fs.readFileSync(new URL("../scripts/check-release-tag.mjs", import.meta.url), "utf8");
const releaseMainScript = fs.readFileSync(new URL("../scripts/check-release-main.mjs", import.meta.url), "utf8");
const releaseArtifactScript = fs.readFileSync(new URL("../scripts/verify-release-artifact.mjs", import.meta.url), "utf8");
const releasePublishScript = fs.readFileSync(new URL("../scripts/publish-release-artifact.mjs", import.meta.url), "utf8");
const githubReleaseScript = fs.readFileSync(new URL("../scripts/create-github-release.mjs", import.meta.url), "utf8");
const releaseChecksumScript = fs.readFileSync(new URL("../scripts/write-release-checksum.mjs", import.meta.url), "utf8");
const releaseSbomScript = fs.readFileSync(new URL("../scripts/write-release-sbom.mjs", import.meta.url), "utf8");
const releaseNotesScript = fs.readFileSync(new URL("../scripts/write-release-notes.mjs", import.meta.url), "utf8");
const liveReleaseRefScript = fs.readFileSync(new URL("../scripts/verify-live-release-ref.mjs", import.meta.url), "utf8");
const githubReleaseControlsScript = fs.readFileSync(new URL("../scripts/configure-github-release-controls.mjs", import.meta.url), "utf8");
const releaseReadinessScript = fs.readFileSync(new URL("../scripts/check-release-readiness.mjs", import.meta.url), "utf8");
const npmBootstrapScript = fs.readFileSync(new URL("../scripts/bootstrap-npm-package.mjs", import.meta.url), "utf8");
const checkedPnpmScript = fs.readFileSync(new URL("../scripts/prepare-checked-pnpm.mjs", import.meta.url), "utf8");
const dockerPolicySmokeScript = fs.readFileSync(new URL("../scripts/smoke-docker-policy.mjs", import.meta.url), "utf8");
const dockerPublishScript = fs.readFileSync(new URL("../scripts/publish-docker-image.mjs", import.meta.url), "utf8");
const dependabotConfig = fs.readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const contributing = fs.readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const tsconfigNode = JSON.parse(fs.readFileSync(new URL("../tsconfig.node.json", import.meta.url), "utf8")) as {
  compilerOptions?: { declaration?: boolean; lib?: string[]; types?: string[] };
  include?: string[];
};
const tsconfig = JSON.parse(fs.readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as {
  compilerOptions?: {
    exactOptionalPropertyTypes?: boolean;
    noFallthroughCasesInSwitch?: boolean;
    noImplicitOverride?: boolean;
    noImplicitReturns?: boolean;
    noUncheckedIndexedAccess?: boolean;
    noUnusedLocals?: boolean;
    noUnusedParameters?: boolean;
    strict?: boolean;
  };
};
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
const PINNED_NODE_VERSION = "22.22.3";
const PLATFORM_SMOKE_NODE_VERSIONS = ["22.22.3", "24.13.1"];
const PINNED_NODE_IMAGE = `${PINNED_NODE_VERSION}-bookworm-slim`;
const PINNED_NODE_IMAGE_DIGEST = "6ed70fbf60557fb3a2faea5657d4105bace34c93449c2571919a1589fae30153";
const PINNED_NODE_IMAGE_REF = `node:${PINNED_NODE_IMAGE}@sha256:${PINNED_NODE_IMAGE_DIGEST}`;
const PINNED_RUNNERS = ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15", "macos-15-intel", "windows-2025"];
const PINNED_ACTIONS = new Map([
  ["actions/checkout", { sha: "11bd71901bbe5b1630ceea73d27597364c9af683", version: "v4.2.2" }],
  ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" }],
  ["actions/upload-artifact", { sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" }],
  ["actions/download-artifact", { sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093", version: "v4.3.0" }],
  ["actions/attest-build-provenance", { sha: "a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32", version: "v4.1.0" }],
  ["actions/dependency-review-action", { sha: "a1d282b36b6f3519aa1f3fc636f609c47dddb294", version: "v5.0.0" }],
  ["github/codeql-action/init", { sha: "8aad20d150bbac5944a9f9d289da16a4b0d87c1e", version: "v4.36.2" }],
  ["github/codeql-action/analyze", { sha: "8aad20d150bbac5944a9f9d289da16a4b0d87c1e", version: "v4.36.2" }],
  ["github/codeql-action/upload-sarif", { sha: "8aad20d150bbac5944a9f9d289da16a4b0d87c1e", version: "v4.36.2" }],
  ["ossf/scorecard-action", { sha: "4eaacf0543bb3f2c246792bd56e8cdeffafb205a", version: "v2.4.3" }]
]);

test("Docker runtime image keeps a minimal non-root production surface", () => {
  const pnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, "");
  assert.ok(pnpmVersion);
  assert.match(checkedPnpmScript, /EXPECTED_PNPM_COREPACK_HASH = "sha512\.c85357fe17ca12dd23dd7071822666dfd7e3cb76fe214e3370b5ea2fb34f2a231185509b63e717f3cd0acb38dd3f8d82bcd5e8172400ae678b70ea4fbed0896d"/);
  assert.match(checkedPnpmScript, /readCheckedText\(path\.join\(root, "package\.json"\), MAX_PACKAGE_JSON_BYTES, "package metadata"\)/);
  assert.match(checkedPnpmScript, /await lstat\(file\)/);
  assert.match(checkedPnpmScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(checkedPnpmScript, /left\.mtimeMs === right\.mtimeMs && left\.ctimeMs === right\.ctimeMs/);
  assert.match(checkedPnpmScript, /const childEnv = await privateChildEnv\(path\.join\(tmp, "home"\)\)/);
  assert.match(checkedPnpmScript, /\["PATH", true\]/);
  assert.match(checkedPnpmScript, /const descriptor = Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(checkedPnpmScript, /spawn\(command, args, \{ cwd: options\.cwd, env: options\.env, stdio: \["ignore", "pipe", "pipe"\] \}\)/);
  assert.doesNotMatch(checkedPnpmScript, /readFile\(path\.join\(root, "package\.json"\)|readFileSync\(path\.join\(root, "package\.json"\)/);
  assert.match(dockerfile, /^COPY package\.json \.\/\nCOPY scripts\/prepare-checked-pnpm\.mjs \.\/scripts\/prepare-checked-pnpm\.mjs\nRUN node scripts\/prepare-checked-pnpm\.mjs\nCOPY pnpm-lock\.yaml pnpm-workspace\.yaml \.\//m);
  assert.match(dockerfile, new RegExp(`^FROM ${escapeRegExp(PINNED_NODE_IMAGE_REF)} AS build$`, "m"));
  assert.match(dockerfile, new RegExp(`^FROM ${escapeRegExp(PINNED_NODE_IMAGE_REF)}$`, "m"));
  assert.doesNotMatch(dockerfile, /^FROM node:[^@\n]+(?: AS build)?$/m);
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
  assert.match(dockerfile, /^ENV HOST=0\.0\.0\.0$/m);
  assert.match(dockerfile, /^RUN pnpm check:install-state$/m);
  assert.match(dockerfile, /^RUN pnpm build\nRUN pnpm prune --prod\n\nFROM /m);
  assert.match(dockerfile, /^COPY --chown=node:node --from=build \/app\/node_modules \.\/node_modules$/m);
  assert.match(dockerfile, /^COPY --chown=node:node --from=build \/app\/dist-node \.\/dist-node$/m);
  assert.match(dockerfile, /^COPY --chown=node:node --from=build \/app\/dist-web \.\/dist-web$/m);
  assert.match(dockerfile, /^COPY --chown=node:node --from=build \/app\/scripts\/probe-http\.mjs \.\/scripts\/probe-http\.mjs$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*PROBE_URL=http:\/\/127\.0\.0\.1:\$\{PORT:-8787\}\/healthz PROBE_STATUS=200 node scripts\/probe-http\.mjs$/m);
  assert.doesNotMatch(dockerfile, /^HEALTHCHECK .*node -e "fetch\(/m);
  assert.match(dockerfile, /^CMD \["node", "dist-node\/server\/index\.js"\]$/m);

  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf(`\nFROM ${PINNED_NODE_IMAGE_REF}`));
  assert.doesNotMatch(runtimeStage, /COPY .*\/app\/(?:src|test|\.github|release-artifacts)\b/);
  assert.doesNotMatch(runtimeStage, /pnpm install|pnpm build|corepack prepare/);
  assert.doesNotMatch(dockerfile, /corepack prepare pnpm@/);
});

test("Docker build context excludes local-only and sensitive surfaces", () => {
  const entries = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
  for (const entry of [
    ".git",
    ".github",
    ".codex",
    ".agents",
    ".env",
    ".env.*",
    ".envrc",
    ".envrc.*",
    ".npmrc",
    ".pnpmrc",
    ".npmrc.*",
    ".pnpmrc.*",
    ".yarnrc",
    ".yarnrc.yml",
    ".ssh",
    ".aws",
    ".azure",
    ".config",
    ".gnupg",
    "*.pem",
    "*.key",
    "*.cert",
    "*.crt",
    "*.p12",
    "*.pfx",
    "*.kdbx",
    "*.age",
    "*.asc",
    "id_rsa",
    "id_ed25519",
    "known_hosts",
    "authorized_keys",
    "node_modules",
    ".pnpm-store",
    "dist-node",
    "dist-web",
    "coverage",
    "release-artifacts",
    "*.tgz",
    "*.log",
    ".turbo",
    ".vite",
    "test"
  ]) {
    assert.equal(entries.has(entry), true, `.dockerignore must exclude ${entry}`);
  }
});

test("Node build does not inherit browser-only ambient types", () => {
  assert.equal(tsconfig.compilerOptions?.strict, true);
  assert.equal(tsconfig.compilerOptions?.noUncheckedIndexedAccess, true);
  assert.equal(tsconfig.compilerOptions?.exactOptionalPropertyTypes, true);
  assert.equal(tsconfig.compilerOptions?.noImplicitReturns, true);
  assert.equal(tsconfig.compilerOptions?.noFallthroughCasesInSwitch, true);
  assert.equal(tsconfig.compilerOptions?.noUnusedLocals, true);
  assert.equal(tsconfig.compilerOptions?.noUnusedParameters, true);
  assert.equal(tsconfig.compilerOptions?.noImplicitOverride, true);
  assert.notEqual(tsconfigNode.compilerOptions?.declaration, false);
  assert.deepEqual(tsconfigNode.compilerOptions?.lib, ["ES2022"]);
  assert.deepEqual(tsconfigNode.compilerOptions?.types, ["node"]);
  assert.equal(tsconfigNode.include?.includes("types/node-webrtc.d.ts"), true);
});

test("package runtime range is bounded to tested Node majors", () => {
  assert.equal(packageJson.engines?.node, ">=22.22.3 <23 || >=24.13.1 <25");
  assert.match(readme, /Node\.js 22\.22\.3 through the latest Node\.js 22 patch, or Node\.js 24\.13\.1 through the latest Node\.js 24 patch/);
  assert.match(readme, /Node\.js 23 is intentionally unsupported/);
  assert.doesNotMatch(readme, /Node\.js 22\.22\.3 or newer, before Node\.js 25/);
  const platformSmokeJob = ciWorkflow.slice(ciWorkflow.indexOf("  platform-smoke:"));
  assert.match(platformSmokeJob, /node:\n\s+- 22\.22\.3\n\s+- 24\.13\.1/);
  assert.match(platformSmokeJob, /node-version: \$\{\{ matrix\.node \}\}/);
  for (const version of PLATFORM_SMOKE_NODE_VERSIONS) {
    assert.match(platformSmokeJob, new RegExp(`- ${escapeRegExp(version)}`));
  }
  assert.doesNotMatch(platformSmokeJob, /- 23\./);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("CI and release workflows keep minimal token permissions", () => {
  for (const workflow of [ciWorkflow, releaseWorkflow, codeqlWorkflow, scorecardWorkflow, dependencyReviewWorkflow]) {
    assert.doesNotMatch(workflow, /pull_request_target|workflow_run/);
    assert.doesNotMatch(workflow, /runs-on:\s*[a-z]+-latest|-\s+[a-z]+-latest/);
    assertEveryWorkflowJobHasTimeout(workflow);
  }

  for (const workflow of [ciWorkflow, releaseWorkflow]) {
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.doesNotMatch(workflow, /node-version:\s*22(?:\s|$)/);
    assert.doesNotMatch(workflow, /node-version:\s*node|node-version:\s*lts/);
    const setupNodeCount = actionUseCount(workflow, "actions/setup-node");
    const pinnedSetupNodeCount = workflow.match(new RegExp(`node-version: ${escapeRegExp(PINNED_NODE_VERSION)}`, "g"))?.length ?? 0;
    const matrixSetupNodeCount = workflow.match(/node-version: \$\{\{ matrix\.node \}\}/g)?.length ?? 0;
    assert.equal(pinnedSetupNodeCount + matrixSetupNodeCount, setupNodeCount);
    const checkoutCount = actionUseCount(workflow, "actions/checkout");
    const persistedCredentialDisableCount = workflow.match(/persist-credentials: false/g)?.length ?? 0;
    assert.equal(persistedCredentialDisableCount, checkoutCount);
  }

  assert.doesNotMatch(ciWorkflow, /id-token:\s*write/);
  assert.match(ciWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /^concurrency:\n  group: release-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m);
  assert.match(releaseWorkflow, /^on:\n  push:\n    tags:\n      - "v\*\.\*\.\*"$/m);
  assert.match(securityPolicy, /release tags matching `v\*\.\*\.\*` must be protected from deletion and non-fast-forward movement by the checked GitHub repository ruleset before publishing/);
  assert.match(securityPolicy, /must not enable GitHub's tag creation restriction without an explicit audited release-bot bypass actor/);
  assert.match(securityPolicy, /classic tag protection is not validated by release preflight/);
  assert.match(readme, /exact repository rulesets that release preflight requires for `main` and `v\*\.\*\.\*` release tags/);
  assert.match(readme, /The checked repository ruleset for `v\*\.\*\.\*` tags must be active before the first release/);
  assert.match(securityPolicy, /release tag and package-version matching must use the checked release tag verifier/);
  assert.match(releaseWorkflow, /Verify tag matches package version[\s\S]*run: node scripts\/check-release-tag\.mjs[\s\S]*Verify release tag is on main/);
  assert.doesNotMatch(releaseWorkflow, /readFileSync\('package\.json'|node -p|test "\$\{GITHUB_REF_NAME\}" = "v\$\{version\}"/);
  assert.match(releaseTagScript, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseTagScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseTagScript, /await open\(file, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(releaseTagScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(releaseTagScript, /\$\{name\} must be a non-empty control-free string under \$\{MAX_RELEASE_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseTagScript, /envString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(releaseTagScript, /envString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(releaseTagScript, /release tag does not match package version\./);
  assert.match(securityPolicy, /release tag commit must exactly match protected `main` before release artifact packaging, attestation, npm publish, Docker publish, or GitHub Release creation/);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  assert.match(securityPolicy, /release tag current-main matching must use the checked release main verifier/);
  assert.match(releaseWorkflow, /Verify release tag is on main[\s\S]*run: node scripts\/check-release-main\.mjs[\s\S]*Release controls preflight/);
  assert.doesNotMatch(releaseWorkflow, /git fetch --no-tags|git merge-base --is-ancestor "\$GITHUB_SHA"/);
  assert.match(releaseMainScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseMainScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(releaseMainScript, /\$\{name\} must be a non-empty control-free string under \$\{MAX_RELEASE_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseMainScript, /\$\{name\} must be a non-empty control-free child environment value under \$\{MAX_CHILD_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(releaseMainScript, /import \{ spawn \} from "node:child_process"/);
  assert.match(releaseMainScript, /const child = spawn\("git", args/);
  assert.match(releaseMainScript, /stdio: "ignore"/);
  assert.match(releaseMainScript, /timeoutError = new Error\(`\$\{failureMessage\} Git subprocess timed out\.`\)/);
  assert.match(releaseMainScript, /child\.kill\("SIGTERM"\)/);
  assert.match(releaseMainScript, /killTimer = setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.doesNotMatch(releaseMainScript, /spawnSync|maxBuffer|encoding: "utf8"|stdio: \["ignore", "pipe", "pipe"\]/);
  assert.match(releaseMainScript, /\["fetch", "--no-tags", "--prune", "origin", "\+refs\/heads\/main:refs\/remotes\/origin\/main"\]/);
  assert.match(releaseMainScript, /\["merge-base", "--is-ancestor", sha, "origin\/main"\]/);
  assert.match(releaseMainScript, /\["merge-base", "--is-ancestor", "origin\/main", sha\]/);
  assert.match(releaseMainScript, /release tag commit does not match current main\./);
  assert.match(releaseMainScript, /import \{ devNull \} from "node:os"/);
  assert.match(releaseMainScript, /GIT_CONFIG_GLOBAL: devNull/);
  assert.match(releaseMainScript, /GIT_CONFIG_NOSYSTEM: "1"/);
  assert.match(releaseMainScript, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(securityPolicy, /a control-free minimal Git child environment that ignores global and system Git config and disables terminal prompts/);
  assert.match(securityPolicy, /release main checks must signal timed-out Git subprocesses, arm a bounded `SIGKILL` fallback, and reject only after the child exits/);
  assert.match(releaseWorkflow, /Release controls preflight[\s\S]*GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_PREFLIGHT_TOKEN \}\}[\s\S]*run: node scripts\/check-release-readiness\.mjs[\s\S]*Install/);
  const ciVerifyJob = workflowJob(ciWorkflow, "verify");
  const ciBrowserInteropJob = workflowJob(ciWorkflow, "browser-interop");
  const ciPlatformSmokeJob = workflowJob(ciWorkflow, "platform-smoke");
  const ciDockerJob = workflowJob(ciWorkflow, "docker");
  const releasePlatformSmokeJob = workflowJob(releaseWorkflow, "platform-smoke");
  const releaseDockerValidateJob = workflowJob(releaseWorkflow, "docker-validate");
  const releaseDockerJob = workflowJob(releaseWorkflow, "docker");
  for (const runner of PINNED_RUNNERS) {
    assert.match(ciWorkflow, new RegExp(escapeRegExp(runner)));
    assert.match(releaseWorkflow, new RegExp(escapeRegExp(runner)));
  }
  assert.match(ciVerifyJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native/);
  assert.match(ciVerifyJob, /timeout-minutes: 20/);
  assert.match(ciBrowserInteropJob, /timeout-minutes: 45/);
  assert.match(ciPlatformSmokeJob, /timeout-minutes: 25/);
  assert.match(ciDockerJob, /timeout-minutes: 30/);
  assert.match(securityPolicy, /every CI and release workflow job must set an explicit `timeout-minutes` bound/);
  assert.doesNotMatch(ciVerifyJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(ciPlatformSmokeJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed/);
  assert.doesNotMatch(ciPlatformSmokeJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(releasePlatformSmokeJob, /node:\n\s+- 22\.22\.3\n\s+- 24\.13\.1/);
  assert.match(releasePlatformSmokeJob, /os:\n\s+- ubuntu-24\.04\n\s+- ubuntu-24\.04-arm\n\s+- macos-15\n\s+- macos-15-intel\n\s+- windows-2025/);
  assert.match(releasePlatformSmokeJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed/);
  assert.doesNotMatch(releasePlatformSmokeJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(ciWorkflow, /pnpm smoke:packed/);
  assert.match(ciWorkflow, /dependency audit[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.match(ciWorkflow, /DOCKER_SMOKE_TAG=p2p-transfer:test node scripts\/smoke-docker-policy\.mjs/);
  assert.match(ciDockerJob, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0[\s\S]*node-version: 22\.22\.3/);
  assert.match(ciDockerJob, /node scripts\/prepare-checked-pnpm\.mjs[\s\S]*DOCKER_SMOKE_TAG=p2p-transfer:test node scripts\/smoke-docker-policy\.mjs/);
  assert.doesNotMatch(ciDockerJob, /corepack prepare pnpm@/);
  assert.match(dockerPolicySmokeScript, /\["build", "-t", imageTag, "\."\]/);
  assert.match(dockerPolicySmokeScript, /"run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", "SIGNALING_TOPOLOGY=single-instance", imageTag/);
  assert.match(dockerPolicySmokeScript, /"run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-e", `ALLOWED_ORIGINS=\$\{PRODUCTION_ORIGIN\}`, imageTag/);
  assert.match(dockerPolicySmokeScript, /"Error: ALLOWED_ORIGINS is required in production\."/);
  assert.match(dockerPolicySmokeScript, /"Error: SIGNALING_TOPOLOGY must be single-instance or sticky-sessions for production or non-loopback deployments\."/);
  assert.match(dockerPolicySmokeScript, /function hasExactOutputLine\(result, expectedLine\)/);
  assert.match(dockerPolicySmokeScript, /line\.trim\(\) === expectedLine/);
  assert.match(dockerPolicySmokeScript, /MAX_DOCKER_FAILURE_EVIDENCE_CHARS = 128 \* 1024/);
  assert.match(dockerPolicySmokeScript, /import \{ spawn \} from "node:child_process"/);
  assert.match(dockerPolicySmokeScript, /const DOCKER_PREFLIGHT_TIMEOUT_MS = 20_000/);
  assert.match(dockerPolicySmokeScript, /const BUILD_TIMEOUT_MS = 300_000/);
  assert.match(dockerPolicySmokeScript, /await run\("docker", \["info", "--format", "\{\{json \.ServerVersion\}\}"\], "docker daemon preflight", DOCKER_PREFLIGHT_TIMEOUT_MS/);
  assert.match(dockerPolicySmokeScript, /const CHILD_KILL_GRACE_MS = 5_000/);
  assert.match(dockerPolicySmokeScript, /timeoutError = new Error\(`\$\{label\} timed out\.`\)/);
  assert.match(dockerPolicySmokeScript, /child\.kill\("SIGTERM"\)/);
  assert.match(dockerPolicySmokeScript, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), CHILD_KILL_GRACE_MS\)/);
  assert.match(dockerPolicySmokeScript, /if \(timeoutError\) \{\n\s+rejectOnce\(timeoutError\)/);
  assert.match(dockerPolicySmokeScript, /stdout = appendBoundedOutput\(stdout, chunk\)/);
  assert.match(dockerPolicySmokeScript, /stderr = appendBoundedOutput\(stderr, chunk\)/);
  assert.doesNotMatch(dockerPolicySmokeScript, /spawnSync|maxBuffer: MAX_COMMAND_OUTPUT_BYTES/);
  assert.doesNotMatch(dockerPolicySmokeScript, /combinedOutput\(result\)\.includes\(requiredEvidence\)/);
  assert.match(dockerPolicySmokeScript, /"127\.0\.0\.1::8787"/);
  assert.match(dockerPolicySmokeScript, /await waitForProbe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/healthz`, "200"\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/`, "200", \{ contains: "ff transfer", maxBytes: "1048576" \}\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/v1\/ice`, "200", \{ origin: PRODUCTION_ORIGIN, contains: "\\"iceServers\\"" \}\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(`http:\/\/127\.0\.0\.1:\$\{port\}\/v1\/ice`, "403", \{ origin: BAD_ORIGIN \}\)/);
  assert.match(dockerPolicySmokeScript, /await probe\(url, status\)/);
  assert.match(dockerPolicySmokeScript, /await probeWebSocketOrigin\(port, PRODUCTION_ORIGIN, true\)/);
  assert.match(dockerPolicySmokeScript, /await probeWebSocketOrigin\(port, BAD_ORIGIN, false\)/);
  assert.match(dockerPolicySmokeScript, /function webSocketHandshakeRequest\(port, origin\)/);
  assert.match(dockerPolicySmokeScript, /"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="/);
  assert.doesNotMatch(ciWorkflow, /fetch\('http:\/\/127\.0\.0\.1:8787|body\.includes\('ff transfer'\)/);
  assert.doesNotMatch(ciWorkflow, /ALLOW_ANY_ORIGIN/);
  const releaseVerifyJob = workflowJob(releaseWorkflow, "verify");
  const releasePublishJob = workflowJob(releaseWorkflow, "publish");
  const releaseGitHubReleaseJob = workflowJob(releaseWorkflow, "github-release");
  assert.match(releaseVerifyJob, /timeout-minutes: 60/);
  assert.match(releasePlatformSmokeJob, /timeout-minutes: 25/);
  assert.match(releaseDockerValidateJob, /timeout-minutes: 30/);
  assert.match(releaseDockerJob, /timeout-minutes: 30/);
  assert.doesNotMatch(releaseWorkflow, /\n  attest:\n/);
  assert.match(releasePublishJob, /timeout-minutes: 20/);
  assert.match(releaseGitHubReleaseJob, /timeout-minutes: 10/);
  assert.match(releaseVerifyJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed[\s\S]*pnpm test:e2e[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.doesNotMatch(releaseVerifyJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(securityPolicy, /release workflow artifact packaging must use `scripts\/smoke-release-artifact\.mjs --keep-artifacts`/);
  assert.match(releaseWorkflow, /pack release artifact[\s\S]*node scripts\/smoke-release-artifact\.mjs --keep-artifacts/);
  assert.doesNotMatch(releaseWorkflow, /pack release artifact[\s\S]*(rm -rf release-artifacts|mkdir -p release-artifacts|pnpm --config\.ignore-scripts=true pack --pack-destination release-artifacts|node scripts\/write-release-checksum\.mjs)/);
  assert.match(releaseWorkflow, /Verify release notes[\s\S]*node scripts\/write-release-notes\.mjs --check[\s\S]*pack release artifact/);
  assert.match(releaseSbomScript, /spawn\(pnpm, \["sbom", "--sbom-format", "cyclonedx", "--prod", "--sbom-type", "application"\]/);
  assert.match(releaseSbomScript, /await writeFile\(path\.join\(artifactDir, SBOM_NAME\), sbomText, \{ flag: "wx" \}\)/);
  assert.match(releaseChecksumScript, /return `\$\{packedPackageName\(name\)\}-\$\{version\}\.tgz`[\s\S]*const expectedTarballName = expectedTarballNameFor\(packageJson\)[\s\S]*entries\.length !== 2[\s\S]*entry\.name === expectedTarballName[\s\S]*entry\.name === SBOM_NAME[\s\S]*const tarballChecksum = createHash\("sha256"\)[\s\S]*const sbomChecksum = createHash\("sha256"\)[\s\S]*writeFile\(path\.join\(artifactDir, "SHA256SUMS"\), `\$\{tarballChecksum\}  \$\{expectedTarballName\}\\n\$\{sbomChecksum\}  \$\{SBOM_NAME\}\\n`, \{ flag: "wx" \}\)/);
  assert.match(releaseChecksumScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseChecksumScript, /const artifactDir = await verifiedArtifactDir\(\)/);
  assert.match(releaseNotesScript, /const headingPattern = \/\^##\\s\+\(\?:\\\[\(\?<bracketVersion>/);
  assert.match(releaseNotesScript, /if \(args\.length === 1 && args\[0\] === "--check"\) return \{ check: true \}/);
  assert.match(releaseNotesScript, /if \(options\.check\) return/);
  assert.match(releaseNotesScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseNotesScript, /writeFile\(path\.join\(await verifiedArtifactDir\(\), "RELEASE_NOTES\.md"\), notes, \{ flag: "wx" \}\)/);
  assert.match(securityPolicy, /release checksum, SBOM, and release-notes writers must verify `release-artifacts` is a real directory inside the project root/);
  assert.doesNotMatch(releaseWorkflow, /pack release artifact[\s\S]*(find release-artifacts|basename "\$tgz"|sha256sum)/);
  assert.match(releaseDockerValidateJob, /needs:\n      - verify\n      - platform-smoke/);
  assert.match(releaseDockerValidateJob, /permissions:\n      contents: read/);
  assert.match(releaseDockerValidateJob, /node scripts\/prepare-checked-pnpm\.mjs[\s\S]*Validate release Docker image[\s\S]*DOCKER_SMOKE_TAG=p2p-transfer:release-gate node scripts\/smoke-docker-policy\.mjs/);
  assert.match(releaseDockerJob, /needs:\n      - publish/);
  assert.match(releaseDockerJob, /permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write/);
  assert.match(releaseDockerJob, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0[\s\S]*node-version: 22\.22\.3/);
  assert.match(releaseDockerJob, /node scripts\/prepare-checked-pnpm\.mjs[\s\S]*Build, smoke, and push image[\s\S]*id: docker_image[\s\S]*GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*run: node scripts\/publish-docker-image\.mjs/);
  assert.match(releaseDockerJob, /actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4\.1\.0[\s\S]*subject-name: \$\{\{ steps\.docker_image\.outputs\.image \}\}[\s\S]*subject-digest: \$\{\{ steps\.docker_image\.outputs\.digest \}\}[\s\S]*push-to-registry: true/);
  assert.doesNotMatch(releaseDockerJob, /corepack prepare pnpm@/);
  assert.match(dockerPublishScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(dockerPublishScript, /requiredCommitSha\(requiredEnvString\("GITHUB_SHA"\)\);\n  await assertLiveReleaseRefFromEnv\(\);\n  const actor = githubActor/);
  assert.match(dockerPublishScript, /await run\(process\.execPath, \["scripts\/smoke-docker-policy\.mjs"\], "release docker policy smoke", SMOKE_TIMEOUT_MS,\s+\{\s+env: \{ DOCKER_SMOKE_TAG: versionRef \}/);
  assert.match(dockerPublishScript, /await run\("docker", \["push", versionRef\]/);
  assert.match(dockerPublishScript, /await run\("docker", \["push", plainVersionRef\]/);
  assert.match(dockerPublishScript, /if \(aliasDigest !== digest\) throw new Error\("docker release tag aliases resolved to different digests\."\)/);
  assert.match(dockerPublishScript, /writeGithubOutput\(\{ image, digest, tag: versionRef, alias: plainVersionRef \}\)/);
  assert.match(dockerPublishScript, /createIsolatedDockerConfig\(\)/);
  assert.match(dockerPublishScript, /writeFileSync\(path\.join\(dir, "config\.json"\), JSON\.stringify\(\{ auths: \{\} \}\), \{ mode: 0o600 \}\)/);
  assert.match(securityPolicy, /release Docker publishing must read package metadata through no-follow regular-file opens with exact-size handle reads and pre\/post-read identity checks/);
  assert.match(securityPolicy, /emit the digest through checked `GITHUB_OUTPUT` no-follow regular-file appends with size and identity checks/);
  assert.match(dockerPublishScript, /const MAX_GITHUB_OUTPUT_BYTES = 1024 \* 1024/);
  assert.match(dockerPublishScript, /await open\(file, constants\.O_WRONLY \| constants\.O_APPEND \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(dockerPublishScript, /if \(!opened\.isFile\(\) \|\| !sameFile\(info, opened\)\) throw new Error\("GitHub output path is invalid\."\)/);
  assert.doesNotMatch(dockerPublishScript, /appendFile/);
  assert.match(dockerPublishScript, /package version is not an exact release semver/);
  assert.match(dockerPublishScript, /release tag is not an exact release tag/);
  assert.match(dockerPublishScript, /await lstat\(file\)/);
  assert.match(dockerPublishScript, /await open\(file, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(dockerPublishScript, /if \(!sameFile\(info, opened\)\) throw new Error\("package metadata changed before verification\."\)/);
  assert.match(dockerPublishScript, /const afterRead = await handle\.stat\(\);[\s\S]*if \(!sameFile\(opened, afterRead\)\) throw new Error\("package metadata changed while being read\."\)/);
  assert.match(dockerPublishScript, /\^\(\?:0\|\[1-9\]\\d\*\)\\\.\(\?:0\|\[1-9\]\\d\*\)\\\.\(\?:0\|\[1-9\]\\d\*\)\$/);
  assert.match(dockerPublishScript, /import \{ safeChildEnv \} from "\.\/smoke-packed\.mjs"/);
  assert.match(dockerPublishScript, /env: \{ \.\.\.safeChildEnv\(\), \.\.\.\(options\.env \?\? \{\}\) \}/);
  assert.doesNotMatch(dockerPublishScript, /env: \{ \.\.\.process\.env|DOCKER_HOST|DOCKER_CONTEXT|NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /fetch\('http:\/\/127\.0\.0\.1:8787|body\.includes\('ff transfer'\)/);
  assert.doesNotMatch(releaseWorkflow, /ALLOW_ANY_ORIGIN/);
  assert.equal(releaseWorkflow.match(/id-token:\s*write/g)?.length, 2);
  assert.match(releasePublishJob, /environment: npm/);
  assert.match(releasePublishJob, /permissions:\n      contents: read\n      id-token: write\n      attestations: write/);
  assert.match(releasePublishJob, /verify downloaded release artifact[\s\S]*id: verify_artifact[\s\S]*node scripts\/verify-release-artifact\.mjs --github-output tarball[\s\S]*verify live release ref before attestation[\s\S]*GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*node scripts\/verify-live-release-ref\.mjs[\s\S]*uses: actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4\.1\.0[\s\S]*subject-checksums: release-artifacts\/SHA256SUMS[\s\S]*verify, smoke, and publish release artifact/);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*verify, smoke, and publish release artifact[\s\S]*GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*node scripts\/publish-release-artifact\.mjs/);
  assert.match(releasePublishScript, /rejectStaticNpmTokens\(\)/);
  assert.match(releasePublishScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(releasePublishScript, /assertReleaseTagRef\(tag\);\n  await assertLiveReleaseRefFromEnv\(\);\n  const tmp = await mkdtemp/);
  assert.match(releasePublishScript, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(releasePublishScript, /isolatedChildEnv\(privateHome\)/);
  assert.match(releasePublishScript, /PACKED_SMOKE_TARBALL: tarball/);
  assert.match(releasePublishScript, /const NPM_REGISTRY = "https:\/\/registry\.npmjs\.org"/);
  assert.match(releasePublishScript, /\["publish", tarball, "--provenance", "--access", "public", "--registry", NPM_REGISTRY, "--tag", "latest", "--ignore-scripts"\]/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*needs:\n      - publish\n      - docker[\s\S]*permissions:\n      contents: write[\s\S]*node scripts\/create-github-release\.mjs/);
  assert.match(githubReleaseScript, /requiredReleaseTag\(requiredEnvString\("GITHUB_REF_NAME"\)\)/);
  assert.match(githubReleaseScript, /const sha = requiredCommitSha\(requiredEnvString\("GITHUB_SHA"\)\)/);
  assert.match(githubReleaseScript, /const API = "https:\/\/api\.github\.com"/);
  assert.match(githubReleaseScript, /const token = requiredEnvString\("GH_TOKEN"\)/);
  assert.match(githubReleaseScript, /import \{ assertLiveReleaseRefFromEnv \} from "\.\/verify-live-release-ref\.mjs"/);
  assert.match(githubReleaseScript, /const token = requiredEnvString\("GH_TOKEN"\);\n  await assertLiveReleaseRefFromEnv\(\);\n  const tmp = await mkdtemp/);
  assert.match(githubReleaseScript, /verifiedTarballPath\(\{ \.\.\.childEnv, GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs\/tags\/\$\{tag\}` \}\)/);
  assert.match(githubReleaseScript, /\/repos\/\$\{repository\}\/git\/ref\/tags\/\$\{tag\}/);
  assert.match(githubReleaseScript, /if \(\(await githubReleaseTagCommitSha\(token, repository, tag\)\) !== expectedSha\) throw new Error\("GitHub tag ref does not match the release workflow commit\."\)/);
  assert.match(liveReleaseRefScript, /export async function assertLiveReleaseRefFromEnv\(\)/);
  assert.match(liveReleaseRefScript, /\/repos\/\$\{repository\}\/git\/ref\/tags\/\$\{tag\}/);
  assert.match(liveReleaseRefScript, /\/repos\/\$\{repository\}\/git\/ref\/heads\/main/);
  assert.match(liveReleaseRefScript, /GitHub tag ref does not match the release workflow commit\./);
  assert.match(liveReleaseRefScript, /GitHub main branch does not match the release workflow commit\./);
  assert.match(liveReleaseRefScript, /return error instanceof Error && error\.name === "AbortError"/);
  assert.match(securityPolicy, /last-mile live release-ref verifier must re-check the GitHub tag ref or annotated tag object and GitHub `main` ref against `GITHUB_SHA` through bounded GitHub API calls immediately before release artifact attestation, before npm publish, and before Docker smoke or GHCR push/);
  assert.match(securityPolicy, /Docker publishing subprocesses must use a minimal allowlisted child environment plus a temporary 0700 `DOCKER_CONFIG`/);
  assert.match(githubReleaseScript, /\/repos\/\$\{repository\}\/releases/);
  assert.match(githubReleaseScript, /uploadReleaseAsset\(token, uploadUrl, asset\)/);
  assert.match(githubReleaseScript, /draft: true/);
  assert.match(githubReleaseScript, /await github\(token, "PATCH", `\/repos\/\$\{repository\}\/releases\/\$\{id\}`, \{ draft: false \}\)/);
  assert.match(githubReleaseScript, /await deleteDraftRelease\(token, repository, id\)\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(githubReleaseScript, /"gh"|gh release create|"--verify-tag"/);
  assert.match(githubReleaseScript, /requiredRepository\(requiredEnvString\("GITHUB_REPOSITORY"\)\)/);
  assert.match(githubReleaseScript, /\["scripts\/write-release-notes\.mjs"\]/);
  assert.match(githubReleaseScript, /await createGitHubRelease\(token, repository, tag, sha, notes, assets\)/);
  assert.match(githubReleaseScript, /await readArtifactFile\(tarball, 50 \* 1024 \* 1024, "release tarball"\)/);
  assert.match(githubReleaseScript, /while \(offset < opened\.size\) \{[\s\S]*await handle\.read\(bytes, offset, opened\.size - offset, offset\)[\s\S]*offset \+= bytesRead/);
  assert.match(githubReleaseScript, /await readArtifactFile\("release-artifacts\/SHA256SUMS", MAX_CHECKSUM_BYTES, "SHA256SUMS"\)/);
  assert.match(githubReleaseScript, /await readArtifactFile\("release-artifacts\/SBOM\.cdx\.json", MAX_SBOM_BYTES, "release SBOM"\)/);
  assert.match(githubReleaseScript, /const afterRead = await handle\.stat\(\);[\s\S]*if \(!sameFile\(opened, afterRead\)\) throw new Error\(`\$\{description\} changed while being read\.`\)/);
  assert.match(githubReleaseScript, /assetNames\.filter\(\(name\) => name\.endsWith\("\.tgz"\)\)\.length !== 1/);
  assert.match(githubReleaseScript, /!assetNames\.includes\("SHA256SUMS"\) \|\| !assetNames\.includes\("SBOM\.cdx\.json"\)/);
  assert.match(githubReleaseScript, /assertReleaseAssetChecksums\(assets\)/);
  assert.match(githubReleaseScript, /function assertReleaseAssetChecksums\(assets\) \{[\s\S]*SHA256SUMS[\s\S]*SBOM\.cdx\.json[\s\S]*sha256Hex\(tarball\.bytes\)[\s\S]*sha256Hex\(sbom\.bytes\)/);
  assert.doesNotMatch(releaseWorkflow, /--notes-file CHANGELOG\.md/);
  assert.doesNotMatch(releaseWorkflow, /tgz="\$\(node scripts\/verify-release-artifact\.mjs --print-tarball\)"|printf 'tarball=%s\\n'|test -f "\$tgz"|PACKED_SMOKE_TARBALL="\$tgz" node scripts\/smoke-packed\.mjs|pnpm publish "\$tgz"|gh release create "\$GITHUB_REF_NAME"/);
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  publish:"));
  assert.match(publishJob, /needs:\n      - verify\n      - platform-smoke\n      - docker-validate/);
  assert.doesNotMatch(publishJob, /pnpm install|pnpm build|pnpm smoke:native/);
  assert.match(releasePublishScript, /"--ignore-scripts"/);
  assert.match(releasePublishScript, /verifiedTarballPath\(\{ \.\.\.childEnv, \.\.\.releaseVerifierEnv\(tag\) \}\)/);
  assert.match(releasePublishScript, /function releaseVerifierEnv\(tag\) \{[\s\S]*GITHUB_REF_NAME: tag[\s\S]*GITHUB_REF_TYPE: "tag"[\s\S]*GITHUB_REF: `refs\/tags\/\$\{tag\}`/);
  assert.doesNotMatch(releasePublishScript, /verifiedTarballPath\(\{ \.\.\.childEnv, GITHUB_REF_NAME: tag \}\)/);
  assert.doesNotMatch(publishJob, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("checked GitHub release controls setup matches the protected release surface", () => {
  assert.match(githubReleaseControlsScript, /const MAIN_RULESET_NAME = "p2p-transfer: protect main"/);
  assert.match(githubReleaseControlsScript, /const TAG_RULESET_NAME = "p2p-transfer: protect release tags"/);
  assert.match(githubReleaseControlsScript, /const NPM_ENVIRONMENT = "npm"/);
  assert.doesNotMatch(githubReleaseControlsScript, /REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID|RepositoryRole/);
  assert.doesNotMatch(releaseReadinessScript, /REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID|RepositoryRole|admin bypass policy is not configured/);
  assert.match(githubReleaseControlsScript, /const GITHUB_ACTIONS_INTEGRATION_ID = 15368/);
  assert.match(releaseReadinessScript, /const GITHUB_ACTIONS_INTEGRATION_ID = 15368/);
  assert.match(githubReleaseControlsScript, /const MAX_NPM_ENVIRONMENT_REVIEWERS = 6/);
  assert.match(githubReleaseControlsScript, /const MAX_ENV_VALUE_BYTES = 4_096/);
  assert.match(githubReleaseControlsScript, /function githubToken\(\)/);
  assert.match(githubReleaseControlsScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(githubReleaseControlsScript, /\$\{name\} must be a non-empty control-free string under/);
  assert.doesNotMatch(githubReleaseControlsScript, /process\.env\.GITHUB_TOKEN|process\.env\.GH_TOKEN|process\.env\.GITHUB_REPOSITORY/);
  assert.match(githubReleaseControlsScript, /const authenticatedLogin = requiredAuthenticatedLogin\(await github\(token, "GET", "\/user"\)\)/);
  assert.match(githubReleaseControlsScript, /assertNoSelfReviewDeadlock\(options\.npmReviewers, authenticatedLogin\)/);
  assert.match(githubReleaseControlsScript, /assertEnvironmentDoesNotSelfReviewDeadlock\(environment, authenticatedLogin\)/);
  assert.ok(
    githubReleaseControlsScript.indexOf("class GitHubApiError") < githubReleaseControlsScript.indexOf("if (isMain())"),
    "GitHub API errors must be initialized before the direct entrypoint can run"
  );
  assert.match(githubReleaseControlsScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(githubReleaseControlsScript, /endsWith\("\/configure-github-release-controls\.mjs"\)/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{options\.repository\}\/rulesets\/\$\{existing\.id\}`/);
  assert.match(githubReleaseControlsScript, /const existingByName = existingRulesetsByName\(existingRulesets\)/);
  assert.match(githubReleaseControlsScript, /function existingRulesetsByName\(rulesets\)/);
  assert.match(githubReleaseControlsScript, /if \(!Array\.isArray\(rulesets\)\) throw new Error\("GitHub rulesets response was invalid\."\)/);
  assert.match(githubReleaseControlsScript, /typeof ruleset\.name !== "string" \|\| typeof ruleset\.id !== "number" \|\| typeof ruleset\.target !== "string"/);
  assert.match(githubReleaseControlsScript, /const expectedTargets = new Map\(\[/);
  assert.match(githubReleaseControlsScript, /if \(expectedTarget === undefined\) throw new Error\("GitHub rulesets response contained an unexpected ruleset\."\)/);
  assert.match(githubReleaseControlsScript, /if \(ruleset\.target !== expectedTarget\) throw new Error\("GitHub rulesets response contained an unexpected ruleset target\."\)/);
  assert.match(githubReleaseControlsScript, /if \(byName\.has\(ruleset\.name\)\) throw new Error\("GitHub rulesets response contained duplicate names\."\)/);
  assert.doesNotMatch(githubReleaseControlsScript, /new Map\(Array\.isArray\(existingRulesets\) \? existingRulesets\.map/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{options\.repository\}\/environments\/\$\{encodeURIComponent\(NPM_ENVIRONMENT\)\}`/);
  assert.match(githubReleaseControlsScript, /reviewers: await Promise\.all\(options\.npmReviewers\.map\(async \(login\) => \(\{ type: "User", id: await npmReviewerUserId\(token, options\.repository, login\) \}\)\)\)/);
  assert.match(githubReleaseControlsScript, /const NPM_DEPLOYMENT_TAG_POLICY = "v\*\.\*\.\*"/);
  assert.match(githubReleaseControlsScript, /const RELEASE_TAG_REF_PATTERN = `refs\/tags\/\$\{NPM_DEPLOYMENT_TAG_POLICY\}`/);
  assert.match(githubReleaseControlsScript, /conditions: \{ ref_name: \{ include: \[RELEASE_TAG_REF_PATTERN\], exclude: \[\] \} \}/);
  assert.match(githubReleaseControlsScript, /can_admins_bypass: false/);
  assert.match(githubReleaseControlsScript, /prevent_self_review: true/);
  assert.match(githubReleaseControlsScript, /deployment_branch_policy: \{ protected_branches: false, custom_branch_policies: true \}/);
  assert.match(githubReleaseControlsScript, /await ensureNpmDeploymentPolicy\(token, options\.repository\)/);
  assert.match(githubReleaseControlsScript, /environment = await github\(token, "GET", `\/repos\/\$\{options\.repository\}\/environments\/\$\{encodeURIComponent\(NPM_ENVIRONMENT\)\}`\)/);
  assert.match(githubReleaseControlsScript, /const verifiedEnvironmentStatus = environmentStatus\(environment\)/);
  assert.match(githubReleaseControlsScript, /assertNpmEnvironmentStatus\(verifiedEnvironmentStatus\)/);
  assert.match(githubReleaseControlsScript, /assertNpmDeploymentPolicies\(await github\(token, "GET", `\/repos\/\$\{options\.repository\}\/environments\/\$\{encodeURIComponent\(NPM_ENVIRONMENT\)\}\/deployment-branch-policies\?per_page=100`\)\)/);
  assert.match(githubReleaseControlsScript, /function ensureNpmDeploymentPolicy\(token, repository\)/);
  assert.match(githubReleaseControlsScript, /function assertNpmDeploymentPolicies\(response\)/);
  assert.match(githubReleaseControlsScript, /deployment-branch-policies\?per_page=100/);
  assert.match(githubReleaseControlsScript, /\{ name: NPM_DEPLOYMENT_TAG_POLICY, type: "tag" \}/);
  assert.match(githubReleaseControlsScript, /function deploymentPoliciesByName\(response\)/);
  assert.match(githubReleaseControlsScript, /GitHub deployment branch policies response contained duplicate names/);
  assert.doesNotMatch(githubReleaseControlsScript, /prevent_self_review: options\.preventSelfReview|preventSelfReview: false|options\.preventSelfReview = false/);

  for (const check of [
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
  ]) {
    assert.match(githubReleaseControlsScript, new RegExp(escapeRegExp(`"${check}"`)));
  }

  assert.match(githubReleaseControlsScript, /conditions: \{ ref_name: \{ include: \["refs\/heads\/main"\], exclude: \[\] \} \}/);
  assert.match(githubReleaseControlsScript, /conditions: \{ ref_name: \{ include: \[RELEASE_TAG_REF_PATTERN\], exclude: \[\] \} \}/);
  assert.match(githubReleaseControlsScript, /type: "pull_request"[\s\S]*require_code_owner_review: true[\s\S]*require_last_push_approval: true[\s\S]*required_approving_review_count: 1[\s\S]*required_review_thread_resolution: true/);
  assert.match(githubReleaseControlsScript, /type: "required_status_checks"[\s\S]*do_not_enforce_on_create: true[\s\S]*strict_required_status_checks_policy: true[\s\S]*required_status_checks: REQUIRED_CI_CHECKS\.map\(\(context\) => \(\{ context, integration_id: GITHUB_ACTIONS_INTEGRATION_ID \}\)\)/);
  assert.match(githubReleaseControlsScript, /bypass_actors: \[\]/);
  assert.match(githubReleaseControlsScript, /type: "deletion"[\s\S]*type: "non_fast_forward"/);
  assert.doesNotMatch(githubReleaseControlsScript, /type: "creation"/);
  assert.doesNotMatch(githubReleaseControlsScript, /tag_name_pattern/);
  assert.match(releaseWorkflow, /^on:\n  push:\n    tags:\n      - "v\*\.\*\.\*"$/m);
  assert.match(githubReleaseControlsScript, /Push main before applying GitHub release controls\./);
  assert.match(githubReleaseControlsScript, /options\.apply && !options\.requireMain[\s\S]*--allow-missing-main is only allowed with --dry-run/);
  assert.match(githubReleaseControlsScript, /\[--dry-run --allow-missing-main\]/);
  assert.match(githubReleaseControlsScript, /The npm environment exists but has no required reviewers protection rule\./);
  assert.match(githubReleaseControlsScript, /The npm environment must prevent self-review\./);
  assert.match(githubReleaseControlsScript, /The npm environment must disable admin bypass\./);
  assert.match(githubReleaseControlsScript, /The npm environment must restrict deployments to custom policies\./);
  assert.match(githubReleaseControlsScript, /function requiredAuthenticatedLogin\(user\)/);
  assert.match(githubReleaseControlsScript, /Authenticated GitHub user response was invalid\./);
  assert.match(githubReleaseControlsScript, /function assertNoSelfReviewDeadlock\(reviewers, authenticatedLogin\)/);
  assert.match(githubReleaseControlsScript, /Npm environment sole reviewer must not be the authenticated release setup operator\./);
  assert.match(githubReleaseControlsScript, /async function npmReviewerUserId\(token, repository, login\)/);
  assert.match(githubReleaseControlsScript, /async function assertNpmReviewerCanApprove\(token, repository, login\)/);
  assert.match(githubReleaseControlsScript, /\/repos\/\$\{repository\}\/collaborators\/\$\{encodeURIComponent\(login\)\}\/permission/);
  assert.match(githubReleaseControlsScript, /Npm environment reviewer must be a repository collaborator with write, maintain, or admin permission\./);
  assert.match(githubReleaseControlsScript, /Npm environment reviewer must have write, maintain, or admin repository permission\./);
  assert.match(githubReleaseControlsScript, /function assertEnvironmentDoesNotSelfReviewDeadlock\(environment, authenticatedLogin\)/);
  assert.match(githubReleaseControlsScript, /The npm environment sole required reviewer is the authenticated release setup operator\./);
  assert.match(githubReleaseControlsScript, /async function assertPersistedNpmEnvironmentApproverPermissions\(token, repository, environment, authenticatedLogin\)/);
  assert.match(githubReleaseControlsScript, /GitHub npm environment must include at least one non-self user reviewer with write, maintain, or admin repository permission\./);
  assert.match(githubReleaseControlsScript, /function npmEnvironmentUserReviewerLogins\(environment\)/);
  assert.match(githubReleaseControlsScript, /GitHub npm environment must include at least one user reviewer with write, maintain, or admin repository permission\./);
  assert.match(githubReleaseControlsScript, /function reviewerLogin\(reviewerEntry\)/);
  assert.match(githubReleaseControlsScript, /--npm-reviewer/);
  assert.match(githubReleaseControlsScript, /--prevent-self-review/);
  assert.match(githubReleaseControlsScript, /GitHub npm environment self-review must stay disabled\./);
  assert.doesNotMatch(githubReleaseControlsScript, /\[--prevent-self-review\|--allow-self-review\]|options\.preventSelfReview/);
  assert.match(githubReleaseControlsScript, /Npm environment reviewer must be a GitHub username\./);
  assert.match(githubReleaseControlsScript, /npmReviewerKeys: new Set\(\)/);
  assert.match(githubReleaseControlsScript, /const reviewerKey = value\.toLowerCase\(\)/);
  assert.match(githubReleaseControlsScript, /if \(options\.npmReviewerKeys\.has\(reviewerKey\)\) throw new Error\("Npm environment reviewers must be unique\."\)/);
  assert.match(githubReleaseControlsScript, /delete options\.npmReviewerKeys/);
  assert.match(githubReleaseControlsScript, /Npm environment reviewers must be unique\./);
  assert.match(githubReleaseControlsScript, /Npm environment can have at most \$\{MAX_NPM_ENVIRONMENT_REVIEWERS\} reviewers\./);
  assert.match(githubReleaseControlsScript, /await assertPersistedRulesets\(token, options\.repository\)/);
  assert.match(githubReleaseControlsScript, /privateVulnerabilityReportingStatus\(token, options\.repository\)/);
  assert.match(githubReleaseControlsScript, /await ensurePrivateVulnerabilityReporting\(token, options\.repository, privateVulnerabilityReporting\)/);
  assert.match(githubReleaseControlsScript, /\/repos\/\$\{repository\}\/private-vulnerability-reporting/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{repository\}\/private-vulnerability-reporting`/);
  assert.match(githubReleaseControlsScript, /GitHub private vulnerability reporting must be enabled\./);
  assert.match(githubReleaseControlsScript, /const verifiedRepositorySecurity = await ensureRepositorySecurity\(token, options\.repository, repositorySecurity\)/);
  assert.match(githubReleaseControlsScript, /async function ensureRepositorySecurity\(token, repository, status\)/);
  assert.match(githubReleaseControlsScript, /"PATCH", `\/repos\/\$\{repository\}`/);
  assert.match(githubReleaseControlsScript, /secret_scanning: \{ status: "enabled" \}/);
  assert.match(githubReleaseControlsScript, /secret_scanning_push_protection: \{ status: "enabled" \}/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{repository\}\/automated-security-fixes`/);
  assert.match(githubReleaseControlsScript, /assertRepositorySecurityStatus\(repositorySecurityStatus\(await github\(token, "GET", `\/repos\/\$\{repository\}`\)\)\)/);
  assert.match(githubReleaseControlsScript, /GitHub repository secret scanning must be enabled\./);
  assert.match(githubReleaseControlsScript, /GitHub repository secret scanning push protection must be enabled\./);
  assert.match(githubReleaseControlsScript, /GitHub repository Dependabot security updates must be enabled\./);
  assert.match(githubReleaseControlsScript, /async function assertPersistedRulesets\(token, repository\)/);
  assert.match(githubReleaseControlsScript, /assertMainRuleset\(await github\(token, "GET", `\/repos\/\$\{repository\}\/rulesets\/\$\{mainRuleset\.id\}`\)\)/);
  assert.match(githubReleaseControlsScript, /assertTagRuleset\(await github\(token, "GET", `\/repos\/\$\{repository\}\/rulesets\/\$\{tagRuleset\.id\}`\)\)/);
  assert.match(githubReleaseControlsScript, /function assertMainRuleset\(ruleset\)/);
  assert.match(githubReleaseControlsScript, /function assertTagRuleset\(ruleset\)/);
  assert.match(githubReleaseControlsScript, /assertRulesetBase\(ruleset, MAIN_RULESET_NAME, "branch", "refs\/heads\/main"\)/);
  assert.match(githubReleaseControlsScript, /assertRulesetBase\(ruleset, TAG_RULESET_NAME, "tag", RELEASE_TAG_REF_PATTERN\)/);
  assert.match(githubReleaseControlsScript, /assertStatusContexts\(statusParameters\.required_status_checks, REQUIRED_CI_CHECKS, MAIN_RULESET_NAME\)/);
  assert.ok(
    githubReleaseControlsScript.indexOf("environments/${encodeURIComponent(NPM_ENVIRONMENT)}") <
      githubReleaseControlsScript.indexOf("for (const ruleset of desired)"),
    "npm environment setup must run before mutating rulesets"
  );
  assert.ok(
      githubReleaseControlsScript.indexOf("The npm environment exists but has no required reviewers protection rule") <
      githubReleaseControlsScript.indexOf("for (const ruleset of desired)"),
    "npm environment reviewer protection must be checked before mutating rulesets"
  );
  assert.ok(
    githubReleaseControlsScript.indexOf("await ensurePrivateVulnerabilityReporting(token, options.repository, privateVulnerabilityReporting)") <
      githubReleaseControlsScript.indexOf("if (desiredEnvironment)"),
    "private vulnerability reporting must be enabled before mutating the npm environment"
  );
  assert.ok(
    githubReleaseControlsScript.indexOf("const verifiedRepositorySecurity = await ensureRepositorySecurity(token, options.repository, repositorySecurity)") <
      githubReleaseControlsScript.indexOf("if (desiredEnvironment)"),
    "repository security controls must be enabled before mutating the npm environment"
  );

  assert.match(readme, /create the `npm` environment[\s\S]*required reviewers with self-review prevention/);
  assert.match(readme, /reviewer with write, maintain, or admin repository permission/);
  assert.match(readme, /scripts\/configure-github-release-controls\.mjs --apply --npm-reviewer <release-approver-login>/);
  assert.match(readme, /creates\/updates the `npm` environment approval gate with self-review prevention, admin bypass disabled, and `v\*\.\*\.\*` tag-only deployment/);
  assert.match(readme, /release tags with no bypass actors/);
  assert.match(readme, /refuses read-only or unknown reviewers/);
  assert.match(readme, /refuses to create a sole-reviewer self-approval deadlock/);
  assert.match(readme, /refuses `--allow-missing-main` outside dry-run mode/);
  assert.match(readme, /re-reads the persisted repository security controls, `npm` environment, persisted reviewer permissions, deployment tag policy, and repository ruleset details after writes/);
  assert.match(readme, /refuses to mutate deployment policies or repository rulesets if GitHub returns a persisted reviewer without write, maintain, or admin permission/);
  assert.match(readme, /refuses to mutate repository rulesets if GitHub returns malformed, duplicate, unexpected, wrong-target, or bypass-enabled rulesets, or if the persisted repository security controls are still disabled, the persisted `npm` environment still has no required-reviewer protection/);
  assert.match(securityPolicy, /`--allow-missing-main` must be dry-run only and must not be accepted with `--apply`/);
  assert.match(securityPolicy, /the setup script must enable and re-read GitHub private vulnerability reporting and repository secret scanning, secret scanning push protection, and Dependabot security updates before mutating the npm environment, deployment policies, or repository rulesets/);
  assert.match(securityPolicy, /must be able to create or update the `npm` environment approval gate from explicit reviewers with write, maintain, or admin repository permission, self-review prevention, admin bypass disabled, and a single `v\*\.\*\.\*` tag deployment policy/);
  assert.match(securityPolicy, /must not expose an option that writes `prevent_self_review: false`/);
  assert.match(securityPolicy, /release setup must create branch and tag rulesets with no bypass actors/);
  assert.match(securityPolicy, /release setup must reject malformed, unexpected, wrong-target, duplicate, or bypass-enabled GitHub rulesets list entries/);
  assert.match(securityPolicy, /setup script must reject unknown or read-only reviewers and sole-reviewer self-approval deadlocks/);
  assert.match(securityPolicy, /release setup must re-read the persisted repository security controls, `npm` environment, plus persisted reviewer permissions and fail before mutating deployment policies or repository rulesets when repository secret scanning, secret scanning push protection, or Dependabot security updates are not enabled/);
  assert.match(securityPolicy, /release setup must re-read the persisted deployment tag policy and fail before mutating repository rulesets when the `npm` environment lacks the exact release-tag deployment policy/);
  assert.match(securityPolicy, /release setup must re-read persisted repository ruleset details after writes and fail before reporting success when GitHub drops, broadens, weakens, bypass-enables, or otherwise normalizes branch\/tag rulesets away from the exact protected surface/);
  assert.match(securityPolicy, /GitHub release setup and release preflight scripts must read token, repository, GitHub Actions mode, and release actor environment variables through own data descriptors[\s\S]*send GitHub API requests with an abort deadline/);
  assert.match(securityPolicy, /release preflight must reject malformed GitHub token, `GITHUB_ACTIONS`, or Actions-only `GITHUB_ACTOR` values before package reads, npm registry requests, or GitHub API requests/);
  assert.match(securityPolicy, /byte-cap and fatal-UTF-8\/JSON-decode GitHub API responses with setup-owned deterministic errors/);
  assert.match(securityPolicy, /avoid echoing token, malformed environment values, remote response messages, or raw API response bodies in errors/);
  assert.match(releaseReadinessScript, /const token = githubToken\(\);[\s\S]*const runningInGitHubActions = envString\("GITHUB_ACTIONS"\) === "true";[\s\S]*assertReleaseWorkflowTokenClass\(token, runningInGitHubActions\);[\s\S]*const releaseActorLogin = runningInGitHubActions \? githubActor\(\) : undefined;[\s\S]*const failures = \[\];[\s\S]*readPackageMetadata\(\)/);
  assert.doesNotMatch(releaseReadinessScript, /collectReadinessValue\(failures, \(\) => githubToken\(\)\)/);
  assert.match(securityPolicy, /release setup must reject malformed, unexpected, wrong-target, duplicate, or bypass-enabled GitHub rulesets list entries before deciding whether to create or update rulesets/);
  assert.match(githubReleaseControlsScript, /const GITHUB_API_TIMEOUT_MS = 30_000/);
  assert.match(githubReleaseControlsScript, /const MAX_GITHUB_API_RESPONSE_BYTES = 1024 \* 1024/);
  assert.match(githubReleaseControlsScript, /const controller = new AbortController\(\)/);
  assert.match(githubReleaseControlsScript, /const timer = setTimeout\(\(\) => controller\.abort\(\), GITHUB_API_TIMEOUT_MS\)/);
  assert.match(githubReleaseControlsScript, /signal: controller\.signal/);
  assert.match(githubReleaseControlsScript, /clearTimeout\(timer\)/);
  assert.match(githubReleaseControlsScript, /GitHub API request timed out\./);
  assert.match(githubReleaseControlsScript, /async function boundedGithubResponseText\(response\)/);
  assert.match(githubReleaseControlsScript, /if \(total > MAX_GITHUB_API_RESPONSE_BYTES\) throw new Error\("GitHub API response exceeded the byte limit\."\)/);
  assert.match(githubReleaseControlsScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(body\)/);
  assert.match(githubReleaseControlsScript, /GitHub API response was not valid JSON\./);
  assert.match(githubReleaseControlsScript, /function githubApiErrorMessage\(status\) \{[\s\S]*return `GitHub API returned \$\{status\}\.`;[\s\S]*\}/);
  assert.doesNotMatch(githubReleaseControlsScript, /data\.message|GitHub API returned \$\{status\}:/);
  assert.doesNotMatch(githubReleaseControlsScript, /response\.text\(\)/);
});

test("release preflight checks external GitHub release prerequisites", () => {
  assert.equal(packageJson.scripts?.["release:preflight"], "node scripts/check-release-readiness.mjs");
  assert.equal(packageJson.scripts?.["bootstrap:npm"], "node scripts/bootstrap-npm-package.mjs");
  assert.match(readme, /gh auth refresh -h github\.com -s workflow/);
  assert.match(readme, /node scripts\/write-release-notes\.mjs --check\nDOCKER_SMOKE_TAG=p2p-transfer:test pnpm smoke:docker-policy/);
  assert.match(readme, /First remote bootstrap:[\s\S]*gh auth refresh -h github\.com -s workflow\ngit push -u origin main/);
  assert.match(readme, /git fetch origin main\ngit tag v0\.1\.0 origin\/main/);
  assert.match(readme, /`main` must exist remotely before `pnpm release:preflight` can pass/);
  assert.match(readme, /The first push needs a GitHub token with `workflow` scope because this repository ships GitHub Actions workflow files/);
  assert.match(readme, /Once those controls are active, do not direct-push release changes to `main`/);
  assert.match(readme, /For normal releases, fetch `origin\/main` and tag that exact remote commit after the protected pull request has merged/);
  assert.doesNotMatch(readme, /git push -u origin main\nGITHUB_TOKEN="\$\(gh auth token\)" pnpm release:preflight/);
  assert.match(readme, /the exact repository rulesets that release preflight requires for `main` and `v\*\.\*\.\*` release tags/);
  assert.match(readme, /checked release-control setup enables it with the GitHub `private-vulnerability-reporting` endpoint/);
  assert.match(readme, /release preflight verifies that endpoint reports enabled before tagging/);
  assert.match(readme, /checked release-control setup enables and re-reads those repository security controls/);
  assert.match(readme, /release preflight reads GitHub `security_and_analysis` plus the `automated-security-fixes` endpoint so tagging fails if any feature is disabled, paused, or hidden from the release token/);
  assert.match(readme, /read repository metadata including `security_and_analysis`, private vulnerability reporting status, the `main` branch, Actions secret metadata, Actions workflow run metadata, repository rulesets including bypass actors, repository environments, and deployment branch policies/);
  assert.match(readme, /verifies private vulnerability reporting is enabled/);
  assert.match(readme, /The checked repository ruleset for `v\*\.\*\.\*` tags must be active before the first release/);
  assert.doesNotMatch(readme, /create branch protection for `main`|tag protection rule or repository ruleset/);
  assert.match(readme, /GITHUB_TOKEN="\$\(gh auth token\)" pnpm release:preflight/);
  assert.match(contributing, /pnpm exec playwright install --with-deps chromium\npnpm verify:release\nnode scripts\/write-release-notes\.mjs --check\nDOCKER_SMOKE_TAG=p2p-transfer:test pnpm smoke:docker-policy\ngh auth refresh -h github\.com -s workflow\nGITHUB_TOKEN="\$\(gh auth token\)" pnpm release:preflight/);
  assert.match(contributing, /make sure `main` already exists on\nGitHub, then run the full release gate/);
  assert.match(securityPolicy, /local release preflight must fail before tagging when the npm package is missing, the target npm version already exists, the bootstrap placeholder exists without the exact `bootstrap` dist-tag or with `latest` pointing to it, private vulnerability reporting is disabled/);
  assert.match(securityPolicy, /GitHub repository `security_and_analysis` is missing or reports disabled secret scanning, disabled secret scanning push protection, disabled Dependabot security updates, or paused Dependabot security updates from the dedicated `automated-security-fixes` endpoint/);
  assert.match(securityPolicy, /the GitHub token is missing or lacks `workflow` scope/);
  assert.match(securityPolicy, /current `main` commit lacks a successful CodeQL, Scorecard, or dependency-integrity workflow run/);
  assert.match(securityPolicy, /the `RELEASE_PREFLIGHT_TOKEN` repository secret is missing/);
  assert.match(securityPolicy, /GitHub `npm` environment lacks required reviewers, lacks a non-self user reviewer with write, maintain, or admin repository permission, allows self-review, allows admin bypass, allows branch deployments, lacks the exact `v\*\.\*\.\*` tag deployment policy, or has the authenticated release operator or release tag pusher as its sole required reviewer/);
  assert.match(securityPolicy, /first-time npm package bootstrap must use the checked bootstrap script, publish only the minimal temporary `0\.0\.0-bootstrap\.0` package from a private temporary directory under the non-default `bootstrap` dist-tag/);
  assert.match(securityPolicy, /re-read npm registry metadata after publish and fail unless the bootstrap version exists, the `bootstrap` dist-tag points to it, and `latest` does not point to it/);
  assert.match(securityPolicy, /require `--apply` plus either an explicit `NPM_BOOTSTRAP_TOKEN` or bounded `--token-stdin` input/);
  assert.match(securityPolicy, /reject interactive terminal stdin for `--token-stdin`/);
  assert.match(securityPolicy, /reject ambiguous stdin-plus-environment token input, reject malformed stdin tokens before package reads, registry requests, npm config, or publish work/);
  assert.match(securityPolicy, /must not mutate workspace package metadata, publish the real release artifact, publish a placeholder as `latest`, or appear in the trusted release workflow/);
  assert.match(securityPolicy, /reject and clear control-bearing or over-budget bootstrap token environment values/);
  assert.match(securityPolicy, /reject ambient npm credential, registry, and userconfig environment values before package reads, registry requests, npm config, or publish work/);
  assert.match(securityPolicy, /branch\/tag rulesets have ref exclusions, unexpected or duplicate rules, or any bypass actors/);
  assert.match(securityPolicy, /release workflow preflight must run before dependency install through the checked Node script with an explicit `RELEASE_PREFLIGHT_TOKEN` secret/);
  assert.match(securityPolicy, /repository-administration\/ruleset, private-vulnerability-reporting, repository security-analysis, Dependabot security-update status, and Actions workflow-run visibility/);
  assert.match(securityPolicy, /must reject missing GitHub tokens, classic PAT, OAuth, refresh, user, or unknown-prefix token classes in GitHub Actions before package or network work/);
  assert.match(securityPolicy, /must validate `GITHUB_ACTOR` before package reads or network work after token-class validation/);
  assert.match(securityPolicy, /must still verify the npm package exists without the target version, any bootstrap placeholder is not `latest`, private vulnerability reporting is enabled, repository secret scanning, push protection, and Dependabot security updates are enabled and unpaused/);
  assert.match(releaseReadinessScript, /\/repos\/\$\{repository\}\/automated-security-fixes/);
  assert.match(releaseReadinessScript, /GitHub repository Dependabot security updates must not be paused\./);
  assert.match(securityPolicy, /no branch\/tag bypass actors, required status checks, and the npm environment approval\/tag-only deployment gate before packaging/);
  assert.match(readme, /verifies the npm package already exists, verifies any bootstrap placeholder is not tagged as `latest`, verifies the target version has not been published, verifies private vulnerability reporting is enabled, verifies repository secret scanning, secret scanning push protection, and Dependabot security updates are enabled/);
  assert.match(readme, /pnpm bootstrap:npm --dry-run/);
  assert.match(readme, /read -rs NPM_BOOTSTRAP_TOKEN\nprintf %s "\$NPM_BOOTSTRAP_TOKEN" \| pnpm bootstrap:npm --apply --token-stdin\nunset NPM_BOOTSTRAP_TOKEN/);
  assert.match(readme, /The helper publishes only a minimal temporary `0\.0\.0-bootstrap\.0` package from a private temp directory under the non-default `bootstrap` dist-tag/);
  assert.match(readme, /then re-reads npm registry metadata and fails unless that version exists, the `bootstrap` dist-tag points to it, and `latest` does not/);
  assert.match(readme, /accepts the one-time token through bounded piped stdin with `--token-stdin`/);
  assert.match(readme, /rejects interactive terminal stdin instead of waiting for a typed token/);
  assert.match(readme, /does not publish the placeholder as `latest`/);
  assert.match(readme, /ensure the `npm` environment has at least one reviewer with write, maintain, or admin repository permission other than the person or token owner that will push the release tag/);
  assert.doesNotMatch(releaseWorkflow, /bootstrap-npm-package|bootstrap:npm|NPM_BOOTSTRAP_TOKEN/);
  assert.match(npmBootstrapScript, /const BOOTSTRAP_VERSION = "0\.0\.0-bootstrap\.0"/);
  assert.match(npmBootstrapScript, /const BOOTSTRAP_DIST_TAG = "bootstrap"/);
  assert.match(npmBootstrapScript, /const EXPECTED_REPOSITORY_URL = "git\+https:\/\/github\.com\/VictorHaine\/p2p-transfer\.git"/);
  assert.match(npmBootstrapScript, /if \(workspace\.version === BOOTSTRAP_VERSION\) throw new Error\("workspace package version must not be the bootstrap version\."\)/);
  assert.match(npmBootstrapScript, /if \(await npmPackageExists\(workspace\.name\)\) throw new Error\("npm package already exists; do not run bootstrap\."\)/);
  assert.match(npmBootstrapScript, /if \(!options\.apply\) \{/);
  assert.match(npmBootstrapScript, /const token = options\.apply \? await bootstrapToken\(options\) : undefined/);
  assert.match(npmBootstrapScript, /args\.length === 2 && args\.includes\("--apply"\) && args\.includes\("--token-stdin"\)/);
  assert.match(npmBootstrapScript, /function readStdinToken\(\)/);
  assert.match(npmBootstrapScript, /if \(envString\("NPM_BOOTSTRAP_TOKEN"\)\) throw new Error\("Do not set NPM_BOOTSTRAP_TOKEN when using --token-stdin\."\)/);
  assert.match(npmBootstrapScript, /if \(process\.stdin\.isTTY === true\) throw new Error\("Pipe npm bootstrap token stdin; interactive terminal stdin is not accepted for --token-stdin\."\)/);
  assert.match(npmBootstrapScript, /npm bootstrap token stdin must be a non-empty control-free value under \$\{MAX_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(npmBootstrapScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(descriptor\.value\)/);
  assert.match(npmBootstrapScript, /\$\{name\} must be a non-empty control-free environment value under \$\{MAX_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(npmBootstrapScript, /delete process\.env\[name\]/);
  assert.match(npmBootstrapScript, /const STATIC_NPM_TOKEN_ENV = \["NODE_AUTH_TOKEN", "NPM_TOKEN"\]/);
  assert.match(npmBootstrapScript, /if \(options\.apply\) rejectAmbientNpmPublishEnv\(\)/);
  assert.match(npmBootstrapScript, /function rejectAmbientNpmPublishEnv\(\)/);
  assert.match(npmBootstrapScript, /Remove \$\{name\} before bootstrap publishing; use only NPM_BOOTSTRAP_TOKEN and the checked npm registry\./);
  assert.match(npmBootstrapScript, /option === "registry" \|\| option === "userconfig" \|\| option\.includes\("auth"\) \|\| option\.includes\("token"\) \|\| option\.includes\("password"\) \|\| option\.includes\("certfile"\) \|\| option\.includes\("keyfile"\)/);
  assert.match(npmBootstrapScript, /await mkdtemp\(path\.join\(tmpdir\(\), "ff-npm-bootstrap-"\)\)/);
  assert.match(npmBootstrapScript, /await writeBootstrapPackage\(packageDir, workspace\)/);
  assert.match(npmBootstrapScript, /publishConfig: \{\n      access: "public",\n      tag: BOOTSTRAP_DIST_TAG\n    \}/);
  assert.match(npmBootstrapScript, /\["--config\.ignore-scripts=true", "publish", "--access", "public", "--no-git-checks", "--registry", NPM_REGISTRY, "--tag", BOOTSTRAP_DIST_TAG\]/);
  assert.match(npmBootstrapScript, /await assertBootstrapPublished\(workspace\.name\)/);
  assert.match(npmBootstrapScript, /function assertBootstrapPublished\(name\)/);
  assert.match(npmBootstrapScript, /distTags\[BOOTSTRAP_DIST_TAG\] !== BOOTSTRAP_VERSION/);
  assert.match(npmBootstrapScript, /distTags\.latest === BOOTSTRAP_VERSION/);
  assert.match(npmBootstrapScript, /npm bootstrap publish unexpectedly set the bootstrap version as latest\./);
  assert.doesNotMatch(npmBootstrapScript, /BOOTSTRAP_DIST_TAG = "latest"|"--tag", "latest"/);
  assert.doesNotMatch(npmBootstrapScript, /writeFile\(path\.join\(root, "package\.json"\)|pnpm, \["publish"\], \{ cwd: root/);
  assert.match(releaseReadinessScript, /const REQUIRED_OAUTH_SCOPES = \["repo", "workflow"\]/);
  assert.match(releaseReadinessScript, /const GITHUB_ACTIONS_REQUIRED_OAUTH_SCOPES = \["repo"\]/);
  assert.match(releaseReadinessScript, /const RELEASE_PREFLIGHT_SECRET = "RELEASE_PREFLIGHT_TOKEN"/);
  assert.match(releaseReadinessScript, /const REQUIRED_SUCCESSFUL_MAIN_WORKFLOWS = \[[\s\S]*\{ file: "codeql\.yml", name: "codeql" \}[\s\S]*\{ file: "scorecard\.yml", name: "scorecard" \}[\s\S]*\{ file: "dependency-integrity\.yml", name: "dependency-integrity" \}[\s\S]*\]/);
  assert.match(releaseReadinessScript, /class ReleaseReadinessFailure extends Error/);
  assert.match(releaseReadinessScript, /const token = githubToken\(\);[\s\S]*const runningInGitHubActions = envString\("GITHUB_ACTIONS"\) === "true";[\s\S]*assertReleaseWorkflowTokenClass\(token, runningInGitHubActions\);[\s\S]*const releaseActorLogin = runningInGitHubActions \? githubActor\(\) : undefined;[\s\S]*const failures = \[\]/);
  assert.match(releaseReadinessScript, /function githubActor\(\)/);
  assert.match(releaseReadinessScript, /GITHUB_ACTOR must be a GitHub username in the release workflow\./);
  assert.match(releaseReadinessScript, /await collectReadinessFailure\(failures, async \(\) => \{/);
  assert.doesNotMatch(releaseReadinessScript, /const token = await collectReadinessValue\(failures, \(\) => githubToken\(\)\)/);
  assert.match(releaseReadinessScript, /let authenticatedLogin/);
  assert.match(releaseReadinessScript, /authenticatedLogin = requiredAuthenticatedLogin\(auth\.data\)/);
  assert.match(releaseReadinessScript, /if \(failures\.length > 0\) throw new ReleaseReadinessFailure\(failures\)/);
  assert.match(releaseReadinessScript, /function readinessErrorMessages\(error\)/);
  assert.match(releaseReadinessScript, /return error\.failures\.map\(\(failure\) => readinessErrorMessage\(failure\)\)/);
  assert.match(releaseReadinessScript, /const auth = await collectReadinessValue\(failures, \(\) => githubWithHeaders\(token, "GET", "\/user"\)\)/);
  assert.match(releaseReadinessScript, /collectReadinessFailureSync\(failures, \(\) => \{[\s\S]*assertTokenScopes\(auth\.headers, runningInGitHubActions\)/);
  assert.match(releaseReadinessScript, /await collectGitHubRepositoryReadiness\(failures, token, options\.repository, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /const NPM_REGISTRY = "https:\/\/registry\.npmjs\.org"/);
  assert.match(releaseReadinessScript, /const BOOTSTRAP_VERSION = "0\.0\.0-bootstrap\.0"/);
  assert.match(releaseReadinessScript, /const BOOTSTRAP_DIST_TAG = "bootstrap"/);
  assert.match(releaseReadinessScript, /const MAX_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseReadinessScript, /const MAX_NPM_REGISTRY_RESPONSE_BYTES = 1024 \* 1024/);
  assert.match(releaseReadinessScript, /const NPM_REGISTRY_TIMEOUT_MS = 20_000/);
  assert.match(releaseReadinessScript, /await readPackageMetadata\(\)/);
  assert.match(releaseReadinessScript, /await readText\(path\.join\(projectRoot\(\), "package\.json"\), MAX_PACKAGE_JSON_BYTES, "package metadata"\)/);
  assert.match(releaseReadinessScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(releaseReadinessScript, /throw new Error\(`\$\{label\} changed before verification\.`\)/);
  assert.match(releaseReadinessScript, /await assertNpmPackageReady\(packageJson\)/);
  assert.match(releaseReadinessScript, /npm package is missing; bootstrap a lower throwaway version before trusted publishing/);
  assert.match(releaseReadinessScript, /npm package version already exists; bump package\.json before tagging/);
  assert.match(releaseReadinessScript, /function assertNpmBootstrapState\(metadata, versions\)/);
  assert.match(releaseReadinessScript, /distTags\[BOOTSTRAP_DIST_TAG\] !== BOOTSTRAP_VERSION/);
  assert.match(releaseReadinessScript, /distTags\.latest === BOOTSTRAP_VERSION/);
  assert.match(releaseReadinessScript, /npm bootstrap placeholder is tagged as latest; fix npm dist-tags before releasing\./);
  assert.match(releaseReadinessScript, /function boundedNpmResponseText\(response\)/);
  assert.match(releaseReadinessScript, /npm registry response exceeded the byte limit/);
  assert.match(releaseReadinessScript, /npm registry response was not valid UTF-8/);
  assert.match(releaseReadinessScript, /const MAX_ENV_VALUE_BYTES = 4_096/);
  assert.match(releaseReadinessScript, /function githubToken\(\)/);
  assert.match(releaseReadinessScript, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
  assert.match(releaseReadinessScript, /\$\{name\} must be a non-empty control-free string under/);
  assert.match(releaseReadinessScript, /const GITHUB_API_TIMEOUT_MS = 30_000/);
  assert.match(releaseReadinessScript, /const MAX_GITHUB_API_RESPONSE_BYTES = 1024 \* 1024/);
  assert.match(releaseReadinessScript, /const controller = new AbortController\(\)/);
  assert.match(releaseReadinessScript, /const timer = setTimeout\(\(\) => controller\.abort\(\), GITHUB_API_TIMEOUT_MS\)/);
  assert.match(releaseReadinessScript, /signal: controller\.signal/);
  assert.match(releaseReadinessScript, /clearTimeout\(timer\)/);
  assert.match(releaseReadinessScript, /GitHub API request timed out\./);
  assert.match(releaseReadinessScript, /async function boundedGithubResponseText\(response\)/);
  assert.match(releaseReadinessScript, /if \(total > MAX_GITHUB_API_RESPONSE_BYTES\) throw new Error\("GitHub API response exceeded the byte limit\."\)/);
  assert.match(releaseReadinessScript, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(body\)/);
  assert.match(releaseReadinessScript, /GitHub API response was not valid JSON\./);
  assert.match(releaseReadinessScript, /function githubApiErrorMessage\(status\) \{[\s\S]*return `GitHub API returned \$\{status\}\.`;[\s\S]*\}/);
  assert.doesNotMatch(releaseReadinessScript, /data\.message|GitHub API returned \$\{status\}:/);
  assert.doesNotMatch(releaseReadinessScript, /response\.text\(\)/);
  assert.doesNotMatch(releaseReadinessScript, /process\.env\.GITHUB_TOKEN|process\.env\.GH_TOKEN|process\.env\.GITHUB_REPOSITORY/);
  assert.match(releaseReadinessScript, /headers\.get\("x-oauth-scopes"\)/);
  assert.match(releaseReadinessScript, /assertReleaseWorkflowTokenClass\(token, runningInGitHubActions\)/);
  assert.match(releaseReadinessScript, /function assertReleaseWorkflowTokenClass\(token, runningInGitHubActions = false\)/);
  assert.match(releaseReadinessScript, /token\.startsWith\("github_pat_"\) \|\| token\.startsWith\("ghs_"\)/);
  assert.match(releaseReadinessScript, /RELEASE_PREFLIGHT_TOKEN must be a GitHub App installation token or fine-grained PAT/);
  assert.match(releaseReadinessScript, /assertTokenScopes\(auth\.headers, runningInGitHubActions\)/);
  assert.match(releaseReadinessScript, /if \(rawScopes === "" && runningInGitHubActions\) return;/);
  assert.match(releaseReadinessScript, /assertOAuthScopes\(rawScopes, runningInGitHubActions \? GITHUB_ACTIONS_REQUIRED_OAUTH_SCOPES : REQUIRED_OAUTH_SCOPES\)/);
  assert.doesNotMatch(releaseReadinessScript, /envString\("GITHUB_ACTIONS"\)[\s\S]{0,180}assertOAuthScopes/);
  assert.match(releaseReadinessScript, /function assertOAuthScopes\(rawScopes, requiredScopes = REQUIRED_OAUTH_SCOPES\)/);
  assert.match(releaseReadinessScript, /for \(const scope of requiredScopes\)/);
  assert.match(releaseReadinessScript, /GitHub token is missing \$\{scope\} scope\.\$\{refresh\}/);
  assert.match(releaseReadinessScript, /gh auth refresh -h github\.com -s workflow/);
  assert.match(releaseReadinessScript, /async function collectGitHubRepositoryReadiness\(failures, token, repository, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /\/repos\/\$\{repository\}\/private-vulnerability-reporting/);
  assert.match(releaseReadinessScript, /function assertPrivateVulnerabilityReporting\(status\)/);
  assert.match(releaseReadinessScript, /GitHub private vulnerability reporting must be enabled\./);
  assert.match(releaseReadinessScript, /\/repos\/\$\{repository\}\/branches\/main/);
  assert.match(releaseReadinessScript, /Remote main branch is missing\. Push main before releasing\./);
  assert.match(releaseReadinessScript, /const mainSha = mainBranch \? collectReadinessValueSync\(failures, \(\) => requiredBranchSha\(mainBranch, "main"\)\) : undefined/);
  assert.match(releaseReadinessScript, /for \(const workflow of REQUIRED_SUCCESSFUL_MAIN_WORKFLOWS\)/);
  assert.match(releaseReadinessScript, /assertSuccessfulMainWorkflowRun\(token, repository, workflow, mainSha\)/);
  assert.match(releaseReadinessScript, /function requiredBranchSha\(branch, branchName\)/);
  assert.match(releaseReadinessScript, /\/repos\/\$\{repository\}\/actions\/workflows\/\$\{encodeURIComponent\(workflow\.file\)\}\/runs\?branch=main&per_page=1/);
  assert.doesNotMatch(releaseReadinessScript, /runs\?branch=main&status=success&per_page=1/);
  assert.match(releaseReadinessScript, /GitHub \$\{workflow\.name\} workflow latest main run is not a successful current-main run/);
  assert.match(releaseReadinessScript, /\/repos\/\$\{repository\}\/actions\/secrets\/\$\{RELEASE_PREFLIGHT_SECRET\}/);
  assert.match(releaseReadinessScript, /GitHub Actions secret RELEASE_PREFLIGHT_TOKEN is missing\./);
  assert.match(releaseReadinessScript, /const rulesetsByName = collectReadinessValueSync\(failures, \(\) => requiredRulesetsByName\(rulesets\)\)/);
  assert.match(releaseReadinessScript, /assertRequiredRuleset\(rulesetsByName, MAIN_RULESET_NAME, "branch"\)/);
  assert.match(releaseReadinessScript, /assertRequiredRuleset\(rulesetsByName, TAG_RULESET_NAME, "tag"\)/);
  assert.match(releaseReadinessScript, /function requiredRulesetsByName\(rulesets\)/);
  assert.match(releaseReadinessScript, /rulesets\.length !== expectedTargets\.size/);
  assert.match(releaseReadinessScript, /GitHub rulesets response contained unexpected or missing rulesets/);
  assert.match(releaseReadinessScript, /GitHub rulesets response contained an unexpected ruleset/);
  assert.match(releaseReadinessScript, /GitHub rulesets response contained duplicate names/);
  assert.match(securityPolicy, /repository rulesets list has malformed, unexpected, or duplicate entries/);
  assert.match(releaseReadinessScript, /ruleset\.target !== target \|\| ruleset\.enforcement !== "active"/);
  assert.match(releaseReadinessScript, /rulesetDetails\(token, repository, mainRuleset\.id\)/);
  assert.match(releaseReadinessScript, /rulesetDetails\(token, repository, tagRuleset\.id\)/);
  assert.match(releaseReadinessScript, /function assertMainRuleset\(ruleset\)/);
  assert.match(releaseReadinessScript, /assertRulesetBase\(ruleset, MAIN_RULESET_NAME, "branch", "refs\/heads\/main"\)/);
  assert.match(releaseReadinessScript, /assertNoBypassActors\(ruleset, MAIN_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /rulesByType\(ruleset, MAIN_RULESET_NAME, \["deletion", "non_fast_forward", "pull_request", "required_status_checks"\]\)/);
  assert.match(releaseReadinessScript, /includes\.length !== 1 \|\| includes\[0\] !== refName/);
  assert.doesNotMatch(releaseReadinessScript, /includes\.includes\(refName\)/);
  assert.match(releaseReadinessScript, /assertRulePresent\(rules, "deletion", MAIN_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /assertRulePresent\(rules, "non_fast_forward", MAIN_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /assertRulePresent\(rules, "pull_request", MAIN_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /assertBoolean\(pullRequestParameters\.require_code_owner_review, true/);
  assert.match(releaseReadinessScript, /assertBoolean\(pullRequestParameters\.require_last_push_approval, true/);
  assert.match(releaseReadinessScript, /pullRequestParameters\.required_approving_review_count !== 1/);
  assert.match(releaseReadinessScript, /assertStatusContexts\(statusParameters\.required_status_checks, REQUIRED_CI_CHECKS, MAIN_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /entry\.integration_id !== GITHUB_ACTIONS_INTEGRATION_ID/);
  assert.match(releaseReadinessScript, /required status checks are not pinned to GitHub Actions/);
  assert.match(releaseReadinessScript, /"codeql analyze"/);
  assert.match(releaseReadinessScript, /"dependency review"/);
  assert.match(releaseReadinessScript, /function assertTagRuleset\(ruleset\)/);
  assert.match(releaseReadinessScript, /const RELEASE_TAG_REF_PATTERN = `refs\/tags\/\$\{NPM_DEPLOYMENT_TAG_POLICY\}`/);
  assert.match(releaseReadinessScript, /assertRulesetBase\(ruleset, TAG_RULESET_NAME, "tag", RELEASE_TAG_REF_PATTERN\)/);
  assert.match(releaseReadinessScript, /assertNoBypassActors\(ruleset, TAG_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /rulesByType\(ruleset, TAG_RULESET_NAME, \["deletion", "non_fast_forward"\]\)/);
  assert.doesNotMatch(releaseReadinessScript, /assertRulePresent\(rules, "creation", TAG_RULESET_NAME\)/);
  assert.match(releaseReadinessScript, /function rulesByType\(ruleset, name, expectedTypes\)/);
  assert.match(releaseReadinessScript, /ruleset\.rules\.length !== expectedTypes\.length/);
  assert.match(releaseReadinessScript, /!expected\.has\(rule\.type\) \|\| rules\.has\(rule\.type\)/);
  assert.match(releaseReadinessScript, /\$\{name\} rules are not exact\./);
  assert.match(releaseReadinessScript, /GitHub ruleset ref coverage is not exact for \$\{refName\}: \$\{name\}\./);
  assert.match(releaseReadinessScript, /GitHub ruleset has ref exclusions: \$\{name\}\./);
  assert.match(releaseReadinessScript, /function assertNoBypassActors\(ruleset, name\)/);
  assert.match(releaseReadinessScript, /\$\{name\} must not allow bypass actors\./);
  assert.doesNotMatch(releaseReadinessScript, /function assertTagBypassActors|bypass\.length !== 1|actor\?\.actor_id/);
  assert.match(releaseReadinessScript, /if \(environment && collectNpmEnvironmentReadiness\(failures, environment, authenticatedLogin, releaseActorLogin\)\)/);
  assert.match(releaseReadinessScript, /function collectNpmEnvironmentReadiness\(failures, environment, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /GitHub npm environment has no protection rules\./);
  assert.match(releaseReadinessScript, /GitHub npm environment has no required reviewers protection rule\./);
  assert.match(releaseReadinessScript, /GitHub npm environment must prevent self-review\./);
  assert.match(releaseReadinessScript, /GitHub npm environment must disable admin bypass\./);
  assert.match(releaseReadinessScript, /GitHub npm environment must restrict deployments to custom policies\./);
  assert.match(releaseReadinessScript, /failures\.push\(new Error\("GitHub npm environment must disable admin bypass\."\)\)/);
  assert.match(releaseReadinessScript, /assertNpmEnvironmentApproverPermissions\(token, repository, environment, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /function assertNpmEnvironmentApproverPermissions\(token, repository, environment, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /function npmEnvironmentUserReviewerLogins\(environment\)/);
  assert.match(releaseReadinessScript, /function assertNpmEnvironmentReviewerCanApprove\(token, repository, login\)/);
  assert.match(releaseReadinessScript, /\/collaborators\/\$\{encodeURIComponent\(login\)\}\/permission/);
  assert.match(releaseReadinessScript, /GitHub npm environment user reviewer must have write, maintain, or admin repository permission\./);
  assert.match(releaseReadinessScript, /GitHub npm environment must include at least one non-self user reviewer with write, maintain, or admin repository permission\./);
  assert.match(releaseReadinessScript, /assertNpmDeploymentPolicies\(await github\(token, "GET", `\/repos\/\$\{repository\}\/environments\/\$\{encodeURIComponent\(NPM_ENVIRONMENT\)\}\/deployment-branch-policies\?per_page=100`\)\)/);
  assert.match(releaseReadinessScript, /function assertNpmDeploymentPolicies\(response\)/);
  assert.match(releaseReadinessScript, /GitHub npm environment deployment policy is not exact\./);
  assert.match(releaseReadinessScript, /GitHub npm environment must deploy only from release tags\./);
  assert.match(releaseReadinessScript, /GitHub npm environment required reviewers rule has no reviewers\./);
  assert.match(releaseReadinessScript, /GitHub npm environment sole required reviewer is the authenticated release operator or tag pusher/);
  assert.match(releaseReadinessScript, /function isSelfReviewDeadlockReviewer\(reviewer, authenticatedLogin, releaseActorLogin\)/);
  assert.match(releaseReadinessScript, /function reviewerLogin\(reviewerEntry\)/);
  assert.match(releaseReadinessScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(releaseReadinessScript, /NPM_TOKEN|NODE_AUTH_TOKEN|npm publish|git tag/);
});

test("security-sensitive surfaces require code owner review", () => {
  assert.match(securityPolicy, /security-sensitive crypto, protocol, release, dependency, dependency-review artifacts, Docker, server, CLI input\/privacy, browser file-write, and file-publish surfaces must be covered by `\.github\/CODEOWNERS`/);
  assert.match(readme, /exact repository rulesets that release preflight requires for `main` and `v\*\.\*\.\*` release tags/);
  for (const path of [
    "/.github/",
    "/Dockerfile",
    "/package.json",
    "/pnpm-lock.yaml",
    "/pnpm-workspace.yaml",
    "/README.md",
    "/CONTRIBUTING.md",
    "/CHANGELOG.md",
    "/SECURITY.md",
    "/docs/security/",
    "/conformance/",
    "/scripts/",
    "/src/shared/security.ts",
    "/src/shared/messages.ts",
    "/src/shared/chunks.ts",
    "/src/shared/transfer.ts",
    "/src/shared/signal-replay.ts",
    "/src/cli/crypto-dependencies.ts",
    "/src/cli/dependency-metadata.ts",
    "/src/cli/error-redaction.ts",
    "/src/cli/files.ts",
    "/src/cli/index.ts",
    "/src/cli/native-webrtc.ts",
    "/src/cli/rtc.ts",
    "/src/cli/secure.ts",
    "/src/cli/transfer.ts",
    "/src/server/",
    "/src/web/main.ts",
    "/src/web/file-names.ts",
    "/src/web/file-system.ts",
    "/test/security.test.ts",
    "/test/package-surface.test.ts",
    "/test/deployment-surface.test.ts",
    "/test/release-artifact-verifier.test.ts",
    "/test/release-checksum-writer.test.ts",
    "/test/release-notes-writer.test.ts",
    "/test/release-*.test.ts",
    "/test/*install-state*.test.ts",
    "/test/cli-error-redaction.test.ts",
    "/test/cli-json-policy.test.ts",
    "/test/smoke-packed.test.ts",
    "/test/publish.test.ts",
    "/test/privacy-surface.test.ts",
    "/test/browser-operation-policy.test.ts",
    "/test/crypto-dependencies.test.ts",
    "/test/cpace-vectors.test.ts",
    "/test/native-webrtc-dependencies.test.ts"
  ]) {
    assert.match(codeowners, new RegExp(`^${escapeRegExp(path)}\\s+@VictorHaine$`, "m"), `${path} must be owned`);
  }
});

test("CodeQL code scanning is pinned and least-privilege", () => {
  assert.match(securityPolicy, /CodeQL code scanning must run from a pinned workflow on pull requests, pushes to `main`, and a weekly schedule/);
  assert.match(securityPolicy, /CodeQL code scanning must[\s\S]*with only `contents: read` and `security-events: write` permissions and an explicit job timeout/);
  assert.match(securityPolicy, /release preflight must require a successful CodeQL run for the current `main` commit before tagging/);
  assert.match(readme, /\.github\/workflows\/codeql\.yml` runs pinned CodeQL analysis/);
  assert.match(readme, /release preflight requires a successful CodeQL run for the exact current `main` commit before tagging/);
  assert.match(codeqlWorkflow, /^name: codeql$/m);
  assert.match(codeqlWorkflow, /^on:\n  pull_request:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "17 3 \* \* 2"$/m);
  assert.match(codeqlWorkflow, /^permissions:\n  contents: read\n  security-events: write$/m);
  assert.match(codeqlWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(workflowJob(codeqlWorkflow, "analyze"), /name: codeql analyze[\s\S]*timeout-minutes: 20/);
  assert.match(codeqlWorkflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2[\s\S]*persist-credentials: false/);
  assert.match(codeqlWorkflow, /uses: github\/codeql-action\/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*languages: javascript-typescript/);
  assert.match(codeqlWorkflow, /uses: github\/codeql-action\/analyze@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*category: "\/language:javascript-typescript"/);
  assert.doesNotMatch(codeqlWorkflow, /id-token:\s*write|contents:\s*write|pull-requests:\s*write|actions:\s*write/);
});

test("OpenSSF Scorecard scanning is pinned and uploads SARIF", () => {
  assert.match(securityPolicy, /OpenSSF Scorecard must run from a pinned workflow on pushes to `main`, manual dispatch, and a weekly schedule/);
  assert.match(securityPolicy, /OpenSSF Scorecard must[\s\S]*have a successful run for the current `main` commit before release preflight passes/);
  assert.match(readme, /\.github\/workflows\/scorecard\.yml` runs the pinned Scorecard action/);
  assert.match(readme, /release preflight requires a successful Scorecard run for the exact current `main` commit before tagging/);
  assert.match(scorecardWorkflow, /^name: scorecard$/m);
  assert.match(scorecardWorkflow, /^on:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "29 4 \* \* 3"\n  workflow_dispatch:$/m);
  assert.match(scorecardWorkflow, /^permissions:\n  contents: read\n  security-events: write\n  id-token: write$/m);
  assert.match(scorecardWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(workflowJob(scorecardWorkflow, "analyze"), /timeout-minutes: 15/);
  assert.match(scorecardWorkflow, /uses: ossf\/scorecard-action@4eaacf0543bb3f2c246792bd56e8cdeffafb205a # v2\.4\.3[\s\S]*results_file: scorecard-results\.sarif[\s\S]*results_format: sarif[\s\S]*publish_results: true/);
  assert.match(scorecardWorkflow, /uses: github\/codeql-action\/upload-sarif@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*sarif_file: scorecard-results\.sarif/);
  assert.doesNotMatch(scorecardWorkflow, /contents:\s*write|pull-requests:\s*write|actions:\s*write|packages:\s*write/);
});

test("dependency review blocks vulnerable dependency introductions", () => {
  assert.match(securityPolicy, /GitHub dependency review must run from a pinned workflow on pull requests with read-only permissions, an explicit job timeout, and fail on vulnerable runtime or development dependency changes at low severity or higher/);
  assert.match(readme, /\.github\/workflows\/dependency-review\.yml` runs the pinned GitHub dependency review action on pull requests/);
  assert.match(dependencyReviewWorkflow, /^name: dependency-review$/m);
  assert.match(dependencyReviewWorkflow, /^on:\n  pull_request:$/m);
  assert.match(dependencyReviewWorkflow, /^permissions:\n  contents: read$/m);
  assert.match(dependencyReviewWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(workflowJob(dependencyReviewWorkflow, "dependency-review"), /timeout-minutes: 10/);
  assert.match(dependencyReviewWorkflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2[\s\S]*persist-credentials: false/);
  assert.match(dependencyReviewWorkflow, /uses: actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5\.0\.0[\s\S]*vulnerability-check: true[\s\S]*license-check: false[\s\S]*fail-on-severity: low[\s\S]*fail-on-scopes: runtime, development[\s\S]*comment-summary-in-pr: never[\s\S]*show-patched-versions: true/);
  assert.doesNotMatch(dependencyReviewWorkflow, /pull_request_target|workflow_run|contents:\s*write|pull-requests:\s*write|id-token:\s*write|actions:\s*write|packages:\s*write/);
});

test("dependency integrity monitor catches new registry risk and gates releases", () => {
  assert.match(securityPolicy, /dependency integrity monitoring must run from a pinned workflow on pushes to `main`, manual dispatch, and a weekly schedule on unchanged `main` with read-only permissions/);
  assert.match(securityPolicy, /checked pnpm bootstrap, frozen install, installed-state verification, `pnpm security:audit`, and `pnpm security:signatures`/);
  assert.match(securityPolicy, /release preflight must require a successful dependency-integrity run for the current `main` commit/);
  assert.match(readme, /\.github\/workflows\/dependency-integrity\.yml` runs on pushes to `main`, manual dispatch, and weekly with read-only permissions/);
  assert.match(readme, /re-checks the frozen install, installed dependency tree, npm advisory audit, and registry package signatures even when `main` has not changed/);
  assert.match(readme, /release preflight requires a successful dependency-integrity run for the exact current `main` commit before tagging/);
  assert.match(dependencyIntegrityWorkflow, /^name: dependency-integrity$/m);
  assert.match(dependencyIntegrityWorkflow, /^on:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "41 5 \* \* 4"\n  workflow_dispatch:$/m);
  assert.match(dependencyIntegrityWorkflow, /^permissions:\n  contents: read$/m);
  assert.match(dependencyIntegrityWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(workflowJob(dependencyIntegrityWorkflow, "dependency-integrity"), /name: dependency integrity[\s\S]*runs-on: ubuntu-24\.04[\s\S]*timeout-minutes: 15/);
  assert.match(dependencyIntegrityWorkflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2[\s\S]*persist-credentials: false/);
  assert.match(dependencyIntegrityWorkflow, /uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0[\s\S]*node-version: 22\.22\.3/);
  assert.match(dependencyIntegrityWorkflow, /node scripts\/prepare-checked-pnpm\.mjs[\s\S]*pnpm install --frozen-lockfile[\s\S]*pnpm check:install-state[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.doesNotMatch(dependencyIntegrityWorkflow, /pull_request_target|workflow_run|contents:\s*write|pull-requests:\s*write|id-token:\s*write|actions:\s*write|packages:\s*write/);
});

test("documented release gates require a hardened Docker runtime smoke, not just image build", () => {
  for (const document of [readme, securityPolicy]) {
    assert.match(document, /node scripts\/prepare-checked-pnpm\.mjs\npnpm install --frozen-lockfile\npnpm exec playwright install --with-deps chromium\npnpm verify:local/);
    assert.match(document, /node scripts\/prepare-checked-pnpm\.mjs\npnpm install --frozen-lockfile\npnpm exec playwright install --with-deps chromium\npnpm verify:release/);
    assert.match(document, /pnpm smoke:docker-policy/);
    assert.match(document, /read-only filesystem, dropped Linux capabilities,[^.\n]+`no-new-privileges`/);
    assert.match(document, /refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`/);
  }
  assert.match(securityPolicy, /CI, release, Docker, and documented source builds must prepare pnpm through `scripts\/prepare-checked-pnpm\.mjs`, which byte-caps and no-follow-opens `package\.json` with pre\/post-read identity and mutation-metadata checks/);
  assert.match(securityPolicy, /runs Corepack and tar with a private package-manager home plus a minimal allowlisted child environment/);
  assert.match(readme, /Build from source:[\s\S]*node scripts\/prepare-checked-pnpm\.mjs\npnpm install --frozen-lockfile\npnpm build\npnpm test/);
  assert.doesNotMatch(readme, /Build from source:[\s\S]*```sh\npnpm install\n/);
  assert.match(contributing, /## Local Setup[\s\S]*node scripts\/prepare-checked-pnpm\.mjs\npnpm install --frozen-lockfile\npnpm exec playwright install --with-deps chromium\npnpm verify:local/);
  assert.match(contributing, /For release-sensitive or protocol-sensitive changes, also run:[\s\S]*pnpm smoke:release-artifact[\s\S]*pnpm smoke:docker-policy[\s\S]*pnpm test:e2e[\s\S]*pnpm test:browser[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.match(securityPolicy, /packed-install checks on Linux x64, Linux arm64, macOS arm64, macOS Intel, and Windows x64 for every supported Node major/);
  assert.match(securityPolicy, /packs the verified npm tarball with lifecycle scripts disabled after the explicit verified build/);
  assert.match(securityPolicy, /derives the expected packed tarball name from the checked package name and exact semver version before writing `SBOM\.cdx\.json` and `SHA256SUMS`/);
  assert.match(securityPolicy, /validates the single downloaded tarball filename, regular-file status, size cap, checksum, CycloneDX SBOM package identity, packed `package\/package\.json` name and version, and release tag/);
  assert.match(securityPolicy, /packed-install smokes that exact downloaded tarball/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap the provided tarball path by UTF-8 bytes, no-follow-open, identity-check, and stage the verified tarball into a distinct no-follow-copied file in its private temp workspace before fresh-project install/);
  assert.match(securityPolicy, /provided tarball paths must reject terminal control\/format characters and staging\/open failures must not echo raw tarball paths/);
  assert.match(securityPolicy, /smoke-tested artifact to npm with provenance/);
  assert.match(securityPolicy, /The publish job must not reinstall dependencies, rebuild, or run publish lifecycle scripts before publish/);
  assert.match(securityPolicy, /packed-install smoke that verifier-emitted downloaded tarball path/);
  assert.match(securityPolicy, /pass the verifier-emitted tarball path to packed smoke and `pnpm publish` instead of rediscovering the artifact with `find` or a shell glob after verification/);
  assert.match(securityPolicy, /The release workflow must not support manual dispatch/);
  assert.match(securityPolicy, /release artifacts, npm publishes, Docker images, and GitHub Releases must only be produced from `v\*\.\*\.\*` tag refs that match `package\.json` version/);
  assert.match(securityPolicy, /package-surface tests must run after the release build/);
  assert.match(securityPolicy, /checked release-artifact verifier/);
  assert.match(securityPolicy, /publish that resolved tarball path with `--ignore-scripts`/);
  assert.match(securityPolicy, /Release publishing must use npm trusted publishing with OIDC provenance, not long-lived `NPM_TOKEN` secrets/);
  assert.match(securityPolicy, /GitHub Releases must be tag-only, run only after npm publishing succeeds, re-verify the downloaded npm tarball and SBOM/);
  assert.match(readme, /OIDC trusted publishing from the `npm` environment/);
  assert.match(readme, /creates the GitHub Release with that exact tarball plus `SHA256SUMS` and `SBOM\.cdx\.json`/);
  assert.match(readme, /runs the packed-install smoke against a no-follow-verified staged copy of that downloaded tarball/);
  assert.match(securityPolicy, /trusted publishing from the GitHub `npm` environment/);
  assert.match(securityPolicy, /must not use static npm tokens/);
  assert.match(securityPolicy, /checked Docker policy smoke script that proves the production Docker image independently refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`/);
  assert.match(securityPolicy, /verifies `\/healthz`, origin policy, and the bundled web UI from that running container/);
  assert.match(securityPolicy, /accepts the configured production origin and rejects an untrusted origin on both the HTTP ICE endpoint and the WebSocket signaling upgrade path/);
  assert.match(securityPolicy, /explicit signaling topology/);
});

test("Docker HTTP probes are bounded and timeout protected", () => {
  assert.match(securityPolicy, /Docker image healthchecks must use the checked HTTP probe script instead of inline fetch snippets/);
  assert.match(securityPolicy, /Docker runtime HTTP probes must use the checked probe script with a symlink-safe realpath entrypoint check, validated response byte caps, control-free request environment byte caps, an abort deadline, disabled redirects, deterministic URL\/origin parse failures, probe-owned top-level failure reporting that does not echo raw probe URLs or stack traces, fatal UTF-8 response decoding, and fail-closed URL validation that rejects credential-bearing, query-bearing, or fragment-bearing probe URLs/);
  assert.match(httpProbeScript, /const PROBE_TIMEOUT_MS = 10_000/);
  assert.match(httpProbeScript, /const MAX_RESPONSE_BYTES = 1_048_576/);
  assert.match(httpProbeScript, /const MAX_ENV_VALUE_BYTES = 2_048/);
  assert.match(httpProbeScript, /function utf8ByteLengthExceeds/);
  assert.match(httpProbeScript, /\/\[\\p\{Cc\}\\p\{Cf\}\]\/u\.test\(descriptor\.value\)/);
  assert.match(httpProbeScript, /\$\{name\} must be a control-free string under \$\{MAX_ENV_VALUE_BYTES\} UTF-8 bytes\./);
  assert.match(httpProbeScript, /utf8ByteLengthExceeds\(descriptor\.value, MAX_ENV_VALUE_BYTES\)/);
  assert.match(httpProbeScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(httpProbeScript, /const controller = new AbortController\(\)/);
  assert.match(httpProbeScript, /fetch\(url\.href, \{ headers, redirect: "error", signal: controller\.signal \}\)/);
  assert.match(securityPolicy, /disabled redirects/);
  assert.match(httpProbeScript, /console\.error\("HTTP probe failed:"\)/);
  assert.match(httpProbeScript, /function probeErrorMessage\(error\)/);
  assert.match(httpProbeScript, /const MAX_ERROR_MESSAGE_CHARS = 4_096/);
  assert.match(httpProbeScript, /containsUrlOrPathText\(error\.message\)/);
  assert.match(httpProbeScript, /from probe target/);
  assert.match(httpProbeScript, /HTTP probe timed out after \$\{PROBE_TIMEOUT_MS\}ms\./);
  assert.doesNotMatch(httpProbeScript, /from \$\{url\.href\}|: \$\{url\.href\}|error\.stack/);
  assert.match(httpProbeScript, /readBoundedResponseText\(response, maxBytes\)/);
  assert.match(httpProbeScript, /Invalid HTTP probe response byte limit/);
  assert.match(httpProbeScript, /Number\.isSafeInteger\(maxBytes\)/);
  assert.match(httpProbeScript, /if \(total > maxBytes\) throw new Error\("HTTP probe response exceeded the byte limit\."\)/);
  assert.match(httpProbeScript, /function parseUrl\(value, message\)/);
  assert.match(httpProbeScript, /export function requiredUrl\(value\)/);
  assert.match(httpProbeScript, /export function optionalOrigin\(value\)/);
  assert.match(httpProbeScript, /export async function readBoundedResponseText\(response, maxBytes\)/);
  assert.match(httpProbeScript, /PROBE_URL must be a valid URL/);
  assert.match(httpProbeScript, /PROBE_ORIGIN must be a valid origin/);
  assert.match(httpProbeScript, /HTTP probe response is not valid UTF-8/);
  assert.match(httpProbeScript, /Plain HTTP probes are restricted to loopback hosts/);
  assert.match(httpProbeScript, /PROBE_URL must not contain credentials/);
  assert.match(httpProbeScript, /PROBE_URL must not contain a query string or fragment/);
  assert.doesNotMatch(httpProbeScript, /parsed\.username = ""|parsed\.password = ""/);
  assert.match(httpProbeScript, /PROBE_ORIGIN must be an exact http or https origin/);
  assert.doesNotMatch(ciWorkflow, /node -e "fetch\(/);
  assert.doesNotMatch(releaseWorkflow, /node -e "fetch\(/);
});

test("release artifact verification is bounded and exact", () => {
  assert.match(securityPolicy, /release artifact verification must use the checked script with a symlink-safe realpath entrypoint check and verifier-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, verify `release-artifacts` is a real directory inside the project root before listing or opening release evidence/);
  assert.match(securityPolicy, /validate artifact directory entry names before sorting, filtering, or reporting them/);
  assert.match(securityPolicy, /reject control\/format\/path-shaped or over-byte-budget entry names without echoing them/);
  assert.match(securityPolicy, /prove the downloaded artifact directory contains only `SHA256SUMS`, `SBOM\.cdx\.json`, and the expected tarball/);
  assert.match(releaseWorkflow, /verify downloaded release artifact[\s\S]*node scripts\/verify-release-artifact\.mjs/);
  assert.doesNotMatch(releaseWorkflow, /verify release artifact checksum[\s\S]*sha256sum -c SHA256SUMS/);
  assert.doesNotMatch(releaseWorkflow, /node --input-type=module <<'NODE'/);
  assert.match(releaseWorkflow, /pack release artifact[\s\S]*node scripts\/smoke-release-artifact\.mjs --keep-artifacts/);
  assert.match(releaseChecksumScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseChecksumScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(scriptPath\)/);
  assert.match(releaseChecksumScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseChecksumScript, /release artifact directory must be a real directory/);
  assert.match(releaseChecksumScript, /const MAX_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(releaseChecksumScript, /constants\.O_NOFOLLOW/);
  assert.match(releaseChecksumScript, /await lstat\(filePath\)[\s\S]*await open\(filePath, noFollowReadFlags\(\)\)[\s\S]*if \(!sameFile\(info, stat\)\)[\s\S]*readVerifiedHandleBytes\(handle, stat\.size, description\)[\s\S]*if \(opened\.size !== stat\.size \|\| !sameFile\(stat, opened\)\)/);
  assert.match(releaseChecksumScript, /async function readVerifiedHandleBytes\(handle, size, description\)[\s\S]*Buffer\.alloc\(size\)[\s\S]*await handle\.read\(buffer, offset, size - offset, offset\)[\s\S]*if \(offset !== size\)/);
  assert.doesNotMatch(releaseChecksumScript, /handle\.readFile\(/);
  assert.match(releaseChecksumScript, /Release checksum generation failed:/);
  assert.match(releaseChecksumScript, /function releaseChecksumErrorMessage\(error\)[\s\S]*containsAbsolutePathText\(error\.message\)/);
  assert.doesNotMatch(releaseChecksumScript, /execFileSync|child_process|sha256sum|find release-artifacts/);
  assert.match(releaseArtifactScript, /const MAX_TARBALL_BYTES = 50 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_RELEASE_ENV_VALUE_BYTES = 256/);
  assert.match(releaseArtifactScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseArtifactScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(releaseArtifactScript, /console\.error\("Release artifact verification failed:"\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactErrorMessage\(error\)/);
  assert.match(releaseArtifactScript, /function containsAbsolutePathText\(value\)/);
  assert.match(releaseArtifactScript, /async function verifiedArtifactDir\(\)/);
  assert.match(releaseArtifactScript, /const releaseArtifactDir = await verifiedArtifactDir\(\)/);
  assert.match(releaseArtifactScript, /release artifact directory must be a real directory/);
  assert.doesNotMatch(releaseArtifactScript, /process\.cwd\(\)/);
  assert.match(releaseArtifactScript, /const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_PACKED_PACKAGE_JSON_BYTES = 64 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_TAR_SCAN_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_CHECKSUM_FILE_BYTES = 512/);
  assert.match(releaseArtifactScript, /const MAX_SBOM_BYTES = 1024 \* 1024/);
  assert.match(releaseArtifactScript, /requiredPackageName\(expected\.name\)/);
  assert.match(releaseArtifactScript, /requiredPackageVersion\(expected\.version\)/);
  assert.match(releaseArtifactScript, /const packedName = requiredPackageName\(packed\.name, "package\/package\.json name"\)/);
  assert.match(releaseArtifactScript, /const packedVersion = requiredPackageVersion\(packed\.version, "package\/package\.json version"\)/);
  assert.match(releaseArtifactScript, /requiredReleaseTag\(envString\("GITHUB_REF_NAME"\), expectedVersion\)/);
  assert.match(releaseArtifactScript, /function assertReleaseTagRef\(tag\)/);
  assert.match(releaseArtifactScript, /envString\("GITHUB_REF_TYPE"\) !== "tag"/);
  assert.match(releaseArtifactScript, /envString\("GITHUB_REF"\) !== `refs\/tags\/\$\{tag\}`/);
  assert.match(releaseArtifactScript, /utf8ByteLengthExceeds\(descriptor\.value, maxBytes\)/);
  assert.match(releaseArtifactScript, /release tag does not match package version \$\{version\}/);
  assert.doesNotMatch(releaseArtifactScript, /release tag \$\{value\} does not match/);
  assert.match(releaseArtifactScript, /release artifact package metadata does not match the checked workspace metadata/);
  assert.doesNotMatch(releaseArtifactScript, /String\(packed\.name\)|String\(packed\.version\)/);
  assert.match(releaseArtifactScript, /const MAX_ARTIFACT_ENTRY_NAME_BYTES = 255/);
  assert.match(releaseArtifactScript, /\(await readdir\(releaseArtifactDir\)\)\.map\(releaseArtifactEntryName\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactEntryName\(value\)/);
  assert.match(releaseArtifactScript, /release-artifacts contains an invalid artifact entry name/);
  assert.match(releaseArtifactScript, /assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /function assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /release-artifacts must contain only/);
  assert.match(releaseArtifactScript, /if \(tarballs\[0\] !== expectedBasename\)/);
  assert.match(releaseArtifactScript, /if \(!info\.isFile\(\)\)/);
  assert.match(releaseArtifactScript, /if \(info\.size < 1 \|\| info\.size > MAX_TARBALL_BYTES\)/);
  assert.match(releaseArtifactScript, /SHA256SUMS must contain exactly one checksum for the release tarball and one checksum for the SBOM/);
  assert.match(releaseArtifactScript, /release SBOM component version does not match the package/);
  assert.match(releaseArtifactScript, /if \(!info\.isFile\(\)\) throw new Error\("SHA256SUMS is not a regular file\."\)/);
  assert.match(releaseArtifactScript, /if \(info\.size < 1 \|\| info\.size > MAX_CHECKSUM_FILE_BYTES\)/);
  assert.match(releaseArtifactScript, /const handle = await open\(checksumFile, constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\("SHA256SUMS changed before verification\."\)/);
  assert.match(releaseArtifactScript, /const checksumText = await readHandleText\(handle, opened\.size, "SHA256SUMS"\)/);
  assert.match(releaseArtifactScript, /function readHandleText\(handle, size, label\)/);
  assert.match(releaseArtifactScript, /const buffer = Buffer\.alloc\(size\)/);
  assert.match(releaseArtifactScript, /handle\.read\(buffer, offset, size - offset, offset\)/);
  assert.match(releaseArtifactScript, /\$\{label\} changed while being read/);
  assert.match(securityPolicy, /release artifact verification must fatal-UTF-8-decode workspace metadata, checksum files, tar header text, and packed metadata through verifier-owned deterministic errors/);
  assert.match(securityPolicy, /reject invalid gzip archives with verifier-owned deterministic errors/);
  assert.match(releaseArtifactScript, /function decodeUtf8\(bytes, label\)/);
  assert.match(releaseArtifactScript, /throw new Error\(`\$\{label\} is not valid UTF-8\.`\)/);
  assert.match(releaseArtifactScript, /function parseJson\(text, label\)/);
  assert.match(releaseArtifactScript, /throw new Error\(`\$\{label\} is not valid JSON\.`\)/);
  assert.doesNotMatch(releaseArtifactScript, /readFile\(checksumFile, "utf8"\)/);
  assert.match(releaseArtifactScript, /if \(actualTarball !== match\[1\]\)/);
  assert.match(releaseArtifactScript, /if \(actualSbom !== match\[3\]\)/);
  assert.match(releaseArtifactScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\("release tarball changed before verification\."\)/);
  assert.match(releaseArtifactScript, /await tarball\.handle\.close\(\)/);
  assert.match(releaseArtifactScript, /tarball\.handle\.createReadStream\(\{ start: 0, end: tarball\.size - 1, autoClose: false \}\)/);
  assert.match(releaseArtifactScript, /\$\{tarball\.label \?\? "release tarball"\} changed while being read/);
  assert.match(releaseArtifactScript, /const gunzip = createGunzip\(\)/);
  assert.match(releaseArtifactScript, /function nextTarGzChunk\(chunks\)/);
  assert.match(releaseArtifactScript, /release tarball is not a valid gzip archive/);
  assert.match(releaseArtifactScript, /const stream = source\.pipe\(gunzip\)/);
  assert.match(releaseArtifactScript, /extractTarGzTextFile\(tarball, "package\/package\.json", MAX_PACKED_PACKAGE_JSON_BYTES\)/);
  assert.match(releaseArtifactScript, /let foundText/);
  assert.match(releaseArtifactScript, /release tarball contains duplicate \$\{wantedName\} entries/);
  assert.match(releaseArtifactScript, /\$\{wantedName\} is not a regular file in the release tarball/);
  assert.match(releaseArtifactScript, /if \(foundText !== undefined\) return foundText/);
  assert.match(releaseArtifactScript, /validateSkippableTarEntry\(type, size\)/);
  assert.match(releaseArtifactScript, /function validateSkippableTarEntry\(type, size\)/);
  assert.match(releaseArtifactScript, /release tarball contains an unsupported tar entry type/);
  assert.match(releaseArtifactScript, /release tarball expanded beyond the scan limit/);
  assert.match(releaseArtifactScript, /validateTarHeaderChecksum\(header\)/);
  assert.match(releaseArtifactScript, /function validateTarHeaderChecksum\(header\)/);
  assert.match(releaseArtifactScript, /index >= 148 && index < 156 \? 0x20/);
  assert.match(releaseArtifactScript, /source\.destroy\(\)/);
  assert.match(releaseArtifactScript, /gunzip\.destroy\(\)/);
  assert.match(releaseArtifactScript, /await reader\.close\(\)/);
  assert.doesNotMatch(releaseArtifactScript, /execFileSync|child_process|maxBuffer: MAX_PACKED_PACKAGE_JSON_BYTES/);
});

test("browser production policy defaults to a narrow CSP connect surface", () => {
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const headerSource = fs.readFileSync(new URL("../src/server/security-headers.ts", import.meta.url), "utf8");
  assert.match(headerSource, /const safeOptions = securityHeaderOptions\(options\)/);
  assert.match(headerSource, /safeOptions\.allowAnyWss \? \["wss:"\] : \[\]/);
  assert.match(headerSource, /safeOptions\.allowLoopbackWs \? LOOPBACK_WS_SOURCES : \[\]/);
  assert.match(headerSource, /Object\.getOwnPropertyDescriptor\(options, key\)/);
  assert.doesNotMatch(headerSource, /connect-src \$\{connectSrc\}[\s\S]*wss:/);
  assert.match(serverSource, /securityHeaders\(isHtml, \{ allowAnyWss: browserAllowAnyWss, allowLoopbackWs: browserAllowLoopbackWs \}\)/);
  assert.match(readme, /BROWSER_ALLOW_ANY_WSS=true/);
  assert.match(readme, /BROWSER_ALLOW_LOOPBACK_WS=true/);
  assert.match(securityPolicy, /must not allow arbitrary browser `wss:` destinations unless `BROWSER_ALLOW_ANY_WSS=true`/);
  assert.match(securityPolicy, /must not allow browser loopback `ws:\/\/` destinations unless `BROWSER_ALLOW_LOOPBACK_WS=true`/);
});

test("server deployment policy rejects ephemeral port binding", () => {
  const configSource = fs.readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  assert.match(configSource, /const MAX_SCALAR_ENV_BYTES = 4096/);
  assert.match(configSource, /assertEnvStringByteLength\(value, "PORT", MAX_SCALAR_ENV_BYTES\)/);
  assert.match(configSource, /port < 1 \|\| port > 65535/);
  assert.doesNotMatch(configSource, /port < 0 \|\| port > 65535/);
  assert.match(readme, /`PORT=0` is rejected/);
  assert.match(securityPolicy, /reject `PORT=0`/);
  assert.match(securityPolicy, /scalar server environment values must be byte-capped before trim, regex, numeric conversion, path resolution, or credential checks/);
});

test("server deployment policy has no wildcard origin bypass flag", () => {
  const configSource = fs.readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  assert.match(configSource, /ALLOW_ANY_ORIGIN is not supported/);
  assert.match(configSource, /parseBooleanEnv\(envValue\(env, "ALLOW_INSECURE_ORIGINS"\), "ALLOW_INSECURE_ORIGINS"\)/);
  assert.match(configSource, /assertNoUnsupportedOriginBypass\(env\)/);
  assert.doesNotMatch(configSource, /ALLOW_ANY_ORIGIN[\s\S]{0,160}return true/);
});

test("server deployment policy requires origin allowlists for non-loopback binds", () => {
  const configSource = fs.readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  const serverSource = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  assert.match(configSource, /const production = parseProductionEnv\(envValue\(env, "NODE_ENV"\)\)/);
  assert.match(configSource, /assertRequiredOriginPolicy\(allowedOrigins, production, host\)/);
  assert.match(configSource, /function parseProductionEnv/);
  assert.match(configSource, /ALLOWED_ORIGINS is required when HOST is not loopback/);
  assert.match(configSource, /function isLoopbackBindHost/);
  assert.match(configSource, /function originAllowedForRequest/);
  assert.match(configSource, /originUsesLoopbackAuthority\(origin\)/);
  assert.match(configSource, /const parsed = new URL\(origin\)/);
  assert.match(configSource, /parsed\.origin === origin/);
  assert.match(configSource, /isLoopbackAuthority\(parsed\.host\)/);
  assert.match(serverSource, /originAllowedForRequest\(origin, allowedOrigins, authority\)/);
  assert.match(serverSource, /originAllowedForRequest\(origin, allowedOrigins, requestHostAuthority\(req\)\)/);
  assert.match(readme, /When `ALLOWED_ORIGINS` is omitted, browser `Origin` traffic is accepted only when both the request `Host` and browser `Origin` are loopback/);
  assert.match(securityPolicy, /non-loopback server binds must require an explicit `ALLOWED_ORIGINS` policy even outside production mode/);
  assert.match(securityPolicy, /omitted `ALLOWED_ORIGINS` must only allow browser `Origin` traffic when both the request `Host` and browser `Origin` are loopback/);
});

test("server deployment policy requires an explicit in-memory signaling topology", () => {
  const configSource = fs.readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  assert.match(configSource, /const signalingTopology = parseSignalingTopology\(envValue\(env, "SIGNALING_TOPOLOGY"\)\)/);
  assert.match(configSource, /assertRequiredSignalingTopology\(signalingTopology, production, host\)/);
  assert.match(configSource, /SIGNALING_TOPOLOGY must be single-instance or sticky-sessions/);
  assert.match(readme, /Because rendezvous state is in memory[\s\S]*SIGNALING_TOPOLOGY=single-instance[\s\S]*SIGNALING_TOPOLOGY=sticky-sessions/);
  assert.match(securityPolicy, /production and non-loopback signaling deployments must explicitly declare `SIGNALING_TOPOLOGY=single-instance` or `SIGNALING_TOPOLOGY=sticky-sessions`/);
  assert.match(readme, /create an Actions secret named `RELEASE_PREFLIGHT_TOKEN`/);
  assert.match(readme, /GitHub App installation token or fine-grained PAT/);
  assert.match(readme, /classic PATs, OAuth tokens, refresh tokens, and user access tokens are rejected in the release workflow before package or network work/);
  assert.match(readme, /`\$\{\{ github\.token \}\}` is not enough for this gate/);
  assert.match(readme, /Use the released package after the first npm publish:[\s\S]*pnpm add -g @victorhaine\/p2p-transfer[\s\S]*ff recv[\s\S]*ff send --code-stdin --files-stdin/);
  assert.match(readme, /Run the packaged server:[\s\S]*ff-server/);
  assert.match(readme, /Production-shaped run, assuming TLS terminates at `https:\/\/files\.example\.com`/);
  assert.match(readme, /Local browser smoke run, deliberately allowing the loopback HTTP origin:[\s\S]*ALLOW_INSECURE_ORIGINS=true/);
  assert.match(readme, /The signaling server defaults to `PORT=8787`; if `PORT` is set, it must be a fixed integer between 1 and 65535/);
  assert.match(readme, /Install Chromium with `pnpm exec playwright install --with-deps chromium`/);
  assert.match(readme, /checked one-time bootstrap helper[\s\S]*0\.0\.0-bootstrap\.0/);
  assert.match(readme, /Do not bootstrap `0\.1\.0` if the tag workflow is expected to publish `v0\.1\.0`; npm versions cannot be reused/);
});

test("README documents the auto-accept consent tradeoff", () => {
  assert.match(readme, /recv --yes.*auto-accept/);
  assert.match(readme, /recv --yes.*bypasses the interactive consent gate/);
  assert.match(readme, /recv --yes.*trusted automation/);
});

test("pull request template keeps production-sensitive verification explicit", () => {
  assert.match(securityPolicy, /CI must enforce the same local typecheck, build, unit, native smoke, packed-install, browser interop, and hardened Docker policy gates that release depends on/);
  assert.match(pullRequestTemplate, /`pnpm verify:local`/);
  assert.match(pullRequestTemplate, /`pnpm verify:release` for protocol, crypto, browser, dependency, release, Docker, deployment, or file-write changes/);
  assert.match(pullRequestTemplate, /Docker runtime policy smoke from `README\.md` \/ `SECURITY\.md` for Docker, deployment, release, or server changes/);
  assert.match(pullRequestTemplate, /No protocol, crypto, file-write, dependency, release, Docker, or deployment security invariant changed/);
  assert.match(pullRequestTemplate, /Relevant `SECURITY\.md` invariants and conformance fixtures were updated/);
  assert.doesNotMatch(pullRequestTemplate, /`pnpm check:install-state`\n- \[ \] `pnpm build`\n- \[ \] `pnpm check`\n- \[ \] `pnpm test:unit`/);
});

test("README reports implemented release capabilities without stale MVP-gap language", () => {
  assert.match(readme, /Privacy boundary: file contents and real manifests are end-to-end encrypted from the signaling server, but this is not network or endpoint opacity/);
  assert.match(readme, /Signaling\/network observers can still see IPs, roles, timing, byte volume, traffic shape, and SDP\/ICE metadata/);
  assert.match(readme, /privileged local MDM\/EDR administrator can still observe selected files and plaintext at the endpoint before encryption or after decryption/);
  assert.doesNotMatch(readme, /## MVP gaps/);
  assert.match(readme, /## Known limitations/);
  assert.match(readme, /Browser receive resume is exposed only through the explicit `Resume in folder` accept action/);
  assert.match(readme, /preserves opaque tokenized `\.part` files on failure/);
  assert.match(readme, /fresh saved opaque partial record and browser-held lookup key/);
  assert.match(readme, /scrub expired or legacy metadata-bearing resume records/);
  assert.doesNotMatch(readme, /saved tokenized partial record/);
  assert.match(readme, /The conformance fixture covers chunk framing, transfer control-message schemas used inside the encrypted channel including resume offsets, canonical signaling-message serialization, authenticated pair decisions with the fixed reject reason, fixed AES-GCM vectors for sealed manifest\/control\/bulk payloads, PAKE confirmation tags, SDP offer\/answer authentication, and ICE candidate authentication including username fragments/);
});

test("interop tests run the signaling server behind an explicit origin policy", () => {
  const e2eTest = fs.readFileSync(new URL("../test/e2e/cli-transfer.test.ts", import.meta.url), "utf8");
  const browserTest = fs.readFileSync(new URL("../test/browser/browser-cli-send.test.ts", import.meta.url), "utf8");
  assert.match(readme, /browser sender to CLI receiver, CLI sender to browser download receiver, CLI sender to browser opaque-name download receiver, CLI sender to browser folder-only receiver, CLI sender to browser opaque-name folder receiver, valid browser folder resume from a saved partial, browser resume-key replacement, browser resume-registry metadata scrubbing, and browser folder restart after a corrupted saved partial/);
  assert.match(browserTest, /CLI sender interoperates with browser opaque-name download receiver/);
  assert.match(browserTest, /CLI sender interoperates with browser folder-only receiver/);
  assert.match(browserTest, /CLI sender interoperates with browser opaque-name folder receiver/);
  assert.match(browserTest, /browser folder receiver restarts after a corrupted saved partial/);
  assert.match(browserTest, /browser folder receiver resumes from a valid saved partial/);
  assert.match(browserTest, /browser startup scrubs legacy resume registry metadata/);
  assert.match(browserTest, /installFolderPickerMock\(page\)/);
  assert.match(browserTest, /seedLegacyBrowserResumeRegistry\(page\)/);
  assert.match(browserTest, /finalName: "secret-name\.txt"/);
  assert.match(browserTest, /browserResumeRegistryObject\(page\)/);
  assert.match(browserTest, /setFolderMockFailure\(page, 1\)/);
  assert.match(browserTest, /corruptFolderPartFile\(page, partial\.partFiles\[0\]!\)/);
  assert.match(browserTest, /operation === `createWritable:\$\{partial\.partFiles\[0\]\}:reset`/);
  assert.match(browserTest, /operation\.startsWith\(`write:\$\{partial\.partFiles\[0\]\}:0:`\)/);
  assert.match(browserTest, /operation === `createWritable:\$\{partName\}:keep`/);
  assert.match(browserTest, /operation === `truncate:\$\{partName\}:\$\{resumeBytes\}`/);
  assert.match(browserTest, /operation === `seek:\$\{partName\}:\$\{resumeBytes\}`/);
  assert.match(browserTest, /operation\.startsWith\(`write:\$\{partName\}:\$\{resumeBytes\}:`\)/);
  assert.match(browserTest, /operation\.startsWith\(`write:\$\{partName\}:0:`\)/);
  assert.match(browserTest, /waitForNewCode\(page, firstCode!\)/);
  assert.match(browserTest, /#folderOnly/);
  assert.match(browserTest, /#folderButton/);
  assert.match(browserTest, /#resumeButton/);
  for (const source of [e2eTest, browserTest]) {
    assert.match(source, /NODE_ENV: "production"/);
    assert.match(source, /ALLOWED_ORIGINS: origin/);
    assert.match(source, /SIGNALING_TOPOLOGY: "single-instance"/);
    assert.match(source, /ALLOW_INSECURE_ORIGINS: "true"/);
    assert.match(source, /function testChildEnv\(tmp: string\): NodeJS\.ProcessEnv/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(process\.env, name\)/);
    assert.match(source, /spawn\(process\.execPath/);
    assert.doesNotMatch(source, /\.\.\.process\.env/);
    assert.doesNotMatch(source, /ALLOW_ANY_ORIGIN/);
  }
});

test("CI and release workflows pin third-party actions to reviewed full-length commits", () => {
  const seenActions = new Set<string>();
  for (const workflow of [ciWorkflow, releaseWorkflow, codeqlWorkflow, scorecardWorkflow, dependencyReviewWorkflow]) {
    const actionUses = [
      ...workflow.matchAll(/uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)@([a-f0-9]{40}|[^\s#]+)(?:\s+#\s+(v[0-9][^\s]+))?/g)
    ];
    assert.notEqual(actionUses.length, 0);
    for (const match of actionUses) {
      const repo = match[1]!;
      const ref = match[2]!;
      const version = match[3];
      const expected = PINNED_ACTIONS.get(repo);
      assert.ok(expected, `${repo} must be explicitly reviewed before use`);
      seenActions.add(repo);
      assert.equal(ref, expected.sha, `${repo} must be pinned to reviewed commit ${expected.sha}`);
      assert.equal(version, expected.version, `${repo} pin must document the audited upstream tag`);
    }
    assert.doesNotMatch(workflow, /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@v[0-9]/);
  }
  assert.deepEqual([...PINNED_ACTIONS.keys()].sort(), [...seenActions].sort());
});

test("dependency update automation covers npm, GitHub Actions, and Docker", () => {
  assert.match(dependabotConfig, /package-ecosystem: npm[\s\S]*directory: \//);
  assert.match(dependabotConfig, /package-ecosystem: github-actions[\s\S]*directory: \//);
  assert.match(dependabotConfig, /package-ecosystem: docker[\s\S]*directory: \//);
});

function actionUseCount(workflow: string, action: string): number {
  return workflow.match(new RegExp(`uses: ${escapeRegExp(action)}@`, "g"))?.length ?? 0;
}

function workflowJob(workflow: string, job: string): string {
  const start = workflow.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `missing workflow job ${job}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

function assertEveryWorkflowJobHasTimeout(workflow: string): void {
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "workflow must contain jobs");
  const jobsDocument = workflow.slice(jobsStart);
  const jobs = Array.from(jobsDocument.matchAll(/\n  ([a-z][a-z0-9-]*):\n/g), (match) => {
    const job = match[1];
    if (typeof job !== "string") throw new Error("workflow job capture failed");
    return job;
  });
  assert.notEqual(jobs.length, 0, "workflow must contain jobs");
  for (const job of jobs) {
    assert.match(workflowJob(workflow, job), /\n    timeout-minutes: [1-9][0-9]?\n/, `${job} must set timeout-minutes`);
  }
}
