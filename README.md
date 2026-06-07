# p2p-transfer

End-to-end encrypted peer-to-peer file transfer with:

- tiny in-memory WebSocket signaling server
- CLI sender/receiver, installed as `ff`
- static browser client
- WebRTC DataChannels for the data path
- receiver accept gate before file bytes move
- chunked transfer with backpressure and SHA-256 verification
- short copyable handles in the form `12345678-two-words` using two distinct BIP39 English words
- receiver-side filename sanitization and transfer limit enforcement
- browser receive streams to the File System Access API when available, with download fallback
- browser folder receives save with an `ff-<random>` suffix to avoid silently overwriting local files
- browser Blob download fallback is capped at 128 MiB to avoid RAM-exhaustion; larger browser receives require Save to folder

Privacy boundary: file contents and real manifests are end-to-end encrypted from the signaling server, but this is not network or endpoint opacity. Signaling/network observers can still see IPs, roles, timing, byte volume, traffic shape, and SDP/ICE metadata, and a privileged local MDM/EDR administrator can still observe selected files and plaintext at the endpoint before encryption or after decryption.

## Current security status

This build implements the required untrusted-signaling security layer:

- CPace PAKE derives a per-session key from the full handle.
- Both peers exchange a PAKE-derived confirmation tag before any pair request is accepted into the receive flow.
- The sender encrypts the real pair-request manifest before it crosses the signaling server.
- WebRTC signaling frames, including SDP offers/answers and ICE candidates, are HMAC-authenticated with the PAKE-derived key, so a signaling-server MITM cannot silently swap WebRTC DTLS fingerprints or inject routing candidates.
- DataChannel control messages and bulk file chunks are AES-GCM encrypted with direction-specific keys derived from the PAKE output.
- After WebRTC is connected and both DataChannels are open, file streaming no longer depends on signaling socket liveness; the signaling path is only best-effort teardown at that point.
- Receiver codes expire after a small bounded number of sender rendezvous claims, limiting online guessing and prefix-squatting before the accept gate.
- Both peers display the same short SAS for optional out-of-band comparison.

The signaling server sees the public eight-digit rendezvous prefix, IP-level connection metadata, roles, session timing, accept/reject/teardown events, total transfer bytes, file count, signaling frame sizes, PAKE public shares/tags, and authenticated SDP/ICE contents. Conforming clients do not send the two secret words, usable file names, MIME types, file contents, PAKE secrets, DataChannel plaintext, or declared per-file sizes except what is inferable from total bytes and file count, including exact size for single-file transfers. A modified client can still transmit a malformed public pair-request containing plaintext metadata before rejection; the server rejects unredacted public manifests and does not forward or log them.

## Install and build

Use the released package after the first npm publish:

```sh
pnpm add -g @victorhaine/p2p-transfer
ff recv
read -rs FF_CODE </dev/tty
find ./to-send -maxdepth 1 -type f | { printf '%s\n' "$FF_CODE"; cat; } | ff send --code-stdin --files-stdin
unset FF_CODE
```

Run the packaged server:

```sh
NODE_ENV=production \
ALLOWED_ORIGINS='https://files.example.com' \
SIGNALING_TOPOLOGY=single-instance \
ff-server
```

Build from source:

```sh
node scripts/prepare-checked-pnpm.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The npm package name is `@victorhaine/p2p-transfer`; the installed binaries are still `ff` and `ff-server`.
The npm package is CLI/server-first and intentionally has no supported JavaScript import surface; use the `ff` and `ff-server` binaries instead of deep-importing `dist-node/*`.

Runtime requirement: Node.js 22.22.3 through the latest Node.js 22 patch, or Node.js 24.13.1 through the latest Node.js 24 patch. Node.js 23 is intentionally unsupported because it is not part of the CI/platform-smoke matrix. CI, release, and Docker builds pin Node.js 22.22.3 so published artifacts are built against an exact runtime patch level instead of a floating major tag. Docker base images are also pinned by immutable digest; update the tag and digest together during base-image maintenance.

## Run locally

Start the signaling server:

```sh
pnpm dev:server
```

Receive from the CLI:

```sh
pnpm dev:cli -- recv
```

Send from the CLI:

```sh
read -rs FF_CODE </dev/tty
find ./to-send -maxdepth 1 -type f | { printf '%s\n' "$FF_CODE"; cat; } | pnpm dev:cli -- send --code-stdin --files-stdin
unset FF_CODE
```

Run the browser client:

```sh
pnpm dev:web
```

Open the Vite URL and keep the server field pointed at:

```text
ws://127.0.0.1:8787/v1/ws
```

## Production shape

Build artifacts are split intentionally:

- `dist-node/` contains the CLI and signaling server.
- `dist-web/` contains static browser assets for any CDN/static host.

Run the built signaling server:

```sh
NODE_ENV=production \
ALLOWED_ORIGINS='https://files.example.com' \
SIGNALING_TOPOLOGY=single-instance \
pnpm start
```

When installed globally, the same server entrypoint is available as `ff-server`:

```sh
NODE_ENV=production \
ALLOWED_ORIGINS='https://files.example.com' \
SIGNALING_TOPOLOGY=single-instance \
ff-server
```

The same server also serves `dist-web/` when it exists, so a single process can host the web UI and `WS /v1/ws` for early deployments. Set `WEB_ROOT` to override the static asset directory.

Use the built CLI:

```sh
node dist-node/cli/index.js recv --out ./downloads
read -rs FF_CODE </dev/tty
find ./to-send -maxdepth 1 -type f | { printf '%s\n' "$FF_CODE"; cat; } | node dist-node/cli/index.js send --code-stdin --files-stdin
unset FF_CODE
```

If local shell history or process-argument telemetry matters, avoid putting the full code or local paths in argv. Read the code without echo, pass file paths through stdin, and clear the environment variable after the child process starts:

```sh
read -rs FF_RECEIVE_CODE
find ./to-send -maxdepth 1 -type f | FF_RECEIVE_CODE="$FF_RECEIVE_CODE" node dist-node/cli/index.js send --code-env FF_RECEIVE_CODE --files-stdin
unset FF_RECEIVE_CODE
```

`--code-env` and `--out-env` only avoid argv and shell-history exposure. Environment variables are not a secrecy boundary against process-environment telemetry, same-user inspection windows, privileged endpoint tools, or MDM/EDR.
Interactive send commands print a generic warning on stderr whenever the receive code or local file paths are still accepted from argv. `recv --code` and `recv --out` print the same kind of generic warning for supplied receive codes or output directories in argv. The warnings never include the code or paths, and they are suppressed for `--json`, `--quiet`, and non-TTY stderr.
Use `--require-private-input` in automation that must fail closed instead of accepting receive codes, receive output directories, or send code/file paths from argv.
Use `--local-private-mode` when you want the local CLI privacy preset: it enables `--require-private-input` and `--redact-output`, and for `recv` also enables `--opaque-output-names`. Because generated receive codes would be redacted, `recv --local-private-mode` requires `--code-stdin` or `--code-env`.

Useful CLI flags:

- `--server <url>`: use a self-hosted signaling server.
- `--json`: emit machine-readable events.
- `--quiet`: suppress human-readable progress.
- `--redact-output`: redact transfer codes, SAS, file names, MIME types, file counts, byte counts, and per-file placeholders from local CLI output, JSON events, and error text for log-collected automation. It does not hide signaling/server metadata, peer-visible metadata, endpoint telemetry, ICE candidates, timing, or traffic shape.
- `--require-private-input`: reject `recv --code`, `recv --out`, `send <code>`, and send file paths supplied through argv; use `--code-stdin`/`--code-env`, `recv --out-env`, and `send --files-stdin` instead.
- `--local-private-mode`: enable the local privacy preset (`--require-private-input`, `--redact-output`, and `recv --opaque-output-names`). It is a local CLI guardrail only, not protection from privileged endpoint monitoring or network metadata. Receivers must supply a private code with `recv --code-stdin` or `recv --code-env` because generated codes are intentionally redacted.
- `--relay`: force relay-only ICE when TURN is configured, reducing local and public endpoint candidate exposure to peers and signaling logs.
- `--no-server-ice`: ignore signaling-provided STUN/TURN endpoints and use only the built-in public STUN defaults. This reduces trust in the rendezvous operator's ICE configuration, but disables that server's TURN fallback.
- `send --code-stdin`: read the receive code from piped stdin instead of argv.
- `send --code-env <name>`: read the receive code from an environment variable instead of argv.
- `send --files-stdin`: read newline-delimited file paths from stdin instead of argv.
- `recv --yes`: auto-accept, required for headless receive flows. This bypasses the interactive consent gate, so use it only with a private receive code in trusted automation.
- `recv --code <code>`: use a supplied code like `12345678-two-words` instead of generating one.
- `recv --code-stdin` / `recv --code-env <name>`: provide that supplied receive code without putting it directly in argv. Supplied receive codes are not reprinted in the CLI registered event or human output.
- `recv --out-env <name>`: read the output directory from an environment variable instead of argv. In private-input mode, use this or the current working directory instead of `recv --out`.
- `recv --resume`: keep failed CLI partials and resume a later attempt from the last verified chunk boundary. The final SHA-256 still has to match before publish.
- `recv --opaque-output-names`: publish received files as `ff-<token>` names instead of peer-supplied basenames. With `--resume`, the final name is a stable HMAC-derived opaque name in that output directory.
  CLI resume also keeps a private `.ff-resume-key` in the output directory so resumable `.part` file names stay opaque; delete that key together with stale `ff-resume-*.part` files to reset local resume state.

The browser client has matching ICE controls in the header. `Relay only` sets WebRTC `iceTransportPolicy` to `relay`, requires a credentialed TURN server, and fails immediately if none is configured; it may reduce connectivity, but avoids exposing direct host/server-reflexive ICE candidates to the peer.
For sensitive browser receives, enable `Folder only` before starting receive. It requires the File System Access API and streams to folder-backed partial files instead of the memory-backed Blob download fallback.
Enable `Opaque output names` before starting receive when final browser output names must not include peer-supplied basenames. Normal browser receive names include the sanitized original basename plus a random reservation token for usability; opaque mode publishes `ff-<token>` names instead.
Use `Clear resume records` to remove browser origin resume records and the browser-held resume lookup key. Browser-cleared resume state does not delete `ff-*.part` files already written into receive folders; delete those stale folder entries manually when needed.

Exit codes:

- `0`: success
- `1`: generic failure
- `2`: declined/rejected transfer
- `3`: timeout, NAT, or WebRTC connection failure
- `4`: security/integrity failure
- `130`: interrupted by SIGINT/SIGTERM after best-effort transfer cleanup

## Server endpoints

- `GET /healthz`
- `GET /v1/version`
- `GET /v1/ice`
- `WS /v1/ws`

The WebSocket broker keeps only in-memory state, matches peers by the public eight-digit rendezvous prefix, enforces one-shot registrations, validates manifest limits, rate-limits registration/connect attempts and ICE credential issuance, rejects malformed or duplicated `Origin`/`Host` headers before policy checks, caps signaling frames at 256 KiB, and applies hard global caps to waiting codes and active sessions.

Metadata privacy is intentionally limited and should be understood before using the tool:

| Observer | Can learn | Should not learn |
| --- | --- | --- |
| Signaling server | client IPs, public rendezvous prefix, roles, session timing, accept/reject/teardown events, the fixed authenticated `pair-reject` reason `user_declined`, total transfer bytes, file count, signaling frame sizes, PAKE public shares/tags, authenticated SDP/ICE contents including host/private LAN ICE candidates, public server-reflexive candidates, relay candidates, whether clients accept its ICE endpoint hints, and malformed unredacted manifests from modified clients before rejection | from conforming clients and accepted protocol flow: two secret words, PAKE output, plaintext file names, MIME types, file bytes, DataChannel control plaintext, and declared per-file sizes except what is inferable from total bytes and file count, including exact size for single-file transfers |
| STUN server | client public IP/port and ICE timing | code, manifest, file names, file bytes |
| TURN server | client IPs, relay allocation timing, packet sizes, traffic volume/duration | file bytes or DataChannel plaintext |
| Network observer | endpoints, DNS/SNI where applicable, timing, traffic volume, traffic shape, peer IPs for direct WebRTC, TURN use when relayed, and the absence of padding or cover traffic | file bytes or DataChannel plaintext when using `wss://` and WebRTC |
| Managed endpoint / MDM / EDR | selected CLI paths, file open/read/write/rename events, browser DOM text, browser download/folder names, final output names, process argv/environment windows, peer/server connections, timing, byte volume, and local plaintext before send or after receive | cryptography does not hide local endpoint activity from a privileged endpoint monitor |
| Peer | real manifest before consent, SAS, transfer timing, resume offsets, ICE metadata, and transferred file contents | nothing in the accepted transfer is hidden from the chosen peer |

Per-file sizes in the server-visible pair request are synthetic placeholders that sum to the real total. The encrypted manifest still gives the receiver the real names, sizes, and MIME types before consent.

If you do not trust the rendezvous operator's ICE endpoint choices, use CLI `--no-server-ice` or clear the browser `Server ICE/TURN` checkbox. The signaling server will still see authenticated SDP/ICE signaling metadata, but it cannot make the client use operator-supplied STUN/TURN endpoints. Direct connection reliability may drop because server-provided TURN fallback is skipped. Relay-only ICE reduces direct peer IP exposure to the other peer, but it shifts traffic metadata to the TURN operator; it does not hide timing, byte volume, or traffic shape.
When server ICE/TURN is enabled, clients still fall back to the built-in public STUN servers if no post-accept `ice-config` arrives within about one second while signaling remains open; disable server ICE/TURN when public STUN fallback is the only acceptable endpoint policy.

Because rendezvous state is in memory, production and non-loopback deployments must set `SIGNALING_TOPOLOGY=single-instance` or `SIGNALING_TOPOLOGY=sticky-sessions`. Do not put multiple random replicas behind a load balancer unless every receiver/sender WebSocket pair for a rendezvous is pinned to the same process or you replace the in-memory rendezvous map with shared state.

Configure ICE servers with `ICE_SERVERS` as JSON:

```sh
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"}]' pnpm start
```

TURN can be added with coturn REST-style ephemeral credentials:

```sh
export TURN_REST_SECRET="$(openssl rand -base64 32)"
TURN_URLS='["turn:turn.example.com:3478?transport=tcp"]' \
TURN_TTL_SECONDS=3600 \
pnpm start
```

`TURN_REST_SECRET` must be at least 32 bytes and should be generated randomly. Static TURN credentials in `ICE_SERVERS` work for private non-production testing, but production mode rejects them because they expose a reusable relay password to every client. Use `TURN_REST_SECRET`/`TURN_URLS` for public deployments so clients receive short-lived credentials only after the receiver sends a `pair-accept` that passes server role and phase policy. Clients verify that accept decision end-to-end with the PAKE-derived signal-auth key before starting ICE; the server must not learn that key, cannot verify the accept cryptographically, and does not decrypt the manifest. Unauthenticated `GET /v1/ice`, unmatched receive-code registrations, and pre-accept rendezvous matches never return TURN URLs or mint TURN REST credentials. The CLI `--relay` flag forces relay-only ICE when TURN is present.

For public deployments, restrict browser WebSocket origins with `ALLOWED_ORIGINS`. Production mode requires `ALLOWED_ORIGINS`; non-loopback binds such as `HOST=0.0.0.0`, `HOST=::`, or a public hostname also require it even outside production mode. When `ALLOWED_ORIGINS` is omitted, browser `Origin` traffic is accepted only when both the request `Host` and browser `Origin` are loopback, so public websites and loopback-bound servers accidentally exposed through a public reverse proxy fail closed for browser WebSocket and CORS requests:

```sh
ALLOWED_ORIGINS='https://files.example.com,https://www.files.example.com' pnpm start
```

CLI clients do not send a browser `Origin` header and remain allowed.
The signaling server defaults to `PORT=8787`; if `PORT` is set, it must be a fixed integer between 1 and 65535. `PORT=0` is rejected instead of silently binding a random ephemeral port.
In production, `ALLOWED_ORIGINS` entries must use `https://`; set `ALLOW_INSECURE_ORIGINS=true` only for private deployments behind a trusted network boundary.

If TLS terminates at a reverse proxy, the server normally sees the proxy socket IP for every client, which collapses connection and rate-limit buckets. Set `TRUSTED_PROXY_HOPS=1` and `TRUSTED_PROXY_IPS='<proxy-ip-or-cidr>'` only when every public request reaches the app through exactly one trusted reverse proxy that overwrites or appends a valid `X-Forwarded-For` header and direct-to-app traffic is blocked. `TRUSTED_PROXY_IPS` accepts exact IP literals or CIDR ranges for the actual socket peer, not hostnames. Leave both unset for direct exposure; attacker-supplied `X-Forwarded-For` is ignored by default.
Clients reject plain `ws://` signaling URLs except localhost/loopback. Use `wss://` for any remote signaling server.
The served browser app's production Content Security Policy permits same-origin signaling only by default. Local development allows loopback `ws://` signaling sockets; in production, set `BROWSER_ALLOW_LOOPBACK_WS=true` only for a deliberate private deployment that needs browser-to-localhost signaling. If you intentionally host one static web UI that must connect to arbitrary custom `wss://` signaling servers, set `BROWSER_ALLOW_ANY_WSS=true`; both switches widen the browser exfiltration surface and should not be the default for public production deployments.
Host the browser client on a dedicated origin. Browser resume records are opaque, but they live in origin-scoped storage; unrelated scripts on the same origin could inspect opaque registry entries and use the browser-held lookup key to test guessed manifest identities.

## Docker

Production-shaped run, assuming TLS terminates at `https://files.example.com` and forwards to this container:

```sh
docker build -t p2p-transfer .
docker run --rm -p 8787:8787 \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  -e ALLOWED_ORIGINS='https://files.example.com' \
  -e SIGNALING_TOPOLOGY=single-instance \
  -e TRUSTED_PROXY_HOPS=1 \
  -e TRUSTED_PROXY_IPS='172.17.0.1' \
  p2p-transfer
```

Replace `172.17.0.1` with the exact reverse-proxy address, or a narrow CIDR for the container bridge or private proxy subnet.

Local browser smoke run, deliberately allowing the loopback HTTP origin:

```sh
docker run --rm -p 8787:8787 \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  -e ALLOWED_ORIGINS='http://127.0.0.1:8787' \
  -e ALLOW_INSECURE_ORIGINS=true \
  -e SIGNALING_TOPOLOGY=single-instance \
  p2p-transfer
```

## Verification

Fast local verification:

```sh
node scripts/prepare-checked-pnpm.mjs
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm verify:local
```

Full release verification:

```sh
node scripts/prepare-checked-pnpm.mjs
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
DOCKER_SMOKE_TAG=p2p-transfer:test pnpm verify:release:docker
```

`pnpm verify:release` runs the full non-Docker local release gate and runs `pnpm security:dependencies` before the build so CPace vectors plus reviewed crypto/native dependency attestations remain an explicit release gate, not only part of the broad unit-test glob. `pnpm verify:release:docker` runs that same gate plus the hardened Docker policy smoke; use it before release and for Docker, deployment, release, or server changes when a Docker daemon is available.
`pnpm test` runs the production build, unit crypto/protocol tests, built CLI end-to-end transfer test, and browser/CLI interop tests.
`pnpm test:browser` verifies browser sender to CLI receiver, browser sender resume into a CLI receiver partial, CLI sender to browser download receiver, CLI sender to browser opaque-name download receiver, CLI sender to browser folder-only receiver, CLI sender to browser opaque-name folder receiver, valid single-file browser folder resume from a saved partial, invalid resume-key isolation for ordinary folder receives, browser resume-registry metadata scrubbing, and browser folder restart after a corrupted saved partial with Playwright. Install Chromium with `pnpm exec playwright install --with-deps chromium`; set `PLAYWRIGHT_CHROMIUM=/path/to/chromium` only when using an existing local browser binary. Missing Chromium is a hard test failure unless `FF_ALLOW_BROWSER_TEST_SKIP=true` is set explicitly; do not set that variable for release verification.
`pnpm smoke:native` loads WebRTC through the built CLI `nativeWebRtc()` guard, creates a DataChannel, and completes local offer/answer SDP negotiation. `pnpm smoke:packed` packs the verified workspace, installs that tarball into a fresh consumer project with native dependency build scripts enabled only for the reviewed native packages, verifies the published `ff` bin reports the expected protocol/version, boots the published `ff-server` bin, checks both `/healthz` and the bundled web UI, then transfers a file through installed `ff recv` and `ff send` with `--local-private-mode` plus stdin code/file inputs and environment-sourced receive output, verifies the receive path is opaque, and compares received bytes. `pnpm smoke:release-artifact` runs real `pnpm pack`, writes the CycloneDX `SBOM.cdx.json`, writes `SHA256SUMS` for both release evidence files, and runs the release artifact verifier against that complete artifact set so local release verification exercises the same artifact shape used by the release workflow.
`pnpm smoke:docker-policy` proves the production Docker image refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`, then boots it with both policies explicit, a loopback-only random host port, a read-only filesystem, dropped Linux capabilities, and `no-new-privileges`, and checks `/healthz`, origin policy, and the bundled web UI; a build-only Docker pass is not treated as enough for release. CI and release run the same checked script. The release workflow runs a pre-publish Docker validation gate before npm publish, then after npm publish it smoke-tests the exact GHCR release tag before pushing it, pushes `ghcr.io/victorhaine/p2p-transfer:vX.Y.Z` and `ghcr.io/victorhaine/p2p-transfer:X.Y.Z`, and attaches GitHub provenance to the pushed image digest. Platform smoke runs the packed-install check on Linux x64, Linux arm64, macOS arm64, macOS Intel, and Windows x64 for each supported Node major because the CLI depends on native WebRTC bindings. Workflows use explicit hosted runner generations (`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`) rather than floating `*-latest` labels.
The release workflow is tag-only. Release artifacts, npm publishes, Docker images, and GitHub Releases are produced only from `v*.*.*` tags that match `package.json` version and exactly match protected `main`, not from manual workflow dispatches, branch-built artifacts, stale main ancestors, or off-main tag commits.
Before publishing, the release workflow downloads the exact npm tarball artifact, verifies its checksum and package metadata, re-checks through the GitHub API that the live release tag and live `main` still resolve to `GITHUB_SHA`, then runs the packed-install smoke against a no-follow-verified staged copy of that downloaded tarball rather than trusting a different tarball produced earlier in the job.
The verified tarball and SBOM are attested from `SHA256SUMS` with GitHub artifact attestations inside the `npm` environment approval gate before publish; the publish job downloads and verifies the artifact set but does not reinstall, rebuild, repack, or rediscover release contents. The Docker release job separately runs after npm publish, attests the pushed GHCR image digest, and pushes that provenance to the registry.
Npm publishing uses GitHub OIDC trusted publishing from the `npm` environment; configure the npm package trusted publisher instead of storing a long-lived `NPM_TOKEN` secret.
After npm and Docker publish succeed, the workflow re-verifies the downloaded tarball and SBOM again, extracts the matching version section from `CHANGELOG.md`, and creates the GitHub Release with that exact tarball plus `SHA256SUMS` and `SBOM.cdx.json`.
Package-surface tests run after the build in local verification, CI, and release, and assert the published `ff` and `ff-server` bin entrypoints keep their Node shebangs and executable mode.
Protocol conformance fixtures live in `conformance/protocol-v5.json` and are included in the npm package.

Security reporting and release invariants are documented in `SECURITY.md`.

## Release checklist

One-time repository setup:

```sh
git remote add origin https://github.com/VictorHaine/p2p-transfer.git
```

In GitHub:

- create the `npm` environment used by `.github/workflows/release.yml`, add required reviewers with self-review prevention, disable admin bypass, and restrict deployments to the `v*.*.*` tag policy before publishing
- ensure the `npm` environment has at least one reviewer with write, maintain, or admin repository permission other than the person or token owner that will push the release tag; a sole self-reviewer deadlocks the publish job, and read-only collaborators cannot approve the environment
- enable private vulnerability reporting; the checked release-control setup enables it with the GitHub `private-vulnerability-reporting` endpoint, and release preflight verifies that endpoint reports enabled before tagging
- enable dependency vulnerability alerts, repository secret scanning, secret scanning push protection, and Dependabot security updates; the checked release-control setup enables and re-reads those repository security controls, verifies the dedicated Dependabot status is unpaused, and release preflight reads GitHub `security_and_analysis`, `vulnerability-alerts`, and `automated-security-fixes` endpoints so tagging fails if any feature is disabled, paused, or hidden from the release token
- after the first `main` push, apply the checked release controls with `GITHUB_TOKEN=<admin-token> node scripts/configure-github-release-controls.mjs --apply --npm-reviewer <release-approver-login>`; this creates/updates the `npm` environment approval gate with self-review prevention, admin bypass disabled, and `v*.*.*` tag-only deployment, plus the exact repository rulesets that release preflight requires for `main` and `v*.*.*` release tags with no bypass actors. It refuses read-only or unknown reviewers, refuses to create a sole-reviewer self-approval deadlock, refuses `--allow-missing-main` outside dry-run mode, re-reads the persisted repository security controls, dependency vulnerability alert status, `npm` environment, persisted reviewer permissions, deployment tag policy, and repository ruleset details after writes, and refuses to mutate deployment policies or repository rulesets if GitHub returns a persisted reviewer without write, maintain, or admin permission; it also refuses to mutate repository rulesets if GitHub returns malformed, duplicate, unexpected, wrong-target, or bypass-enabled rulesets, or if persisted repository security controls are still disabled, dependency vulnerability alerts are still disabled, or Dependabot security updates are paused, the persisted `npm` environment still has no required-reviewer protection, still allows admin bypass or branch deployments, lacks the exact release-tag deployment policy, still has the authenticated setup operator as its sole required reviewer, or the persisted branch/tag rulesets do not exactly match the requested protected surface
- enable code scanning alerts; `.github/workflows/codeql.yml` runs pinned CodeQL analysis on pull requests, pushes to `main`, and a weekly schedule; release preflight requires a successful CodeQL run for the exact current `main` commit before tagging
- enable OpenSSF Scorecard alerts; `.github/workflows/scorecard.yml` runs the pinned Scorecard action on pushes to `main`, manual dispatch, and a weekly schedule, then uploads SARIF to code scanning; release preflight requires a successful Scorecard run for the exact current `main` commit before tagging
- keep dependency review required on pull requests; `.github/workflows/dependency-review.yml` runs the pinned GitHub dependency review action on pull requests and blocks vulnerable runtime or development dependency changes at low severity or higher
- keep the dependency integrity monitor enabled; `.github/workflows/dependency-integrity.yml` runs on pushes to `main`, manual dispatch, and weekly with read-only permissions, then re-checks the frozen install, installed dependency tree, reviewed CPace/native dependency attestations, npm advisory audit, and registry package signatures even when `main` has not changed; release preflight requires a successful dependency-integrity run for the exact current `main` commit before tagging
- enable artifact attestations for the release workflow; `.github/workflows/release.yml` attests the same verifier-checked npm tarball and SBOM inside the `npm` environment approval gate before publish
- create an Actions secret named `RELEASE_PREFLIGHT_TOKEN` from a GitHub App installation token or fine-grained PAT that can read repository metadata including `security_and_analysis`, dependency vulnerability alert status, private vulnerability reporting status, the `main` branch, Actions secret metadata, Actions workflow run metadata, repository rulesets including bypass actors, repository environments, and deployment branch policies; classic PATs, OAuth tokens, refresh tokens, and user access tokens are rejected in the release workflow before package or network work. The tag workflow runs the checked release preflight before installing dependencies, so `${{ github.token }}` is not enough for this gate

First remote bootstrap:

```sh
gh auth refresh -h github.com -s workflow
git push -u origin main
```

`main` must exist remotely before `pnpm release:preflight` can pass. The first push needs a GitHub token with `workflow` scope because this repository ships GitHub Actions workflow files. After that first push, apply the checked release controls above. Once those controls are active, do not direct-push release changes to `main`; merge through the protected pull-request path.

In npm:

- create or verify ownership of the `@victorhaine` scope
- if `@victorhaine/p2p-transfer` does not exist yet, create the package with the checked one-time bootstrap helper, then revoke that publish credential:

```sh
pnpm bootstrap:npm --dry-run
read -rs NPM_BOOTSTRAP_TOKEN
printf %s "$NPM_BOOTSTRAP_TOKEN" | pnpm bootstrap:npm --apply --token-stdin
unset NPM_BOOTSTRAP_TOKEN
```

  The helper publishes only a minimal temporary `0.0.0-bootstrap.0` package from a private temp directory under the non-default `bootstrap` dist-tag, then re-reads npm registry metadata and fails unless that version exists, the `bootstrap` dist-tag points to it, and `latest` does not. It accepts the one-time token through bounded piped stdin with `--token-stdin` so the token does not need to appear in `ff`/pnpm process argv or exported environment, and it rejects interactive terminal stdin instead of waiting for a typed token. It does not mutate this workspace, does not publish the real release artifact, does not publish the placeholder as `latest`, and refuses to run when the npm package already exists. Do not bootstrap `0.1.0` if the tag workflow is expected to publish `v0.1.0`; npm versions cannot be reused.
- configure trusted publishing for package `@victorhaine/p2p-transfer`; npm currently requires the package to exist first, and `package.json` `repository.url` must exactly match this GitHub repository
- set the trusted publisher to this GitHub repository, workflow `.github/workflows/release.yml`, environment `npm`

Release:

```sh
node scripts/prepare-checked-pnpm.mjs
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
DOCKER_SMOKE_TAG=p2p-transfer:test pnpm verify:release:docker
node scripts/write-release-notes.mjs --check
gh auth refresh -h github.com -s workflow
GITHUB_TOKEN="$(gh auth token)" pnpm release:preflight
git fetch origin main
git tag v0.1.0 origin/main
git push origin v0.1.0
```

For normal releases, fetch `origin/main` and tag that exact remote commit after the protected pull request has merged.

The tag starts the release workflow. It verifies the tag matches `package.json`, verifies the tagged commit exactly matches protected `main`, verifies the npm package already exists, verifies any bootstrap placeholder is not tagged as `latest`, verifies the target version has not been published, verifies private vulnerability reporting is enabled, verifies dependency vulnerability alerts are enabled, verifies repository secret scanning and secret scanning push protection are enabled, verifies Dependabot security updates are enabled and unpaused, repeats the release gate, attests the exact checked tarball and SBOM from `SHA256SUMS`, publishes that tarball to npm with provenance, smoke-tests and publishes the GHCR image with registry provenance, then creates the GitHub Release with the same tarball, `SHA256SUMS`, and `SBOM.cdx.json`. The checked repository ruleset for `v*.*.*` tags must be active before the first release; it protects matching release tags from deletion and movement without enabling GitHub's creation restriction, because creation restriction with no bypass actor would make first-party release tags impossible. Release authority is instead gated by exact protected-`main` tag checks plus the npm environment approval gate until a dedicated release bot can be given an explicit audited bypass.

## License

MIT. See `LICENSE`.

## Known limitations

- A local MDM/EDR administrator can still observe selected files through endpoint controls, including file picker choices, CLI file opens, writes, renames, browser DOM previews, browser download behavior, final output names, and local plaintext before encryption or after decryption. `--local-private-mode` combines the CLI local guardrails, `send --code-stdin`, `send --code-env`, and `send --files-stdin` reduce shell-history and `ff` process-argv exposure, `recv --opaque-output-names` avoids peer basenames in final CLI receive paths, and browser `Opaque output names` avoids peer basenames in final browser receive names, but none of those options protect from a privileged endpoint monitor.
- Environment variables are local process metadata. `--code-env` and `--out-env` delete the variable after capture, but local process telemetry or privileged observers may still see it briefly; use `--code-stdin` for receive codes and the current working directory for receive output when you need to avoid both argv and environment exposure.
- CLI output is metadata-bearing by default for consent, progress, and detailed failures. Use `--redact-output` for log-collected automation; it redacts local CLI output only and does not hide metadata from the signaling server, peer, endpoint telemetry, ICE candidates, timing, or the network.
- `--files-stdin` protects the `ff` process argv only. The command that produces the file list can still leak local paths through its own argv, shell history, terminal logs, or endpoint telemetry; use operational controls around the producer command when that matters.
- `--require-private-input` makes argv fallback a command error, but it does not hide paths from the command that enumerates them or from local file-open telemetry.
- Browsers without File System Access support can only receive transfers up to the 128 MiB Blob fallback cap. The Blob fallback keeps browser-managed plaintext buffers until the browser has completed or revoked the download URL; use `Folder only` for sensitive receives.
- Browser folder receives cannot get CLI-style exclusive create from File System Access, so every browser-created folder entry must carry an unguessable `ff-<128-bit>` reservation token; data streams to opaque tokenized `.part` entries and publishes a final tokenized name only after hash verification. `Folder only` protects streaming behavior and partial-overwrite handling. Use browser `Opaque output names` as well when final browser output names must not include the sanitized original basename.
- Browser receive resume is exposed only through the explicit `Resume in folder` accept action and only for single-file manifests. It preserves an opaque tokenized `.part` file on failure and can resume a later matching manifest only when the same browser profile still has a fresh saved opaque partial record and browser-held lookup key, and the user selects a folder containing that entry. Browser startup and registry reads scrub expired or legacy metadata-bearing resume records so saved records do not retain plaintext filenames, MIME types, or sizes. `Clear resume records` removes browser-held resume registry/key state but cannot enumerate or delete old `ff-*.part` files in previously selected folders. Multi-file browser receives start fresh on retry because the browser path does not yet track already-published completed files without leaking more metadata into origin storage. Without saved browser state, or when using the Blob download fallback, browser receive starts fresh. This is intentionally narrower than CLI `recv --resume` because File System Access does not provide CLI-style path identity and atomic publish primitives.

The conformance fixture covers chunk framing, transfer control-message schemas used inside the encrypted channel including resume offsets, canonical signaling-message serialization, authenticated pair decisions with the fixed reject reason, fixed AES-GCM vectors for sealed manifest/control/bulk payloads, PAKE confirmation tags, SDP offer/answer authentication, and ICE candidate authentication including username fragments.
