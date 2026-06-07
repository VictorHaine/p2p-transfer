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
const codeowners = fs.readFileSync(new URL("../.github/CODEOWNERS", import.meta.url), "utf8");
const pullRequestTemplate = fs.readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");
const httpProbeScript = fs.readFileSync(new URL("../scripts/probe-http.mjs", import.meta.url), "utf8");
const releaseArtifactScript = fs.readFileSync(new URL("../scripts/verify-release-artifact.mjs", import.meta.url), "utf8");
const releaseChecksumScript = fs.readFileSync(new URL("../scripts/write-release-checksum.mjs", import.meta.url), "utf8");
const releaseNotesScript = fs.readFileSync(new URL("../scripts/write-release-notes.mjs", import.meta.url), "utf8");
const githubReleaseControlsScript = fs.readFileSync(new URL("../scripts/configure-github-release-controls.mjs", import.meta.url), "utf8");
const releaseReadinessScript = fs.readFileSync(new URL("../scripts/check-release-readiness.mjs", import.meta.url), "utf8");
const dependabotConfig = fs.readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
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
const PINNED_RUNNERS = ["ubuntu-24.04", "macos-15", "windows-2025"];
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
  assert.match(dockerfile, new RegExp(String.raw`corepack prepare pnpm@${escapeRegExp(pnpmVersion)} --activate`));
  assert.match(dockerfile, /^COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/m);
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
  assert.match(securityPolicy, /release tags matching `v\*` must be protected by a GitHub tag protection rule or repository ruleset/);
  assert.match(readme, /tag protection rule or repository ruleset for `v\*` release tags/);
  assert.match(readme, /Protect `v\*` tags with a ruleset\/tag-protection rule before the first release/);
  assert.match(securityPolicy, /release tag commit must be reachable from protected `main` before release artifact packaging, attestation, npm publish, or GitHub Release creation/);
  assert.match(releaseWorkflow, /fetch-depth: 0/);
  assert.match(releaseWorkflow, /Verify release tag is on main[\s\S]*git fetch --no-tags --prune origin \+refs\/heads\/main:refs\/remotes\/origin\/main[\s\S]*git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  const ciVerifyJob = workflowJob(ciWorkflow, "verify");
  const ciPlatformSmokeJob = workflowJob(ciWorkflow, "platform-smoke");
  const releasePlatformSmokeJob = workflowJob(releaseWorkflow, "platform-smoke");
  for (const runner of PINNED_RUNNERS) {
    assert.match(ciWorkflow, new RegExp(escapeRegExp(runner)));
    assert.match(releaseWorkflow, new RegExp(escapeRegExp(runner)));
  }
  assert.match(ciVerifyJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native/);
  assert.doesNotMatch(ciVerifyJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(ciPlatformSmokeJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed/);
  assert.doesNotMatch(ciPlatformSmokeJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(releasePlatformSmokeJob, /node:\n\s+- 22\.22\.3\n\s+- 24\.13\.1/);
  assert.match(releasePlatformSmokeJob, /os:\n\s+- ubuntu-24\.04\n\s+- macos-15\n\s+- windows-2025/);
  assert.match(releasePlatformSmokeJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed/);
  assert.doesNotMatch(releasePlatformSmokeJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(ciWorkflow, /pnpm smoke:packed/);
  assert.match(ciWorkflow, /dependency audit[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.match(ciWorkflow, /verify production origin policy is required[\s\S]*docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e SIGNALING_TOPOLOGY=single-instance p2p-transfer:test[\s\S]*container started without ALLOWED_ORIGINS in production/);
  assert.match(ciWorkflow, /verify signaling topology policy is required[\s\S]*docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e ALLOWED_ORIGINS=https:\/\/files\.example\.com p2p-transfer:test[\s\S]*container started without SIGNALING_TOPOLOGY in production/);
  assert.match(ciWorkflow, /docker run -d --name p2p-transfer-test[\s\S]*--read-only[\s\S]*--cap-drop=ALL[\s\S]*--security-opt no-new-privileges[\s\S]*-e SIGNALING_TOPOLOGY=single-instance/);
  assert.match(ciWorkflow, /PROBE_URL=http:\/\/127\.0\.0\.1:8787\/healthz PROBE_STATUS=200 node scripts\/probe-http\.mjs/);
  assert.match(ciWorkflow, /verify bundled web UI[\s\S]*PROBE_URL=http:\/\/127\.0\.0\.1:8787\/ PROBE_STATUS=200 PROBE_CONTAINS='ff transfer' PROBE_MAX_BYTES=1048576 node scripts\/probe-http\.mjs/);
  assert.match(ciWorkflow, /verify origin policy[\s\S]*PROBE_URL=http:\/\/127\.0\.0\.1:8787\/v1\/ice PROBE_STATUS=403 PROBE_ORIGIN=https:\/\/evil\.example node scripts\/probe-http\.mjs/);
  assert.doesNotMatch(ciWorkflow, /fetch\('http:\/\/127\.0\.0\.1:8787|body\.includes\('ff transfer'\)/);
  assert.doesNotMatch(ciWorkflow, /ALLOW_ANY_ORIGIN/);
  const releaseVerifyJob = workflowJob(releaseWorkflow, "verify");
  assert.match(releaseVerifyJob, /pnpm check:install-state[\s\S]*pnpm build[\s\S]*pnpm check[\s\S]*pnpm test:unit[\s\S]*pnpm smoke:native[\s\S]*pnpm smoke:packed[\s\S]*pnpm test:e2e[\s\S]*pnpm security:audit[\s\S]*pnpm security:signatures/);
  assert.doesNotMatch(releaseVerifyJob, /pnpm test:unit[\s\S]*pnpm build[\s\S]*pnpm smoke:native/);
  assert.match(releaseWorkflow, /pack release artifact[\s\S]*pnpm --config\.ignore-scripts=true pack --pack-destination release-artifacts[\s\S]*node scripts\/write-release-checksum\.mjs/);
  assert.match(releaseChecksumScript, /return `\$\{packedPackageName\(name\)\}-\$\{version\}\.tgz`[\s\S]*const expectedTarballName = expectedTarballNameFor\(packageJson\)[\s\S]*entries\.length !== 1 \|\| !entries\[0\]\?\.isFile\(\) \|\| entries\[0\]\.name !== expectedTarballName[\s\S]*createHash\("sha256"\)[\s\S]*writeFile\(path\.join\(artifactDir, "SHA256SUMS"\), `\$\{checksum\}  \$\{expectedTarballName\}\\n`, \{ flag: "wx" \}\)/);
  assert.match(releaseNotesScript, /const headingPattern = \/\^##\\s\+\(\?:\\\[\(\?<bracketVersion>/);
  assert.match(releaseNotesScript, /writeFile\(path\.join\(projectRoot, "release-artifacts", "RELEASE_NOTES\.md"\), notes, \{ flag: "wx" \}\)/);
  assert.doesNotMatch(releaseWorkflow, /pack release artifact[\s\S]*(find release-artifacts|basename "\$tgz"|sha256sum)/);
  assert.match(releaseWorkflow, /verify production origin policy is required[\s\S]*docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e SIGNALING_TOPOLOGY=single-instance p2p-transfer:release[\s\S]*container started without ALLOWED_ORIGINS in production/);
  assert.match(releaseWorkflow, /verify signaling topology policy is required[\s\S]*docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e ALLOWED_ORIGINS=https:\/\/files\.example\.com p2p-transfer:release[\s\S]*container started without SIGNALING_TOPOLOGY in production/);
  assert.match(releaseWorkflow, /docker run -d --name p2p-transfer-release[\s\S]*--read-only[\s\S]*--cap-drop=ALL[\s\S]*--security-opt no-new-privileges[\s\S]*-e SIGNALING_TOPOLOGY=single-instance/);
  assert.match(releaseWorkflow, /PROBE_URL=http:\/\/127\.0\.0\.1:8787\/healthz PROBE_STATUS=200 node scripts\/probe-http\.mjs/);
  assert.match(releaseWorkflow, /verify bundled web UI[\s\S]*PROBE_URL=http:\/\/127\.0\.0\.1:8787\/ PROBE_STATUS=200 PROBE_CONTAINS='ff transfer' PROBE_MAX_BYTES=1048576 node scripts\/probe-http\.mjs/);
  assert.match(releaseWorkflow, /verify origin policy[\s\S]*PROBE_URL=http:\/\/127\.0\.0\.1:8787\/v1\/ice PROBE_STATUS=403 PROBE_ORIGIN=https:\/\/evil\.example node scripts\/probe-http\.mjs/);
  assert.doesNotMatch(releaseWorkflow, /fetch\('http:\/\/127\.0\.0\.1:8787|body\.includes\('ff transfer'\)/);
  assert.doesNotMatch(releaseWorkflow, /ALLOW_ANY_ORIGIN/);
  assert.equal(releaseWorkflow.match(/id-token:\s*write/g)?.length, 2);
  assert.match(releaseWorkflow, /publish npm package[\s\S]*permissions:\n      contents: read\n      id-token: write/);
  assert.match(releaseWorkflow, /attest release artifact[\s\S]*permissions:\n      contents: read\n      id-token: write\n      attestations: write/);
  assert.match(releaseWorkflow, /attest release artifact[\s\S]*verify downloaded release artifact[\s\S]*id: verify_artifact[\s\S]*node scripts\/verify-release-artifact\.mjs --print-tarball[\s\S]*uses: actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4\.1\.0[\s\S]*subject-path: \$\{\{ steps\.verify_artifact\.outputs\.tarball \}\}/);
  assert.match(releaseWorkflow, /verify downloaded release artifact[\s\S]*id: verify_artifact[\s\S]*node scripts\/verify-release-artifact\.mjs --print-tarball[\s\S]*smoke downloaded release artifact[\s\S]*tgz="\$\{\{ steps\.verify_artifact\.outputs\.tarball \}\}"[\s\S]*PACKED_SMOKE_TARBALL="\$tgz" node scripts\/smoke-packed\.mjs[\s\S]*publish npm package[\s\S]*pnpm publish "\$tgz" --provenance --access public --ignore-scripts/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*needs:\n      - publish[\s\S]*permissions:\n      contents: write[\s\S]*verify downloaded release artifact[\s\S]*node scripts\/verify-release-artifact\.mjs --print-tarball[\s\S]*write release notes[\s\S]*node scripts\/write-release-notes\.mjs[\s\S]*gh release create "\$GITHUB_REF_NAME" "\$tgz" release-artifacts\/SHA256SUMS --title "\$GITHUB_REF_NAME" --notes-file release-artifacts\/RELEASE_NOTES\.md/);
  assert.doesNotMatch(releaseWorkflow, /--notes-file CHANGELOG\.md/);
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  publish:"));
  assert.match(publishJob, /needs:\n      - verify\n      - attest\n      - docker\n      - platform-smoke/);
  assert.doesNotMatch(publishJob, /pnpm install|pnpm build|pnpm smoke:native/);
  assert.match(publishJob, /--ignore-scripts/);
  assert.doesNotMatch(publishJob, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("checked GitHub release controls setup matches the protected release surface", () => {
  assert.match(githubReleaseControlsScript, /const MAIN_RULESET_NAME = "p2p-transfer: protect main"/);
  assert.match(githubReleaseControlsScript, /const TAG_RULESET_NAME = "p2p-transfer: protect release tags"/);
  assert.match(githubReleaseControlsScript, /const NPM_ENVIRONMENT = "npm"/);
  assert.match(githubReleaseControlsScript, /const REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID = 5/);
  assert.match(githubReleaseControlsScript, /const MAX_NPM_ENVIRONMENT_REVIEWERS = 6/);
  assert.ok(
    githubReleaseControlsScript.indexOf("class GitHubApiError") < githubReleaseControlsScript.indexOf("if (isMain())"),
    "GitHub API errors must be initialized before the direct entrypoint can run"
  );
  assert.match(githubReleaseControlsScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(githubReleaseControlsScript, /endsWith\("\/configure-github-release-controls\.mjs"\)/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{options\.repository\}\/rulesets\/\$\{existing\.id\}`/);
  assert.match(githubReleaseControlsScript, /"PUT", `\/repos\/\$\{options\.repository\}\/environments\/\$\{encodeURIComponent\(NPM_ENVIRONMENT\)\}`/);
  assert.match(githubReleaseControlsScript, /reviewers: await Promise\.all\(options\.npmReviewers\.map\(async \(login\) => \(\{ type: "User", id: await userId\(token, login\) \}\)\)\)/);
  assert.match(githubReleaseControlsScript, /prevent_self_review: options\.preventSelfReview/);

  for (const check of [
    "verify",
    "browser interop",
    "production docker policy",
    "platform smoke / ubuntu-24.04 / node 22.22.3",
    "platform smoke / ubuntu-24.04 / node 24.13.1",
    "platform smoke / macos-15 / node 22.22.3",
    "platform smoke / macos-15 / node 24.13.1",
    "platform smoke / windows-2025 / node 22.22.3",
    "platform smoke / windows-2025 / node 24.13.1"
  ]) {
    assert.match(githubReleaseControlsScript, new RegExp(escapeRegExp(`"${check}"`)));
  }

  assert.match(githubReleaseControlsScript, /conditions: \{ ref_name: \{ include: \["refs\/heads\/main"\], exclude: \[\] \} \}/);
  assert.match(githubReleaseControlsScript, /conditions: \{ ref_name: \{ include: \["refs\/tags\/v\*"\], exclude: \[\] \} \}/);
  assert.match(githubReleaseControlsScript, /type: "pull_request"[\s\S]*require_code_owner_review: true[\s\S]*require_last_push_approval: true[\s\S]*required_approving_review_count: 1[\s\S]*required_review_thread_resolution: true/);
  assert.match(githubReleaseControlsScript, /type: "required_status_checks"[\s\S]*do_not_enforce_on_create: true[\s\S]*strict_required_status_checks_policy: true[\s\S]*required_status_checks: REQUIRED_CI_CHECKS\.map\(\(context\) => \(\{ context \}\)\)/);
  assert.match(githubReleaseControlsScript, /bypass_actors: \[\{ actor_type: "RepositoryRole", actor_id: REPOSITORY_ADMIN_ROLE_BYPASS_ACTOR_ID, bypass_mode: "always" \}\]/);
  assert.match(githubReleaseControlsScript, /type: "creation"[\s\S]*type: "deletion"[\s\S]*type: "non_fast_forward"/);
  assert.doesNotMatch(githubReleaseControlsScript, /tag_name_pattern/);
  assert.match(releaseWorkflow, /^on:\n  push:\n    tags:\n      - "v\*\.\*\.\*"$/m);
  assert.match(githubReleaseControlsScript, /Push main before applying GitHub release controls\./);
  assert.match(githubReleaseControlsScript, /The npm environment exists but has no protection rules/);
  assert.match(githubReleaseControlsScript, /--npm-reviewer/);
  assert.match(githubReleaseControlsScript, /--prevent-self-review/);
  assert.match(githubReleaseControlsScript, /--allow-self-review/);
  assert.match(githubReleaseControlsScript, /Npm environment reviewer must be a GitHub username\./);
  assert.match(githubReleaseControlsScript, /Npm environment reviewers must be unique\./);
  assert.match(githubReleaseControlsScript, /Npm environment can have at most \$\{MAX_NPM_ENVIRONMENT_REVIEWERS\} reviewers\./);
  assert.ok(
    githubReleaseControlsScript.indexOf("environments/${encodeURIComponent(NPM_ENVIRONMENT)}") <
      githubReleaseControlsScript.indexOf("for (const ruleset of desired)"),
    "npm environment setup must run before mutating rulesets"
  );
  assert.ok(
    githubReleaseControlsScript.indexOf("The npm environment exists but has no protection rules") <
      githubReleaseControlsScript.indexOf("for (const ruleset of desired)"),
    "npm environment protection must be checked before mutating rulesets"
  );

  assert.match(readme, /create the `npm` environment[\s\S]*required reviewers or an equivalent approval gate/);
  assert.match(readme, /scripts\/configure-github-release-controls\.mjs --apply --npm-reviewer <github-login>/);
  assert.match(readme, /creates\/updates the `npm` environment approval gate plus the branch and release-tag rulesets/);
  assert.match(readme, /refuses to mutate repository rulesets if the `npm` environment still has no protection rules/);
  assert.match(securityPolicy, /setup script must be able to create or update the `npm` environment approval gate from explicit reviewers/);
  assert.match(securityPolicy, /setup script must[\s\S]*fail before mutating repository rulesets when the `npm` environment is missing approval protection/);
});

test("release preflight checks external GitHub release prerequisites", () => {
  assert.equal(packageJson.scripts?.["release:preflight"], "node scripts/check-release-readiness.mjs");
  assert.match(readme, /GITHUB_TOKEN="\$\(gh auth token\)" pnpm release:preflight/);
  assert.match(securityPolicy, /local release preflight must fail before tagging when the GitHub token lacks `workflow` scope/);
  assert.match(releaseReadinessScript, /const REQUIRED_OAUTH_SCOPES = \["repo", "workflow"\]/);
  assert.match(releaseReadinessScript, /headers\.get\("x-oauth-scopes"\)/);
  assert.match(releaseReadinessScript, /GitHub token is missing \$\{scope\} scope\./);
  assert.match(releaseReadinessScript, /\/repos\/\$\{options\.repository\}\/branches\/main/);
  assert.match(releaseReadinessScript, /Remote main branch is missing\. Push main before releasing\./);
  assert.match(releaseReadinessScript, /assertRequiredRuleset\(rulesets, MAIN_RULESET_NAME, "branch"\)/);
  assert.match(releaseReadinessScript, /assertRequiredRuleset\(rulesets, TAG_RULESET_NAME, "tag"\)/);
  assert.match(releaseReadinessScript, /ruleset\.target !== target \|\| ruleset\.enforcement !== "active"/);
  assert.match(releaseReadinessScript, /GitHub npm environment has no protection rules\./);
  assert.match(releaseReadinessScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(releaseReadinessScript, /NPM_TOKEN|NODE_AUTH_TOKEN|npm publish|git tag/);
});

test("security-sensitive surfaces require code owner review", () => {
  assert.match(securityPolicy, /security-sensitive crypto, protocol, release, dependency, dependency-review artifacts, Docker, server, and file-publish surfaces must be covered by `\.github\/CODEOWNERS`/);
  assert.match(readme, /branch protection for `main` requiring CI and CODEOWNERS review/);
  for (const path of [
    "/.github/",
    "/Dockerfile",
    "/package.json",
    "/pnpm-lock.yaml",
    "/pnpm-workspace.yaml",
    "/SECURITY.md",
    "/docs/security/",
    "/conformance/",
    "/scripts/",
    "/src/shared/security.ts",
    "/src/shared/messages.ts",
    "/src/shared/chunks.ts",
    "/src/shared/transfer.ts",
    "/src/cli/files.ts",
    "/src/cli/secure.ts",
    "/src/cli/transfer.ts",
    "/src/server/",
    "/src/web/file-system.ts",
    "/test/security.test.ts",
    "/test/package-surface.test.ts",
    "/test/deployment-surface.test.ts",
    "/test/release-artifact-verifier.test.ts",
    "/test/release-checksum-writer.test.ts",
    "/test/release-notes-writer.test.ts"
  ]) {
    assert.match(codeowners, new RegExp(`^${escapeRegExp(path)}\\s+@VictorHaine$`, "m"), `${path} must be owned`);
  }
});

test("CodeQL code scanning is pinned and least-privilege", () => {
  assert.match(securityPolicy, /CodeQL code scanning must run from a pinned workflow on pull requests, pushes to `main`, and a weekly schedule/);
  assert.match(readme, /\.github\/workflows\/codeql\.yml` runs pinned CodeQL analysis/);
  assert.match(codeqlWorkflow, /^name: codeql$/m);
  assert.match(codeqlWorkflow, /^on:\n  pull_request:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "17 3 \* \* 2"$/m);
  assert.match(codeqlWorkflow, /^permissions:\n  contents: read\n  security-events: write$/m);
  assert.match(codeqlWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(codeqlWorkflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2[\s\S]*persist-credentials: false/);
  assert.match(codeqlWorkflow, /uses: github\/codeql-action\/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*languages: javascript-typescript/);
  assert.match(codeqlWorkflow, /uses: github\/codeql-action\/analyze@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*category: "\/language:javascript-typescript"/);
  assert.doesNotMatch(codeqlWorkflow, /id-token:\s*write|contents:\s*write|pull-requests:\s*write|actions:\s*write/);
});

test("OpenSSF Scorecard scanning is pinned and uploads SARIF", () => {
  assert.match(securityPolicy, /OpenSSF Scorecard must run from a pinned workflow on pushes to `main` and a weekly schedule/);
  assert.match(readme, /\.github\/workflows\/scorecard\.yml` runs the pinned Scorecard action/);
  assert.match(scorecardWorkflow, /^name: scorecard$/m);
  assert.match(scorecardWorkflow, /^on:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "29 4 \* \* 3"$/m);
  assert.match(scorecardWorkflow, /^permissions:\n  contents: read\n  security-events: write\n  id-token: write$/m);
  assert.match(scorecardWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(scorecardWorkflow, /uses: ossf\/scorecard-action@4eaacf0543bb3f2c246792bd56e8cdeffafb205a # v2\.4\.3[\s\S]*results_file: scorecard-results\.sarif[\s\S]*results_format: sarif[\s\S]*publish_results: true/);
  assert.match(scorecardWorkflow, /uses: github\/codeql-action\/upload-sarif@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4\.36\.2[\s\S]*sarif_file: scorecard-results\.sarif/);
  assert.doesNotMatch(scorecardWorkflow, /contents:\s*write|pull-requests:\s*write|actions:\s*write|packages:\s*write/);
});

test("dependency review blocks vulnerable dependency introductions", () => {
  assert.match(securityPolicy, /GitHub dependency review must run from a pinned workflow on pull requests with read-only permissions and fail on vulnerable runtime or development dependency changes at low severity or higher/);
  assert.match(readme, /\.github\/workflows\/dependency-review\.yml` runs the pinned GitHub dependency review action on pull requests/);
  assert.match(dependencyReviewWorkflow, /^name: dependency-review$/m);
  assert.match(dependencyReviewWorkflow, /^on:\n  pull_request:$/m);
  assert.match(dependencyReviewWorkflow, /^permissions:\n  contents: read$/m);
  assert.match(dependencyReviewWorkflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m);
  assert.match(dependencyReviewWorkflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2[\s\S]*persist-credentials: false/);
  assert.match(dependencyReviewWorkflow, /uses: actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5\.0\.0[\s\S]*vulnerability-check: true[\s\S]*license-check: false[\s\S]*fail-on-severity: low[\s\S]*fail-on-scopes: runtime, development[\s\S]*comment-summary-in-pr: never[\s\S]*show-patched-versions: true/);
  assert.doesNotMatch(dependencyReviewWorkflow, /pull_request_target|workflow_run|contents:\s*write|pull-requests:\s*write|id-token:\s*write|actions:\s*write|packages:\s*write/);
});

test("documented release gates require a hardened Docker runtime smoke, not just image build", () => {
  for (const document of [readme, securityPolicy]) {
    assert.match(document, /pnpm install --frozen-lockfile\npnpm verify:local/);
    assert.match(document, /pnpm install --frozen-lockfile\npnpm verify:release/);
    assert.match(document, /docker build -t p2p-transfer:test \./);
    assert.match(document, /docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e SIGNALING_TOPOLOGY=single-instance p2p-transfer:test/);
    assert.match(document, /container started without ALLOWED_ORIGINS in production/);
    assert.match(document, /docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -e ALLOWED_ORIGINS=https:\/\/files\.example\.com p2p-transfer:test/);
    assert.match(document, /container started without SIGNALING_TOPOLOGY in production/);
    assert.match(document, /docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges -p 8787:8787 -e ALLOWED_ORIGINS=https:\/\/files\.example\.com -e SIGNALING_TOPOLOGY=single-instance p2p-transfer:test/);
    assert.doesNotMatch(document, /Required Security Gates[\s\S]*docker build -t p2p-transfer:test \.\n```/);
  }
  assert.match(securityPolicy, /packed-install checks on Linux, macOS, and Windows for every supported Node major/);
  assert.match(securityPolicy, /packs the verified npm tarball with lifecycle scripts disabled after the explicit verified build/);
  assert.match(securityPolicy, /derives the expected packed tarball name from the checked package name and exact semver version before writing `SHA256SUMS`/);
  assert.match(securityPolicy, /validates the single downloaded tarball filename, regular-file status, size cap, checksum, packed `package\/package\.json` name and version, and release tag/);
  assert.match(securityPolicy, /packed-install smokes that exact downloaded tarball/);
  assert.match(securityPolicy, /packed-install smoke must byte-cap the provided tarball path by UTF-8 bytes, no-follow-open, identity-check, and stage the verified tarball into a distinct no-follow-copied file in its private temp workspace before fresh-project install/);
  assert.match(securityPolicy, /provided tarball paths must reject terminal control\/format characters and staging\/open failures must not echo raw tarball paths/);
  assert.match(securityPolicy, /smoke-tested artifact to npm with provenance/);
  assert.match(securityPolicy, /The publish job must not reinstall dependencies, rebuild, or run publish lifecycle scripts before publish/);
  assert.match(securityPolicy, /packed-install smoke that verifier-emitted downloaded tarball path/);
  assert.match(securityPolicy, /pass the verifier-emitted tarball path to packed smoke and `pnpm publish` instead of rediscovering the artifact with `find` or a shell glob after verification/);
  assert.match(securityPolicy, /The release workflow must not support manual dispatch/);
  assert.match(securityPolicy, /release artifacts, npm publishes, and GitHub Releases must only be produced from `v\*` tags that match `package\.json` version/);
  assert.match(securityPolicy, /package-surface tests must run after the release build/);
  assert.match(securityPolicy, /checked release-artifact verifier/);
  assert.match(securityPolicy, /publish that resolved tarball path with `--ignore-scripts`/);
  assert.match(securityPolicy, /Release publishing must use npm trusted publishing with OIDC provenance, not long-lived `NPM_TOKEN` secrets/);
  assert.match(securityPolicy, /GitHub Releases must be tag-only, run only after npm publishing succeeds, re-verify the downloaded npm tarball/);
  assert.match(readme, /OIDC trusted publishing from the `npm` environment/);
  assert.match(readme, /creates the GitHub Release with that exact tarball plus `SHA256SUMS`/);
  assert.match(readme, /runs the packed-install smoke against a no-follow-verified staged copy of that downloaded tarball/);
  assert.match(securityPolicy, /trusted publishing from the GitHub `npm` environment/);
  assert.match(securityPolicy, /must not use static npm tokens/);
  assert.match(securityPolicy, /proves the production Docker image independently refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`/);
  assert.match(securityPolicy, /verifies `\/healthz`, origin policy, and the bundled web UI from that running container/);
  assert.match(securityPolicy, /explicit signaling topology/);
});

test("Docker HTTP probes are bounded and timeout protected", () => {
  assert.match(securityPolicy, /Docker image healthchecks must use the checked HTTP probe script instead of inline fetch snippets/);
  assert.match(securityPolicy, /Docker runtime HTTP probes must use the checked probe script with a symlink-safe realpath entrypoint check, validated response byte caps, request environment byte caps, an abort deadline, disabled redirects, deterministic URL\/origin parse failures, probe-owned top-level failure reporting that does not echo raw probe URLs or stack traces, fatal UTF-8 response decoding, and fail-closed URL validation that rejects credential-bearing, query-bearing, or fragment-bearing probe URLs/);
  assert.match(httpProbeScript, /const PROBE_TIMEOUT_MS = 10_000/);
  assert.match(httpProbeScript, /const MAX_RESPONSE_BYTES = 1_048_576/);
  assert.match(httpProbeScript, /const MAX_ENV_VALUE_BYTES = 2_048/);
  assert.match(httpProbeScript, /function utf8ByteLengthExceeds/);
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
  assert.match(securityPolicy, /release artifact verification must use the checked script with a symlink-safe realpath entrypoint check and verifier-owned top-level failure reporting that does not print stack traces or raw path-sensitive evidence, validate artifact directory entry names before sorting, filtering, or reporting them/);
  assert.match(securityPolicy, /reject control\/format\/path-shaped or over-byte-budget entry names without echoing them/);
  assert.match(securityPolicy, /prove the downloaded artifact directory contains only `SHA256SUMS` and the expected tarball/);
  assert.match(releaseWorkflow, /verify downloaded release artifact[\s\S]*node scripts\/verify-release-artifact\.mjs/);
  assert.doesNotMatch(releaseWorkflow, /verify release artifact checksum[\s\S]*sha256sum -c SHA256SUMS/);
  assert.doesNotMatch(releaseWorkflow, /node --input-type=module <<'NODE'/);
  assert.match(releaseWorkflow, /pack release artifact[\s\S]*node scripts\/write-release-checksum\.mjs/);
  assert.match(releaseChecksumScript, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(releaseChecksumScript, /realpathSync\(process\.argv\[1\]\) === realpathSync\(scriptPath\)/);
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
  assert.doesNotMatch(releaseArtifactScript, /process\.cwd\(\)/);
  assert.match(releaseArtifactScript, /const MAX_PROJECT_PACKAGE_JSON_BYTES = 128 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_PACKED_PACKAGE_JSON_BYTES = 64 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_TAR_SCAN_BYTES = 256 \* 1024 \* 1024/);
  assert.match(releaseArtifactScript, /const MAX_CHECKSUM_FILE_BYTES = 256/);
  assert.match(releaseArtifactScript, /requiredPackageName\(expected\.name\)/);
  assert.match(releaseArtifactScript, /requiredPackageVersion\(expected\.version\)/);
  assert.match(releaseArtifactScript, /const packedName = requiredPackageName\(packed\.name, "package\/package\.json name"\)/);
  assert.match(releaseArtifactScript, /const packedVersion = requiredPackageVersion\(packed\.version, "package\/package\.json version"\)/);
  assert.match(releaseArtifactScript, /requiredReleaseTag\(envString\("GITHUB_REF_NAME"\), expectedVersion\)/);
  assert.match(releaseArtifactScript, /utf8ByteLengthExceeds\(descriptor\.value, MAX_RELEASE_ENV_VALUE_BYTES\)/);
  assert.match(releaseArtifactScript, /release tag does not match package version \$\{version\}/);
  assert.doesNotMatch(releaseArtifactScript, /release tag \$\{value\} does not match/);
  assert.match(releaseArtifactScript, /release artifact package metadata does not match the checked workspace metadata/);
  assert.doesNotMatch(releaseArtifactScript, /String\(packed\.name\)|String\(packed\.version\)/);
  assert.match(releaseArtifactScript, /const MAX_ARTIFACT_ENTRY_NAME_BYTES = 255/);
  assert.match(releaseArtifactScript, /\(await readdir\(artifactDir\)\)\.map\(releaseArtifactEntryName\)/);
  assert.match(releaseArtifactScript, /function releaseArtifactEntryName\(value\)/);
  assert.match(releaseArtifactScript, /release-artifacts contains an invalid artifact entry name/);
  assert.match(releaseArtifactScript, /assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /function assertExactArtifactEntries\(entries, expectedBasename\)/);
  assert.match(releaseArtifactScript, /release-artifacts must contain only/);
  assert.match(releaseArtifactScript, /if \(tarballs\[0\] !== expectedBasename\)/);
  assert.match(releaseArtifactScript, /if \(!info\.isFile\(\)\)/);
  assert.match(releaseArtifactScript, /if \(info\.size < 1 \|\| info\.size > MAX_TARBALL_BYTES\)/);
  assert.match(releaseArtifactScript, /SHA256SUMS must contain exactly one checksum for the release tarball/);
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
  assert.match(releaseArtifactScript, /if \(actual !== match\[1\]\)/);
  assert.match(releaseArtifactScript, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/);
  assert.match(releaseArtifactScript, /if \(!sameFile\(info, opened\)\) throw new Error\("release tarball changed before verification\."\)/);
  assert.match(releaseArtifactScript, /await tarball\.handle\.close\(\)/);
  assert.match(releaseArtifactScript, /tarball\.handle\.createReadStream\(\{ start: 0, end: tarball\.size - 1, autoClose: false \}\)/);
  assert.match(releaseArtifactScript, /release tarball changed while being read/);
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
  assert.doesNotMatch(readme, /## MVP gaps/);
  assert.match(readme, /## Known limitations/);
  assert.match(readme, /Browser receive resume is exposed only through the explicit `Resume in folder` accept action/);
  assert.match(readme, /preserves opaque tokenized `\.part` files on failure/);
  assert.match(readme, /saved opaque partial record and browser-held lookup key/);
  assert.match(readme, /scrub legacy metadata-bearing resume records/);
  assert.doesNotMatch(readme, /saved tokenized partial record/);
  assert.match(readme, /The conformance fixture covers chunk framing, encrypted transfer control messages including resume offsets, canonical signaling-message serialization, PAKE confirmation tags, SDP offer\/answer authentication, and ICE candidate authentication including username fragments/);
});

test("interop tests run the signaling server behind an explicit origin policy", () => {
  const e2eTest = fs.readFileSync(new URL("../test/e2e/cli-transfer.test.ts", import.meta.url), "utf8");
  const browserTest = fs.readFileSync(new URL("../test/browser/browser-cli-send.test.ts", import.meta.url), "utf8");
  for (const source of [e2eTest, browserTest]) {
    assert.match(source, /NODE_ENV: "production"/);
    assert.match(source, /ALLOWED_ORIGINS: origin/);
    assert.match(source, /SIGNALING_TOPOLOGY: "single-instance"/);
    assert.match(source, /ALLOW_INSECURE_ORIGINS: "true"/);
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
