# p2p-transfer

End-to-end encrypted peer-to-peer file transfer with:

- tiny in-memory WebSocket signaling server
- CLI sender/receiver, installed as `ff`
- static browser client
- WebRTC DataChannels for the data path
- receiver accept gate before file bytes move
- chunked transfer with backpressure and SHA-256 verification
- short copyable handles in the form `123456789012-two-words` using two distinct BIP39 English words
- receiver-side filename sanitization and transfer limit enforcement
- browser receive streams to the File System Access API when available, with download fallback
- browser folder receives save with high-entropy `ff-<random>` tokenized names because File System Access lacks CLI-style exclusive create
- browser Blob download fallback is capped at 32 MiB under a 128 MiB peak-memory budget; larger browser receives require Save to folder

Privacy boundary: file contents, real manifests, SDP contents, and ICE candidate contents are end-to-end encrypted from the signaling server, but this is not network or endpoint opacity. Browser E2EE assumes the served web client code and origin are trusted, because the browser app is an endpoint and necessarily sees receive codes, selected file metadata, plaintext chunks, DOM state, output/download names, and resume state before encryption or after decryption. Signaling/network observers can still see IPs, roles, public WebRTC signal kinds, coarse sealed frame buckets, timing, byte volume, and traffic shape, and a privileged local MDM/EDR administrator can still observe selected files and plaintext at the endpoint before encryption or after decryption.

## Current security status

This build implements the required untrusted-signaling security layer:

- CPace PAKE derives a per-session key from the full handle.
- CLI and browser transfer entrypoints run a one-time runtime crypto self-check before pairing, covering CPace agreement, PAKE confirmation, authenticated signal sealing/opening, manifest/control/bulk AEAD, and wrong-code decrypt failure in the actual runtime.
- Both peers exchange a PAKE-derived confirmation tag before any pair request is accepted into the receive flow.
- The sender encrypts the real pair-request manifest before it crosses the signaling server.
- WebRTC signaling frames, including SDP offers/answers and ICE candidates, are sealed and HMAC-authenticated with the PAKE-derived key, so the signaling server cannot read them and a signaling-server MITM cannot silently swap WebRTC DTLS fingerprints or inject routing candidates.
- DataChannel control messages and bulk file chunks are AES-GCM encrypted with direction-specific keys derived from the PAKE output.
- After WebRTC is connected and both DataChannels are open, file streaming no longer depends on signaling socket liveness; the signaling path is only best-effort teardown at that point.
- Receiver codes expire after a small bounded number of sender rendezvous claims, limiting online guessing and prefix-squatting before the accept gate.
- Both peers display the same short SAS for optional out-of-band comparison.

The signaling server sees the public twelve-digit rendezvous prefix for newly generated codes, IP-level connection metadata, roles, session timing, accept/reject/teardown events, a constant maximum-shape synthetic public pair-request manifest, public WebRTC signal kinds, signaling frame sizes including coarse encrypted-manifest and coarse sealed-signal buckets, and PAKE public shares/tags. A signaling/TURN operator can infer some ICE endpoint choices when it also observes TURN/STUN allocation traffic, but conforming clients do not report a local server-ICE toggle to the signaling protocol. Eight-digit rendezvous prefixes remain accepted for legacy supplied codes. Conforming clients do not send the two secret words, usable file names, MIME types, file contents, PAKE secrets, DataChannel plaintext, SDP contents, ICE candidate contents, exact file count, exact manifest total bytes, exact encrypted-manifest JSON length, exact SDP length, exact ICE candidate length, or declared per-file sizes. Traffic volume and timing still reveal approximate transfer size, and exact size can remain inferable from network byte volume for small or single-file transfers. A modified client can still transmit a malformed public pair-request containing plaintext metadata before rejection; the server rejects unredacted public manifests and does not forward or log them.

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

The global `ff-server` binary is shipped by the combined CLI/server npm package, so that install still includes the reviewed CLI native WebRTC runtime dependencies even though the server does not load them. For a minimized production server-only runtime, use the Docker image; its policy smoke proves the final image omits the CLI entrypoint and CLI-only native WebRTC packages.

Build from source:

```sh
node scripts/prepare-checked-pnpm.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The npm package name is `@victorhaine/p2p-transfer`; the installed binaries are still `ff` and `ff-server`.
The npm package is CLI/server-first and intentionally has no supported JavaScript import surface; use the `ff` and `ff-server` binaries instead of deep-importing `dist-node/*`.

Runtime requirement: Node.js 22.22.3 through the latest Node.js 22 patch, or Node.js 24.13.1 through the latest Node.js 24 patch. Node.js 23 is intentionally unsupported because it is not part of the CI/platform-smoke matrix. The CLI's native WebRTC dependency is supported only on macOS arm64/x64, Linux arm64/x64, and Windows x64; Windows ARM64, Linux ARMv7, and other platforms fail closed for CLI WebRTC instead of falling back to unreviewed native builds. CI platform smoke covers both the exact baseline patches and floating `22.x`/`24.x` latest patches on every supported runner. Release and Docker builds pin Node.js 22.22.3 so published artifacts are built against an exact runtime patch level instead of a floating major tag. Docker base images are also pinned by immutable digest; update the tag and digest together during base-image maintenance.

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

The global npm install is a combined CLI/server artifact and still installs the reviewed CLI native WebRTC runtime packages. Use the Docker image for a minimized server-only production deployment; the Docker policy smoke strips and verifies absence of the CLI entrypoint and CLI-only native WebRTC packages.

The same server also serves `dist-web/` when it exists, so a single process can host the web UI and `WS /v1/ws` for early deployments. Production builds inject SRI into the browser JS/CSS tags, emit `dist-web/asset-manifest.json`, and `ff-server` refuses to serve production HTML/JS/CSS bytes that do not match that manifest. Set `WEB_ROOT` to override the static asset directory; production custom web roots must include a matching generated manifest.

Use the built CLI:

```sh
FF_RECEIVE_OUT="$PWD/downloads" node dist-node/cli/index.js recv --out-env FF_RECEIVE_OUT
unset FF_RECEIVE_OUT
read -rs FF_CODE </dev/tty
find ./to-send -maxdepth 1 -type f | { printf '%s\n' "$FF_CODE"; cat; } | node dist-node/cli/index.js send --code-stdin --files-stdin
unset FF_CODE
```

If local shell history or process-argument telemetry matters, avoid putting the full code or local paths in argv. Read the code without echo, pass file paths through stdin, and clear the environment variable after the child process starts:

```sh
read -rs FF_RECEIVE_CODE
read -rs FF_SIGNALING_SERVER
find ./to-send -maxdepth 1 -type f | FF_RECEIVE_CODE="$FF_RECEIVE_CODE" FF_SIGNALING_SERVER="$FF_SIGNALING_SERVER" node dist-node/cli/index.js --server-env FF_SIGNALING_SERVER send --code-env FF_RECEIVE_CODE --files-stdin
unset FF_RECEIVE_CODE FF_SIGNALING_SERVER
```

`--code-env`, `--out-env`, and `--server-env` only avoid argv and shell-history exposure. Environment variables are not a secrecy boundary against process-environment telemetry, same-user inspection windows, privileged endpoint tools, or MDM/EDR.
Send commands print a generic warning on stderr whenever the receive code or local file paths are still accepted from argv. `recv --code` and `recv --out` print the same kind of generic warning for supplied receive codes or output directories in argv. Explicit `--server` URLs also print a generic warning. The warnings never include the code, paths, or URL. In `--json` mode they are emitted as structured `warning` events; human warning text is suppressed only for `--quiet`.
Use `--require-private-input` in automation that must fail closed instead of accepting signaling server URLs, receive codes, receive output directories, or send code/file paths from argv.
Use `--local-private-mode` or `FF_LOCAL_PRIVATE_MODE=1` when you want the local CLI privacy preset: it enables `--require-private-input` and `--redact-output`, and for `recv` also enables `--opaque-output-names`. Because generated receive codes would be redacted, `recv --local-private-mode` requires `--code-stdin` or `--code-env`. On POSIX systems, receive output directories used with `--local-private-mode` are created with mode `0700` when missing and rejected when they are symlinks, not owned by the current user, have group/other permission bits, or sit under a parent that is neither root/current-user-owned sticky nor current-user-owned and non-group/other-writable. Windows `recv --local-private-mode` fails closed until equivalent private ACL checks are implemented.

Useful CLI flags:

- `--server <url>`: use a self-hosted signaling server.
- `--server-env <name>`: read the signaling server URL from an environment variable instead of argv.
- `--json`: emit machine-readable events.
- `--quiet`: suppress human-readable progress.
- `--redact-output`: redact transfer codes, SAS, file names, MIME types, file counts, byte counts, and per-file placeholders from local CLI output, JSON events, and error text for log-collected automation. It does not hide signaling/server metadata, peer-visible metadata, endpoint telemetry, ICE candidates, timing, or traffic shape.
- `--require-private-input`: reject `--server`, `recv --code`, `recv --out`, `send <code>`, and send file paths supplied through argv; use `--server-env`, `--code-stdin`/`--code-env`, `recv --out-env`, and `send --files-stdin` instead.
- `--local-private-mode`: enable the local privacy preset (`--require-private-input`, `--redact-output`, and `recv --opaque-output-names`). `FF_LOCAL_PRIVATE_MODE=1` enables the same preset for automation. It is a local CLI guardrail only, not protection from privileged endpoint monitoring or network metadata. Receivers must supply a private code with `recv --code-stdin` or `recv --code-env` because generated codes are intentionally redacted. On POSIX systems, the receive output directory must be private: no symlink, current-user-owned, no group/other permission bits, and under a root/current-user-owned sticky parent or a current-user-owned non-group/other-writable parent. Windows receive private mode fails closed until equivalent ACL checks are implemented.
- `--relay`: force relay-only ICE when TURN is configured, reducing local and public endpoint candidate exposure to peers; the signaling server still sees only public signal kind, timing, and coarse sealed-signal bucket metadata from conforming clients.
- `--no-server-ice`: ignore signaling-provided STUN/TURN endpoints and use only the built-in public STUN defaults. This reduces trust in the rendezvous operator's ICE configuration, but disables that server's TURN fallback.
- `send --code-stdin`: read the receive code from piped stdin instead of argv.
- `send --code-env <name>`: read the receive code from an environment variable instead of argv.
- `send --files-stdin`: read newline-delimited file paths from stdin instead of argv.
- `recv --yes`: auto-accept, required for headless receive flows. This bypasses the interactive consent gate, so use it only with a private receive code in trusted automation.
- `recv --code <code>`: use a supplied code like `123456789012-two-words` instead of generating one.
- `recv --code-stdin` / `recv --code-env <name>`: provide that supplied receive code without putting it directly in argv. Supplied receive codes are not reprinted in the CLI registered event or human output.
- `recv --out-env <name>`: read the output directory from an environment variable instead of argv. In private-input mode, use this or the current working directory instead of `recv --out`.
- `recv --resume`: keep failed CLI partials and resume a later attempt from the last verified chunk boundary on macOS/Linux. The final SHA-256 still has to match before publish. Windows CLI resume fails closed until equivalent private ACL checks are implemented.
- `recv --opaque-output-names`: publish received files as `ff-<token>` names instead of peer-supplied basenames. With `--resume` on macOS/Linux, the final name is a stable HMAC-derived opaque name in that output directory.
  CLI resume also keeps a private `.ff-resume-key` in the output directory so resumable `.part` file names stay opaque; delete that key together with stale `ff-resume-*.part` files to reset local resume state.

The browser client has matching ICE controls in the header. `Relay only` sets WebRTC `iceTransportPolicy` to `relay`, requires a credentialed TURN server, and fails immediately if none is configured; it may reduce connectivity, but avoids exposing direct host/server-reflexive ICE candidates to the peer.
For sensitive browser receives, enable `Folder only` before starting receive. It requires the File System Access API and streams to folder-backed partial files instead of the memory-backed Blob download fallback.
Enable `Opaque output names` before starting receive when final browser output names must not include peer-supplied basenames. Normal browser receive names include the sanitized original basename plus a random reservation token for usability; opaque mode publishes `ff-<token>` names instead.
Use `Clear resume records` to remove browser origin resume records from IndexedDB, the browser-held resume lookup key, any legacy localStorage resume records, and matching saved `ff-*.part` files from a freshly selected folder when File System Access is available. If you cancel folder selection, use a browser without File System Access, or previously received into multiple folders, delete remaining stale `ff-*.part` files manually from those receive folders when needed.

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

In production, `GET /v1/version` returns only protocol compatibility so unauthenticated scanners do not get an exact package-version fingerprint; non-production runs also include package name and version for local debugging.

The WebSocket broker keeps only in-memory state, matches peers by the public twelve-digit rendezvous prefix generated by current clients, still accepts eight-digit legacy supplied prefixes, enforces one-shot registrations, validates manifest limits, rate-limits WebSocket upgrade churn, registration/connect attempts, static HTTP requests, and ICE credential issuance, rejects malformed or duplicated `Origin`/`Host` headers before policy checks, caps signaling frames at 256 KiB, applies hard global caps to waiting codes and active sessions, verifies production browser asset bytes against the generated SHA-256 manifest before serving HTML/JS/CSS, and keeps static asset responses under a global in-flight byte budget.

Metadata privacy is intentionally limited and should be understood before using the tool:

| Observer | Can learn | Should not learn |
| --- | --- | --- |
| Signaling server | client IPs, public rendezvous prefix, roles, session timing, accept/reject/teardown events, the fixed authenticated `pair-reject` reason `user_declined`, a constant maximum-shape synthetic public pair-request manifest, public WebRTC signal kinds, signaling frame sizes including coarse encrypted-manifest and coarse sealed-signal buckets, PAKE public shares/tags, and malformed unredacted manifests from modified clients before rejection; a signaling/TURN operator can infer some ICE endpoint choices when it also observes TURN/STUN allocation traffic | from conforming clients and accepted protocol flow: two secret words, PAKE output, plaintext file names, MIME types, file bytes, DataChannel control plaintext, SDP contents, ICE candidate contents, exact file count, exact manifest total bytes, exact encrypted-manifest JSON length, exact SDP length, exact ICE candidate length, declared per-file sizes, or an explicit local server-ICE toggle; traffic volume and timing can still reveal approximate size, including exact size for some small or single-file transfers |
| STUN server | client public IP/port and ICE timing | code, manifest, file names, file bytes |
| TURN server | client IPs, relay allocation timing, packet sizes, traffic volume/duration | file bytes or DataChannel plaintext |
| Network observer | endpoints, DNS/SNI where applicable, timing, traffic volume, traffic shape, peer IPs for direct WebRTC, TURN use when relayed, and the absence of padding or cover traffic | file bytes or DataChannel plaintext when using `wss://` and WebRTC |
| Browser app / web origin / served JS | receive codes entered in the page, selected file names/MIME types/sizes, plaintext chunks before send or after receive, DOM text, output/download names, File System Access handles, and opaque resume records/state for that origin | browser E2EE against the signaling server assumes this client code and origin are trusted; hostile same-origin script, compromised static hosting, extensions, or injected browser code can observe endpoint plaintext |
| Managed endpoint / MDM / EDR | selected CLI paths, file open/read/write/rename events, browser DOM text, browser download/folder names, final output names, process argv/environment windows, peer/server connections, timing, byte volume, and local plaintext before send or after receive | cryptography does not hide local endpoint activity from a privileged endpoint monitor |
| Peer | real manifest before consent, SAS, transfer timing, resume offsets, ICE metadata, and transferred file contents | nothing in the accepted transfer is hidden from the chosen peer |

The server-visible pair request uses a constant maximum-shape synthetic manifest, independent of the real file count or declared byte total. The encrypted manifest still gives the receiver the real names, sizes, and MIME types before consent, but conforming senders pad the sealed manifest wrapper to a coarse bucket so the signaling server does not get the exact private manifest JSON length.

If you do not trust the rendezvous operator's ICE endpoint choices, use CLI `--no-server-ice` or clear the browser `Server ICE/TURN` checkbox. The signaling server will still see public signal kind, timing, and coarse sealed-signal bucket metadata, but it cannot read conforming SDP/ICE contents or make the client use operator-supplied STUN/TURN endpoints. Direct connection reliability may drop because server-provided TURN fallback is skipped. Relay-only ICE reduces direct peer IP exposure to the other peer, but it shifts traffic metadata to the TURN operator; it does not hide timing, byte volume, or traffic shape.
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
TURN_REST_ALLOW_UNVERIFIED_ACCEPT=true \
pnpm start
```

`TURN_REST_SECRET` must be at least 32 bytes and should be generated randomly. Static TURN credentials in `ICE_SERVERS` work for private non-production testing, but production mode rejects them because they expose a reusable relay password to every client. Use `TURN_REST_SECRET`/`TURN_URLS` for public deployments so clients receive short-lived credentials only after the receiver sends a `pair-accept` that passes server role and phase policy. Clients verify that accept decision end-to-end with the PAKE-derived signal-auth key before starting ICE; the server must not learn that key, cannot verify the accept cryptographically, and does not decrypt the manifest. Because a malicious or automated pair can still reach the syntactic accept phase, production and non-loopback deployments refuse to start with TURN REST enabled unless `TURN_REST_ALLOW_UNVERIFIED_ACCEPT=true` is set. The signaling server applies a stricter per-IP quota to accepted-session TURN credential issuance than to unauthenticated ICE discovery and fails accepted sessions with `rate_limited` when that quota is exhausted instead of silently downgrading to STUN-only ICE, but you still need TURN-side allocation quotas, bandwidth caps, abuse monitoring, and signaling rate limits sized for your deployment. Unauthenticated `GET /v1/ice`, unmatched receive-code registrations, and pre-accept rendezvous matches never return TURN URLs or mint TURN REST credentials. The CLI `--relay` flag forces relay-only ICE when TURN is present.

For public deployments, restrict browser WebSocket origins with `ALLOWED_ORIGINS`. Production mode requires `ALLOWED_ORIGINS`; non-loopback binds such as `HOST=0.0.0.0`, `HOST=::`, or a public hostname also require it even outside production mode. When `ALLOWED_ORIGINS` is omitted, browser `Origin` traffic is accepted only when both the request `Host` and browser `Origin` are loopback, so public websites and loopback-bound servers accidentally exposed through a public reverse proxy fail closed for browser WebSocket and CORS requests:

```sh
ALLOWED_ORIGINS='https://files.example.com,https://www.files.example.com' pnpm start
```

WebSocket upgrades require a valid `Origin` header. Browser clients send their page origin. CLI clients send a deterministic origin derived from the signaling URL (`wss://signal.example.com/v1/ws` sends `https://signal.example.com`), so deployments that use a separate signaling hostname must include both the browser page origin and the CLI signaling origin in `ALLOWED_ORIGINS`.
The signaling server defaults to `PORT=8787`; if `PORT` is set, it must be a fixed integer between 1 and 65535. `PORT=0` is rejected instead of silently binding a random ephemeral port.
In production, `ALLOWED_ORIGINS` entries must use `https://`; set `ALLOW_INSECURE_ORIGINS=true` only for private deployments behind a trusted network boundary.

If TLS terminates at a reverse proxy, the server normally sees the proxy socket IP for every client, which collapses connection and rate-limit buckets. Set `TRUSTED_PROXY_HOPS=1` and `TRUSTED_PROXY_IPS='<proxy-ip-or-cidr>'` only when every public request reaches the app through exactly one trusted reverse proxy that overwrites or appends a valid `X-Forwarded-For` header and direct-to-app traffic is blocked. `TRUSTED_PROXY_IPS` accepts exact IP literals or non-wildcard CIDR ranges for the actual socket peer, not hostnames; `0.0.0.0/0` and `::/0` are rejected because they would trust attacker-supplied forwarded headers from direct clients. Leave both unset for direct exposure; attacker-supplied `X-Forwarded-For` is ignored by default.
Clients reject plain `ws://` signaling URLs except localhost/loopback. Use `wss://` for any remote signaling server.
The served browser app's production Content Security Policy permits same-origin signaling only by default. Local development allows loopback `ws://` signaling sockets; in production, set `BROWSER_ALLOW_LOOPBACK_WS=true` only for a deliberate private deployment that needs browser-to-localhost signaling. If you intentionally host one static web UI that must connect to arbitrary custom `wss://` signaling servers, set `BROWSER_ALLOW_ANY_WSS=true`; both switches widen the browser exfiltration surface and should not be the default for public production deployments.
Host the browser client on a dedicated origin. Browser resume records are opaque and stored in IndexedDB, but they are still origin-scoped; unrelated scripts on the same origin could inspect opaque registry entries and use the browser-held lookup key to test guessed manifest identities.

## Docker

Production-shaped run, assuming TLS terminates at `https://files.example.com` and forwards to this container:

```sh
docker build -t p2p-transfer .
docker run --rm -p 8787:8787 \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
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
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
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

`pnpm verify:release` runs the full non-Docker local release gate, checks version-scoped release notes, and runs `pnpm security:dependencies` before the build so CPace vectors plus reviewed crypto/native dependency attestations remain an explicit release gate, not only part of the broad unit-test glob. `pnpm verify:release:docker` runs that same gate plus the hardened Docker policy smoke; use it before release and for Docker, deployment, release, or server changes when a Docker daemon is available.
`pnpm test` runs the production build, unit crypto/protocol tests, built CLI end-to-end transfer test, and browser/CLI interop tests.
`pnpm test:browser` verifies browser sender to CLI receiver, browser sender resume into a CLI receiver partial, CLI sender to browser download receiver, CLI sender to browser opaque-name download receiver, CLI sender to browser folder-only receiver, browser folder cleanup after final acknowledgement failure, native browser filesystem error redaction, multi-file browser folder receive without resume exposure, CLI sender to browser opaque-name folder receiver, ordinary folder receives without resume-key creation, valid single-file browser folder resume from a saved partial, invalid resume-key isolation, browser resume-registry metadata scrubbing, and browser folder restart after a corrupted saved partial with Playwright. Install Chromium with `pnpm exec playwright install --with-deps chromium`; set `PLAYWRIGHT_CHROMIUM=/path/to/chromium` only when using an existing local browser binary. Missing Chromium is a hard test failure unless `FF_ALLOW_BROWSER_TEST_SKIP=true` is set explicitly; do not set that variable for release verification.
`pnpm smoke:native` loads WebRTC through the built CLI `nativeWebRtc()` guard, creates a DataChannel, and completes local offer/answer SDP negotiation. `pnpm smoke:packed` packs the verified workspace, installs that tarball into a fresh pnpm consumer project with native dependency build scripts enabled only for the reviewed native packages, verifies the published `ff` bin reports the expected protocol/version, installs the same tarball into an isolated npm global prefix and verifies the global `ff`/`ff-server` bins, boots the published `ff-server` bin, checks both `/healthz` and the bundled web UI, then transfers a file through installed `ff recv` and `ff send` using POSIX `recv --local-private-mode`, Windows explicit redacted/private-input/opaque-output receive flags, stdin code/file inputs, and environment-sourced receive output, verifies the receive path is opaque, and compares received bytes. `pnpm smoke:release-artifact` runs real `pnpm pack`, writes the CycloneDX `SBOM.cdx.json`, writes `SHA256SUMS` for both release evidence files, and runs the release artifact verifier against that complete artifact set so local release verification exercises the same artifact shape used by the release workflow.
`pnpm smoke:docker-policy` proves the production Docker image refuses to start without `ALLOWED_ORIGINS` and without `SIGNALING_TOPOLOGY`, proves the final server runtime image does not contain CLI artifacts or CLI-only native WebRTC packages, then boots it with both policies explicit, a loopback-only random host port, a read-only filesystem, dropped Linux capabilities, `no-new-privileges`, `--pids-limit 128`, `--memory 512m`, and `--cpus 1`, and checks `/healthz`, origin policy, and the bundled web UI; a build-only Docker pass is not treated as enough for release. CI and release run the same checked script. The release workflow runs a pre-publish Docker validation gate before npm publish, then smoke-tests and pushes only a run-scoped GHCR staging tag, scans that exact staged digest for any known OS or library vulnerability at Trivy severity unknown, low, medium, high, or critical including unfixed advisories, generates and attests a CycloneDX image SBOM for the same digest, uploads that SBOM artifact, attaches GitHub provenance to that digest, and makes npm publish depend on that staged, scanned, attested digest. After npm succeeds, it promotes only the attested digest to `ghcr.io/victorhaine/p2p-transfer:vX.Y.Z` and `ghcr.io/victorhaine/p2p-transfer:X.Y.Z`; reruns accept existing GHCR release tags only when they already point to that same digest, verify both promoted tags are anonymously pullable and resolve to that digest, and fail closed rather than moving a different digest or shipping a private image. Platform smoke runs the packed-install check on Linux x64, Linux arm64, macOS arm64, macOS Intel, and Windows x64 for each supported Node major because the CLI depends on native WebRTC bindings; CI also runs floating `22.x` and `24.x` latest-patch smoke for those same runners so the documented Node patch range stays continuously verified. Workflows use explicit hosted runner generations (`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`) rather than floating `*-latest` labels.
The release workflow is tag-only. Release artifacts, npm publishes, Docker images, and GitHub Releases are produced only from `v*.*.*` tags that match `package.json` version and exactly match protected `main`, not from manual workflow dispatches, branch-built artifacts, stale main ancestors, or off-main tag commits. Local pre-tag release preflight fails if the target npm version already exists; the tag workflow passes a checked rerun-only flag so a full workflow rerun can proceed after npm has already accepted the immutable version and let the publisher prove the exact tarball match.
Before publishing, the release workflow downloads the exact npm tarball artifact, verifies its checksum and package metadata, re-checks through the GitHub API that the live release tag is a GitHub-verified signed annotated tag and that the live tag target plus live `main` still resolve to `GITHUB_SHA`, then runs the packed-install smoke against a no-follow-verified staged copy of that downloaded tarball rather than trusting a different tarball produced earlier in the job.
The verified tarball and SBOM are attested from `SHA256SUMS` with GitHub artifact attestations inside the `npm` environment approval gate before publish; the publish job downloads and verifies the artifact set but does not reinstall, rebuild, repack, or rediscover release contents. The checked publisher first accepts an already-published npm version only when the registry metadata exactly matches the verifier-selected tarball bytes and `latest` dist-tag, which makes release reruns idempotent after npm has accepted an immutable version. After `pnpm publish`, it polls boundedly through stale metadata or transient registry read failures and verifies the published version identity, `latest` dist-tag, SHA-1 shasum, SHA-512 integrity, and tarball URL against that same tarball before Docker promotion or GitHub Release creation can run. The Docker release and GitHub Release jobs also run inside the protected `npm` environment, re-check live tag/main refs immediately before production mutations, scan the staged GHCR image digest, generate and attest a Docker image SBOM for that digest, upload the SBOM artifact, attest the staged GHCR image digest, push that provenance to the registry, and create production Docker tags only after scan and attestation succeed.
Npm publishing uses GitHub OIDC trusted publishing from the `npm` environment; configure the npm package trusted publisher instead of storing a long-lived `NPM_TOKEN` secret.
After npm and Docker publish succeed, the workflow re-verifies the downloaded tarball and SBOM again, extracts the matching version section from `CHANGELOG.md`, and creates the GitHub Release with that exact tarball plus `SHA256SUMS` and `SBOM.cdx.json`. If a rerun finds an existing draft release for the exact tag, the checked script deletes only that draft, re-checks live tag/main refs, and recreates it from the verified artifacts. If a rerun finds an already-published release for the exact tag, it is accepted only when the remote title, release notes, prerelease flag, and every release asset byte-match the verified release metadata, tarball, checksum file, and SBOM.
Package-surface tests run after the build in local verification, CI, and release, and assert the published `ff` and `ff-server` bin entrypoints keep their Node shebangs and executable mode.
Protocol conformance fixtures live in `conformance/protocol-v10.json` and are included in the npm package.

Security reporting and release invariants are documented in `SECURITY.md`.

## Release checklist

One-time repository setup:

```sh
git remote add origin https://github.com/VictorHaine/p2p-transfer.git
```

In GitHub:

- use the checked release-control setup script below to create or update the `npm` environment used by `.github/workflows/release.yml`, add required reviewers with self-review prevention, disable admin bypass, and restrict deployments to the `v*.*.*` tag policy before publishing; only configure it manually as a fallback when the script reports an unsupported GitHub API response, then rerun the script and release preflight
- ensure the `npm` environment has at least one reviewer with write, maintain, or admin repository permission other than the person or token owner that will push the release tag; a sole self-reviewer deadlocks the publish job, and read-only collaborators cannot approve the environment
- enable private vulnerability reporting; the checked release-control setup enables it with the GitHub `private-vulnerability-reporting` endpoint, and release preflight verifies that endpoint reports enabled before tagging
- enable dependency vulnerability alerts, repository secret scanning, secret scanning push protection, and Dependabot security updates; the checked release-control setup enables and re-reads those repository security controls, verifies the dedicated Dependabot status is unpaused, and release preflight reads GitHub `security_and_analysis`, `vulnerability-alerts`, and `automated-security-fixes` endpoints so tagging fails if any feature is disabled, paused, or hidden from the release token
- after the first `main` push, apply the checked release controls with `gh auth token | node scripts/configure-github-release-controls.mjs --token-stdin --apply --npm-reviewer <release-approver-login>`; this creates/updates the `npm` environment approval gate with self-review prevention, admin bypass disabled, and `v*.*.*` tag-only deployment, plus the exact repository rulesets that release preflight requires for `main` and `v*.*.*` release tags with no bypass actors. The `main` ruleset requires verified commit signatures in addition to review and status gates. It refuses read-only or unknown reviewers, refuses to create a sole-reviewer self-approval deadlock, refuses `--allow-missing-main` outside dry-run mode, re-reads the persisted repository security controls, dependency vulnerability alert status, `npm` environment, persisted reviewer permissions, deployment tag policy, and repository ruleset details after writes, and refuses to mutate deployment policies or repository rulesets if GitHub returns a persisted reviewer without write, maintain, or admin permission; it also refuses to mutate repository rulesets if GitHub returns malformed, duplicate, unexpected, wrong-target, or bypass-enabled rulesets, or if persisted repository security controls are still disabled, dependency vulnerability alerts are still disabled, or Dependabot security updates are paused, the persisted `npm` environment still has no required-reviewer protection, still allows admin bypass or branch deployments, lacks the exact release-tag deployment policy, still has the authenticated setup operator as its sole required reviewer, or the persisted branch/tag rulesets do not exactly match the requested protected surface
- enable code scanning alerts; `.github/workflows/codeql.yml` runs pinned CodeQL analysis on pull requests, pushes to `main`, and a weekly schedule without cancelling in-progress release-evidence runs; release preflight requires a successful CodeQL run for the exact current `main` commit before tagging
- enable OpenSSF Scorecard alerts; `.github/workflows/scorecard.yml` runs the pinned Scorecard action on pushes to `main`, manual dispatch, and a weekly schedule without cancelling in-progress release-evidence runs, then uploads SARIF to code scanning; release preflight requires a successful Scorecard run for the exact current `main` commit before tagging
- keep dependency review required on pull requests; `.github/workflows/dependency-review.yml` runs the pinned GitHub dependency review action on pull requests and blocks vulnerable runtime or development dependency changes at low severity or higher, plus denied copyleft license introductions
- keep the dependency integrity monitor enabled; `.github/workflows/dependency-integrity.yml` runs on pushes to `main`, manual dispatch, and daily across the supported native WebRTC runner set with read-only permissions without cancelling in-progress release-evidence runs, then re-checks the frozen install, installed dependency tree, reviewed crypto/wordlist/native dependency attestations, npm advisory audit, and registry package signatures even when `main` has not changed; release preflight requires a successful dependency-integrity run for the exact current `main` commit before tagging
- keep Dependabot reviewer routing enabled for npm, GitHub Actions, and Docker updates so CPace, native WebRTC, workflow action, and image-base drift request maintainer review instead of landing as unowned automation
- enable artifact attestations for the release workflow; `.github/workflows/release.yml` attests the same verifier-checked npm tarball and SBOM inside the `npm` environment approval gate before publish
- create an Actions secret named `RELEASE_PREFLIGHT_TOKEN` from a fine-grained PAT or an externally rotated GitHub App installation token that can read repository metadata including `security_and_analysis`, dependency vulnerability alert status, private vulnerability reporting status, the `main` branch, Actions secret metadata, Actions workflow run metadata, repository rulesets including bypass actors, repository environments, and deployment branch policies; do not store a raw one-hour GitHub App installation token as a static secret unless rotation updates it before each release. Classic PATs, OAuth tokens, refresh tokens, and user access tokens are rejected in the release workflow before package or network work. The tag workflow runs the checked release preflight before installing dependencies, so `${{ github.token }}` is not enough for this gate

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
gh auth refresh -h github.com -s workflow
git fetch origin main
git checkout main
git pull --ff-only origin main
gh auth token | pnpm release:preflight --token-stdin
pnpm release:tag -- v0.1.0
git push origin v0.1.0
```

For normal releases, update local `main` to the exact current `origin/main` commit after the protected pull request has merged, then run release preflight from that checked-out commit with no staged, unstaged, or untracked worktree changes. Local preflight refuses unsigned `HEAD` and dirty worktrees before package or network work, and it refuses to pass if that local `HEAD` differs from GitHub's current `main` branch response. The checked tag creator revalidates signed `HEAD`, clean worktree state, package-version matching, freshly fetched `origin/main` equality, local and remote tag absence, tag target, and tag signature while suppressing signer subprocess output; if post-create verification fails, it deletes only the tag it just created before reporting a generic failure.
When using SSH commit or tag signing, configure `user.signingkey` to the public key file or literal public key, not the private key path; some signing helpers echo invalid key material in errors.

The tag starts the release workflow. It verifies the tag matches `package.json`, rejects lightweight tags, verifies through GitHub's API that the release tag is a signed annotated tag with a valid verification result, verifies the tagged commit exactly matches protected `main`, verifies the npm package already exists, verifies any bootstrap placeholder is not tagged as `latest`, allows an existing target version only in the matching GitHub tag workflow rerun path, verifies private vulnerability reporting is enabled, verifies dependency vulnerability alerts are enabled, verifies repository secret scanning and secret scanning push protection are enabled, verifies Dependabot security updates are enabled and unpaused, repeats the release gate, smoke-tests and stages the GHCR image under a run-scoped tag, scans that staged digest, generates and attests a CycloneDX image SBOM for that digest, uploads the SBOM artifact, attaches registry provenance to that staged digest, attests the exact checked tarball and SBOM from `SHA256SUMS`, publishes that tarball to npm with provenance only after Docker staging succeeds, verifies npm registry metadata for the published version and tarball bytes, promotes the scanned and attested GHCR digest, then creates the GitHub Release with the same tarball, `SHA256SUMS`, and `SBOM.cdx.json`. Npm publish, GHCR publishing, and GitHub Release creation all run inside the protected `npm` environment and re-check live signed-tag/main refs immediately before the production mutation. The checked repository ruleset for `v*.*.*` tags must be active before the first release; it protects matching release tags from deletion and movement without enabling GitHub's creation restriction, because creation restriction with no bypass actor would make first-party release tags impossible. Release authority is instead gated by exact protected-`main` tag checks plus the npm environment approval gate until a dedicated release bot can be given an explicit audited bypass.

## License

MIT. See `LICENSE`.

## Known limitations

- The browser app and its origin are trusted endpoint code. A compromised static host, hostile same-origin script, browser extension, or injected browser code can observe receive codes, file picker choices, selected file metadata, plaintext before encryption or after decryption, DOM text, output/download names, File System Access handles, and origin resume records.
- A local MDM/EDR administrator can still observe selected files through endpoint controls, including file picker choices, CLI file opens, writes, renames, browser DOM previews, browser download behavior, final output names, and local plaintext before encryption or after decryption. `--local-private-mode` combines the CLI local guardrails, `send --code-stdin`, `send --code-env`, and `send --files-stdin` reduce shell-history and `ff` process-argv exposure, `recv --opaque-output-names` avoids peer basenames in final CLI receive paths, and browser `Opaque output names` avoids peer basenames in final browser receive names, but none of those options protect from a privileged endpoint monitor.
- Environment variables are local process metadata. `--code-env`, `--out-env`, and `--server-env` delete the variable after capture, but local process telemetry or privileged observers may still see it briefly; use `--code-stdin` for receive codes and the current working directory for receive output when you need to avoid both argv and environment exposure. With `--local-private-mode`, make that working directory private first on POSIX systems, for example mode `0700`.
- CLI output is metadata-bearing by default for consent, progress, and detailed failures. Use `--redact-output` for log-collected automation; it redacts local CLI output only and does not hide metadata from the signaling server, peer, endpoint telemetry, ICE candidates, timing, or the network.
- `--files-stdin` protects the `ff` process argv only. The command that produces the file list can still leak local paths through its own argv, shell history, terminal logs, or endpoint telemetry; use operational controls around the producer command when that matters.
- `--require-private-input` makes argv fallback a command error, but it does not hide paths from the command that enumerates them or from local file-open telemetry.
- Browsers without File System Access support can only receive transfers up to the 32 MiB Blob fallback payload cap. The cap is deliberately below the 128 MiB peak-memory budget because the fallback can hold decrypted chunks, transient copies, queued data, and browser-managed Blob bytes at the same time. Use `Folder only` for larger or sensitive receives.
- Browser folder receives cannot get CLI-style exclusive create, stable file identity, or atomic publish from File System Access, so every browser-created folder entry must carry an unguessable `ff-<128-bit>` reservation token; data streams to opaque tokenized `.part` entries and publishes a final tokenized name only after hash verification. A same-folder actor with write access can still race a zero-byte tokenized name or modify a final file after verification; use a private receive folder for sensitive browser receives. `Folder only` protects streaming behavior and partial-overwrite handling. Use browser `Opaque output names` as well when final browser output names must not include the sanitized original basename.
- Browser receive resume is exposed only through the explicit `Resume in folder` accept action and only for single-file manifests. It preserves an opaque tokenized `.part` file on failure and can resume a later matching manifest only when the same browser profile still has a fresh saved opaque partial record in IndexedDB and browser-held lookup key, and the user selects a folder containing that entry. Browser startup and registry reads scrub expired or legacy metadata-bearing resume records so saved records do not retain plaintext filenames, MIME types, or sizes; legacy localStorage records are migration-only and removed after scrub. `Clear resume records` snapshots registry-known opaque partial names, offers to remove matching saved `ff-*.part` entries from a freshly selected folder when File System Access is available, and then removes browser-held resume registry/key state. Browsers cannot enumerate previously selected folders after the fact, so cancelling folder selection, using multiple receive folders, or using a browser without File System Access can leave stale `ff-*.part` files for manual deletion. Multi-file browser receives start fresh on retry because the browser path does not yet track already-published completed files without leaking more metadata into origin storage. Without saved browser state, or when using the Blob download fallback, browser receive starts fresh. This is intentionally narrower than CLI `recv --resume` because File System Access does not provide CLI-style path identity and atomic publish primitives.

The conformance fixture covers chunk framing, transfer control-message schemas used inside the encrypted channel including resume offsets, canonical signaling-message serialization, sealed WebRTC signal envelopes, authenticated pair decisions with the fixed reject reason, fixed AES-GCM vectors for sealed manifest/control/bulk payloads, PAKE confirmation tags, SDP offer/answer authentication, and ICE candidate authentication including username fragments.
