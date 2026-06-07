## Summary

- 

## Verification

- [ ] `pnpm verify:local`
- [ ] `pnpm verify:release` for protocol, crypto, browser, dependency, release, or file-write changes
- [ ] `DOCKER_SMOKE_TAG=p2p-transfer:test pnpm verify:release:docker` for Docker, deployment, release, or server changes

## Security Impact

- [ ] No protocol, crypto, file-write, dependency, release, Docker, or deployment security invariant changed.
- [ ] Relevant `SECURITY.md` invariants and conformance fixtures were updated.
