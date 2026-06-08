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

5. Configure npm trusted publishing for `@victorhaine/p2p-transfer`. Set the trusted publisher to GitHub repository `VictorHaine/p2p-transfer`, workflow `.github/workflows/release.yml`, environment `npm`, and the GitHub Actions publish action. Do not add `NPM_TOKEN`; the checked publisher rejects static npm tokens and requires OIDC trusted publishing.

6. Add the repository secret `RELEASE_PREFLIGHT_TOKEN` with the repository-administration, ruleset, private vulnerability reporting, dependency alert, repository security-analysis, Dependabot security-update, and Actions workflow-run visibility needed by release preflight. Use a fine-grained PAT or an externally rotated GitHub App installation token; do not store a raw one-hour installation token as a static secret unless rotation updates it before every release.

7. Plan GHCR visibility before the first public Docker release. GitHub Container Registry packages can be private on first publish; after the first workflow creates `ghcr.io/victorhaine/p2p-transfer`, set the package visibility to public. The release workflow verifies anonymous pulls for both `ghcr.io/victorhaine/p2p-transfer:vX.Y.Z` and `ghcr.io/victorhaine/p2p-transfer:X.Y.Z`, so a private package fails before the GitHub Release is created.

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
   git fetch origin main
   git checkout main
   git pull --ff-only origin main
   gh auth token | pnpm release:preflight --token-stdin
   ```

   Local preflight refuses unsigned `HEAD` and dirty worktrees before package or network work, then compares that local `HEAD` with GitHub's current `main` branch response. Do not tag from a different checkout than the one that passed preflight.

3. Create and push the matching release tag from that preflighted `HEAD` only after preflight is clean:

   ```sh
   pnpm release:tag -- v0.1.0
   git push origin v0.1.0
   ```

   The checked tag creator revalidates signed `HEAD`, clean worktree state, package-version matching, freshly fetched `origin/main` equality, local and remote tag absence, tag target, and tag signature while suppressing signer subprocess output. If post-create verification fails, it deletes only the tag it just created before reporting a generic failure. When using SSH commit or tag signing, configure `user.signingkey` to the public key file or literal public key, not the private key path; some signing helpers echo invalid key material in errors.

4. Let the GitHub release workflow publish npm, verify npm registry metadata, publish GHCR, provenance, checksums, SBOM, and the GitHub Release. Do not run `pnpm publish` manually; `prepublishOnly` blocks direct publishes by design.

## Current External Blockers

As of this runbook, local `pnpm verify:release` passes. The remaining known first-release blockers are external:

- the installed GitHub token needs `workflow` scope before workflow files can be pushed
- remote `main` must be pushed after refreshing that token scope
- GitHub release controls must be configured so the `p2p-transfer: protect main` ruleset enforces verified commit signatures and required status checks
- the npm package name must be bootstrapped with `pnpm bootstrap:npm --token-stdin --apply`
- npm trusted publishing must be configured for `.github/workflows/release.yml` and environment `npm`
- GHCR package visibility must be made public after first package creation before the anonymous Docker pull release gate can pass
- Docker policy smoke requires a responsive local Docker daemon
