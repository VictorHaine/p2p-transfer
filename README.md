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

The signaling server sees the public eight-digit rendezvous prefix, IP-level connection metadata, roles, session timing, accept/reject/teardown events, total transfer bytes, file count, signaling frame sizes, PAKE public shares/tags, and authenticated SDP/ICE contents. It does not receive the two secret words, usable file names, MIME types, file contents, PAKE secrets, DataChannel plaintext, or the true per-file size distribution.

## Install and build

```sh
pnpm install
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
pnpm dev:cli -- send <code> ./path/to/file
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
node dist-node/cli/index.js send <code> ./file.zip
```

If local shell history or process-argument telemetry matters, avoid putting the full code or local paths in argv. Read the code without echo, pass file paths through stdin, and clear the environment variable after the child process starts:

```sh
read -rs FF_RECEIVE_CODE
find ./to-send -maxdepth 1 -type f | FF_RECEIVE_CODE="$FF_RECEIVE_CODE" node dist-node/cli/index.js send --code-env FF_RECEIVE_CODE --files-stdin
unset FF_RECEIVE_CODE
```

`--code-env` only avoids argv and shell-history exposure. Environment variables are not a secrecy boundary against process-environment telemetry, same-user inspection windows, privileged endpoint tools, or MDM/EDR.
Interactive send commands print a generic warning on stderr whenever the receive code or local file paths are still accepted from argv. `recv --code` prints the same kind of generic warning for supplied receive codes in argv. The warnings never include the code or paths, and they are suppressed for `--json`, `--quiet`, and non-TTY stderr.

Useful CLI flags:

- `--server <url>`: use a self-hosted signaling server.
- `--json`: emit machine-readable events.
- `--quiet`: suppress human-readable progress.
- `--redact-output`: redact file names, MIME types, and byte counts from CLI output, JSON events, and error text for log-collected automation.
- `--relay`: force relay-only ICE when TURN is configured, reducing local and public endpoint candidate exposure to peers and signaling logs.
- `--no-server-ice`: ignore signaling-provided STUN/TURN endpoints and use the built-in public STUN defaults. This reduces trust in the rendezvous operator's ICE configuration, but disables that server's TURN fallback.
- `send --code-stdin`: read the receive code from piped stdin instead of argv.
- `send --code-env <name>`: read the receive code from an environment variable instead of argv.
- `send --files-stdin`: read newline-delimited file paths from stdin instead of argv.
- `recv --yes`: auto-accept, required for headless receive flows. This bypasses the interactive consent gate, so use it only with a private receive code in trusted automation.
- `recv --code <code>`: use a supplied code like `12345678-two-words` instead of generating one.
- `recv --code-stdin` / `recv --code-env <name>`: provide that supplied receive code without putting it directly in argv. Supplied receive codes are not reprinted in the CLI registered event or human output.
- `recv --resume`: keep failed CLI partials and resume a later attempt from the last verified chunk boundary. The final SHA-256 still has to match before publish.

The browser client has matching ICE controls in the header. `Relay only` sets WebRTC `iceTransportPolicy` to `relay`, which requires TURN and may reduce connectivity, but avoids exposing direct host/server-reflexive ICE candidates to the peer.

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
| Signaling server | client IPs, public rendezvous prefix, roles, session timing, accept/reject/teardown events, total transfer bytes, file count, signaling frame sizes, PAKE public shares/tags, authenticated SDP/ICE contents, and whether clients accept its ICE endpoint hints | two secret words, PAKE output, plaintext file names, MIME types, file bytes, DataChannel control plaintext, true per-file size distribution |
| STUN server | client public IP/port and ICE timing | code, manifest, file names, file bytes |
| TURN server | client IPs, relay allocation timing, packet sizes, traffic volume/duration | file bytes or DataChannel plaintext |
| Network observer | endpoints, DNS/SNI where applicable, timing, traffic volume, peer IPs for direct WebRTC, TURN use when relayed | file bytes or DataChannel plaintext when using `wss://` and WebRTC |
| Peer | real manifest before consent, SAS, transfer timing, resume offsets, ICE metadata, and transferred file contents | nothing in the accepted transfer is hidden from the chosen peer |

Per-file sizes in the server-visible pair request are synthetic placeholders that sum to the real total. The encrypted manifest still gives the receiver the real names, sizes, and MIME types before consent.

If you do not trust the rendezvous operator's ICE endpoint choices, use CLI `--no-server-ice` or clear the browser `Server ICE/TURN` checkbox. The signaling server will still see authenticated SDP/ICE signaling metadata, but it cannot make the client use operator-supplied STUN/TURN endpoints. Direct connection reliability may drop because server-provided TURN fallback is skipped.

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

`TURN_REST_SECRET` must be at least 32 bytes and should be generated randomly. Static TURN credentials in `ICE_SERVERS` work for private non-production testing, but production mode rejects them because they expose a reusable relay password to every client. Use `TURN_REST_SECRET`/`TURN_URLS` for public deployments so clients receive short-lived credentials only after the receiver accepts the transfer, which requires successful PAKE confirmation and sealed-manifest decryption first; unauthenticated `GET /v1/ice`, unmatched receive-code registrations, and pre-accept rendezvous matches never return TURN URLs or mint TURN REST credentials. The CLI `--relay` flag forces relay-only ICE when TURN is present.

For public deployments, restrict browser WebSocket origins with `ALLOWED_ORIGINS`. Production mode requires `ALLOWED_ORIGINS`; non-loopback binds such as `HOST=0.0.0.0`, `HOST=::`, or a public hostname also require it even outside production mode. When `ALLOWED_ORIGINS` is omitted, browser `Origin` traffic is accepted only when both the request `Host` and browser `Origin` are loopback, so public websites and loopback-bound servers accidentally exposed through a public reverse proxy fail closed for browser WebSocket and CORS requests:

```sh
ALLOWED_ORIGINS='https://files.example.com,https://www.files.example.com' pnpm start
```

CLI clients do not send a browser `Origin` header and remain allowed.
The signaling server requires an explicit fixed `PORT` between 1 and 65535; `PORT=0` is rejected instead of silently binding a random ephemeral port.
In production, `ALLOWED_ORIGINS` entries must use `https://`; set `ALLOW_INSECURE_ORIGINS=true` only for private deployments behind a trusted network boundary.
Clients reject plain `ws://` signaling URLs except localhost/loopback. Use `wss://` for any remote signaling server.
The served browser app's production Content Security Policy permits same-origin signaling only by default. Local development allows loopback `ws://` signaling sockets; in production, set `BROWSER_ALLOW_LOOPBACK_WS=true` only for a deliberate private deployment that needs browser-to-localhost signaling. If you intentionally host one static web UI that must connect to arbitrary custom `wss://` signaling servers, set `BROWSER_ALLOW_ANY_WSS=true`; both switches widen the browser exfiltration surface and should not be the default for public production deployments.
Host the browser client on a dedicated origin. Browser resume records are opaque, but they live in origin-scoped storage; unrelated scripts on the same origin could inspect opaque registry entries and use the browser-held lookup key to test guessed manifest identities.

## Docker

```sh
docker build -t p2p-transfer .
docker run --rm -p 8787:8787 \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  -e ALLOWED_ORIGINS='https://files.example.com' \
  -e SIGNALING_TOPOLOGY=single-instance \
  p2p-transfer
```

## Verification

Fast local verification:

```sh
pnpm install --frozen-lockfile
pnpm verify:local
```

Full release verification:

```sh
pnpm install --frozen-lockfile
pnpm verify:release
DOCKER_SMOKE_TAG=p2p-transfer:test pnpm smoke:docker-policy
```

`pnpm test` runs the production build, unit crypto/protocol tests, built CLI end-to-end transfer test, and browser/CLI interop tests.
`pnpm test:browser` verifies browser sender to CLI receiver and CLI sender to browser receiver with Playwright. It requires Chromium; set `PLAYWRIGHT_CHROMIUM=/path/to/chromium` if auto-detection fails.
`pnpm smoke:native` loads the native `@roamhq/wrtc` binding inside its controlled smoke path, creates a DataChannel, and completes local offer/answer SDP negotiation. `pnpm smoke:packed` packs the verified workspace, installs that tarball into a fresh consumer project with native dependency build scripts enabled only for the reviewed native packages, verifies the published `ff` bin reports the expected protocol/version, then boots the published `ff-server` bin and checks both `/healthz` and the bundled web UI. `pnpm smoke:release-artifact` runs real `pnpm pack`, writes `SHA256SUMS`, and runs the release artifact verifier against that tarball so local release verification exercises the same artifact shape used by the release workflow.
`pnpm smoke:docker-policy` proves the production Docker image refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`, then boots it with both policies explicit, a loopback-only random host port, a read-only filesystem, dropped Linux capabilities, and `no-new-privileges`, and checks `/healthz`, origin policy, and the bundled web UI; a build-only Docker pass is not treated as enough for release. CI and release run the same checked script. Platform smoke runs the packed-install check on Linux, macOS, and Windows for each supported Node major because the CLI depends on native WebRTC bindings. Workflows use explicit hosted runner generations (`ubuntu-24.04`, `macos-15`, `windows-2025`) rather than floating `*-latest` labels.
The release workflow is tag-only. Release artifacts, npm publishes, and GitHub Releases are produced only from `v*` tags that match `package.json` version and point to commits already reachable from `main`, not from manual workflow dispatches, branch-built artifacts, or off-main tag commits.
Before publishing, the release workflow downloads the exact npm tarball artifact, verifies its checksum and package metadata, then runs the packed-install smoke against a no-follow-verified staged copy of that downloaded tarball rather than trusting a different tarball produced earlier in the job.
The same verified tarball is attested with GitHub artifact attestations before publish; the attestation job downloads and verifies the artifact but does not reinstall, rebuild, repack, or rediscover release contents.
Npm publishing uses GitHub OIDC trusted publishing from the `npm` environment; configure the npm package trusted publisher instead of storing a long-lived `NPM_TOKEN` secret.
After npm publish succeeds, the workflow re-verifies the downloaded tarball again, extracts the matching version section from `CHANGELOG.md`, and creates the GitHub Release with that exact tarball plus `SHA256SUMS`.
Package-surface tests run after the build in local verification, CI, and release, and assert the published `ff` and `ff-server` bin entrypoints keep their Node shebangs and executable mode.
Protocol conformance fixtures live in `conformance/protocol-v5.json` and are included in the npm package.

Security reporting and release invariants are documented in `SECURITY.md`.

## Release checklist

One-time repository setup:

```sh
git remote add origin https://github.com/VictorHaine/p2p-transfer.git
```

In GitHub:

- create the `npm` environment used by `.github/workflows/release.yml` and add required reviewers or an equivalent approval gate before publishing
- enable private vulnerability reporting
- create branch protection for `main` requiring CI and CODEOWNERS review
- create a tag protection rule or repository ruleset for `v*` release tags so only maintainers can create or update release tags
- after `main` exists remotely, apply the checked release controls with `GITHUB_TOKEN=<admin-token> node scripts/configure-github-release-controls.mjs --apply --npm-reviewer <github-login>`; this creates/updates the `npm` environment approval gate plus the branch and release-tag rulesets, and refuses to mutate repository rulesets if the `npm` environment still has no protection rules
- enable code scanning alerts; `.github/workflows/codeql.yml` runs pinned CodeQL analysis on pull requests, pushes to `main`, and a weekly schedule
- enable OpenSSF Scorecard alerts; `.github/workflows/scorecard.yml` runs the pinned Scorecard action on pushes to `main` and a weekly schedule, then uploads SARIF to code scanning
- keep dependency review required on pull requests; `.github/workflows/dependency-review.yml` runs the pinned GitHub dependency review action on pull requests and blocks vulnerable runtime or development dependency changes at low severity or higher
- enable artifact attestations for the release workflow; `.github/workflows/release.yml` attests the same verifier-checked npm tarball before publish

In npm:

- create or verify ownership of the `@victorhaine` scope
- configure trusted publishing for package `@victorhaine/p2p-transfer`
- set the trusted publisher to this GitHub repository, workflow `.github/workflows/release.yml`, environment `npm`

Release:

```sh
pnpm install --frozen-lockfile
pnpm verify:release
gh auth refresh -h github.com -s workflow
GITHUB_TOKEN="$(gh auth token)" pnpm release:preflight
git tag v0.1.0
git push origin main --tags
```

The tag starts the release workflow. It verifies the tag matches `package.json`, verifies the tagged commit is reachable from protected `main`, repeats the release gate, attests the exact checked tarball, publishes that tarball to npm with provenance, then creates the GitHub Release with the same tarball and `SHA256SUMS`. Protect `v*` tags with a ruleset/tag-protection rule before the first release; branch protection alone does not restrict who can create release tags.

## License

MIT. See `LICENSE`.

## Known limitations

- A local MDM/EDR administrator can still observe selected files through endpoint controls. `send --code-stdin`, `send --code-env`, and `send --files-stdin` reduce shell-history and process-argv exposure, but they are not protection from a privileged endpoint monitor.
- Environment variables are local process metadata. `--code-env` deletes the variable after capture, but local process telemetry or privileged observers may still see it briefly; use `--code-stdin` when you need to avoid both argv and environment exposure.
- CLI output is metadata-bearing by default for consent, progress, and detailed failures. Use `--redact-output` for log-collected automation; it does not hide metadata from the peer, the endpoint, or the network.
- Browsers without File System Access support can only receive transfers up to the 128 MiB Blob fallback cap.
- Browser folder receives cannot get CLI-style exclusive create from File System Access, so every browser-created folder entry must carry an unguessable `ff-<128-bit>` reservation token; data streams to opaque tokenized `.part` entries and publishes a final tokenized name only after hash verification.
- Browser receive resume is exposed only through the explicit `Resume in folder` accept action. It preserves opaque tokenized `.part` files on failure and can resume a later matching manifest only when the same browser profile still has the saved opaque partial record and browser-held lookup key, and the user selects a folder containing that entry. Browser startup and registry reads scrub legacy metadata-bearing resume records so saved records do not retain plaintext filenames, MIME types, or sizes. Without that saved browser state, or when using the Blob download fallback, browser receive starts fresh. This is intentionally narrower than CLI `recv --resume` because File System Access does not provide CLI-style path identity and atomic publish primitives.

The conformance fixture covers chunk framing, encrypted transfer control messages including resume offsets, canonical signaling-message serialization, PAKE confirmation tags, SDP offer/answer authentication, and ICE candidate authentication including username fragments.
