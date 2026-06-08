# Release Runbook

This project releases only from protected `main` with a matching `v*.*.*` tag. Do not tag until every local and external gate below passes.

## One-time Repository Setup

1. Refresh the local GitHub token with workflow scope:

   ```sh
   gh auth refresh -h github.com -s workflow
   ```

2. Push `main` after the token has `workflow` scope. GitHub rejects workflow files from OAuth tokens that lack that scope.

   ```sh
   git push -u origin main
   ```

3. Bootstrap the npm package name once, before trusted publishing can validate that the package exists. Use an npm automation token with publish rights for `@victorhaine/p2p-transfer`; the script publishes only `0.0.0-bootstrap.0` under the `bootstrap` dist-tag and refuses to touch `latest`.

   ```sh
   read -rs NPM_BOOTSTRAP_TOKEN
   printf '%s' "$NPM_BOOTSTRAP_TOKEN" | pnpm bootstrap:npm --token-stdin --apply
   unset NPM_BOOTSTRAP_TOKEN
   ```

4. Configure GitHub release controls after remote `main` exists. Supply reviewers for the `npm` environment who are not the release operator or tag pusher.

   ```sh
   gh auth token | node scripts/configure-github-release-controls.mjs --token-stdin --apply --npm-reviewer <github-user>
   ```

5. Add the repository secret `RELEASE_PREFLIGHT_TOKEN` with the repository-administration, ruleset, private vulnerability reporting, dependency alert, repository security-analysis, Dependabot security-update, and Actions workflow-run visibility needed by release preflight.

## Per-release Checklist

1. Install with the checked pnpm version and run the full local release gate:

   ```sh
   node scripts/prepare-checked-pnpm.mjs
   pnpm install --frozen-lockfile
   pnpm exec playwright install --with-deps chromium
   DOCKER_SMOKE_TAG=p2p-transfer:test pnpm verify:release:docker
   ```

2. Rerun external preflight from the exact commit that will be tagged:

   ```sh
   gh auth token | pnpm release:preflight --token-stdin
   ```

3. Create and push the matching release tag only after preflight is clean:

   ```sh
   git tag -s v0.1.0 -m v0.1.0
   git push origin v0.1.0
   ```

4. Let the GitHub release workflow publish npm, GHCR, provenance, checksums, SBOM, and the GitHub Release draft. Do not run `pnpm publish` manually; `prepublishOnly` blocks direct publishes by design.

## Current External Blockers

As of this runbook, local `pnpm verify:release` passes. The remaining known first-release blockers are external:

- the installed GitHub token needs `workflow` scope
- remote `main` must be pushed
- the npm package name must be bootstrapped with `pnpm bootstrap:npm --token-stdin --apply`
- Docker policy smoke requires a responsive local Docker daemon
