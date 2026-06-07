import test from "node:test";
import assert from "node:assert/strict";
import {
  corsHeaders,
  iceServersForRequest,
  iceServersForUnauthenticatedRequest,
  loadServerConfig,
  originAllowed,
  originAllowedForRequest,
  parseAllowedOrigins,
  parseIceServers,
  parseTurnUrls
} from "../src/server/config.js";
import {
  corsHeaders as distCorsHeaders,
  originAllowedForRequest as distOriginAllowedForRequest
} from "../dist-node/server/config.js";
import { DEFAULT_ICE_SERVERS } from "../src/shared/constants.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const strongTurnSecret = "0123456789abcdef0123456789abcdef";
const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
const configSource = fs.readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
const distConfigSource = fs.readFileSync(new URL("../dist-node/server/config.js", import.meta.url), "utf8");
const projectWebRoot = path.resolve(new URL("../dist-web", import.meta.url).pathname);

test("server config rejects malformed production values instead of silently falling back", () => {
  assert.throws(() => loadServerConfig({ NODE_ENV: "production " }), /NODE_ENV/);
  assert.throws(() => loadServerConfig({ NODE_ENV: " production" }), /NODE_ENV/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "Production" }), /NODE_ENV/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "prod" }), /NODE_ENV/);
  assert.equal(loadServerConfig({ NODE_ENV: "development" }).browserAllowLoopbackWs, true);
  assert.equal(loadServerConfig({ NODE_ENV: "test" }).browserAllowLoopbackWs, true);
  assert.throws(() => loadServerConfig({ PORT: "abc" }), /PORT/);
  assert.throws(() => loadServerConfig({ PORT: "0" }), /PORT/);
  assert.throws(() => loadServerConfig({ PORT: "65536" }), /PORT/);
  assert.throws(() => loadServerConfig({ HOST: "http://127.0.0.1" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "127.0.0.1/path" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "127.0.0.1\n" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "*" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "-files.example" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "files.example." }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "127.1" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "0177.0.0.1" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "2130706433" }), /HOST/);
  assert.throws(() => loadServerConfig({ HOST: "0x7f000001" }), /HOST/);
  assert.throws(() => parseIceServers(" ".repeat(128 * 1024 + 1)), /ICE_SERVERS.*at most/);
  assert.throws(() => parseIceServers("not-json"), /ICE_SERVERS/);
  assert.throws(() => parseIceServers("[]"), /ICE_SERVERS/);
  assert.throws(() => parseIceServers('[{"urls":"https://example.test"}]'), /ICE_SERVERS/);
  assert.throws(() => parseIceServers('[{"urls":[]}]'), /ICE_SERVERS/);
  assert.throws(() => parseIceServers('[{"urls":"turn:turn.example.test:3478"}]'), /ICE_SERVERS/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: "secret" }), /TURN_REST_SECRET/);
  assert.throws(() => loadServerConfig({ TURN_URLS: '"turn:turn.example.test"' }), /TURN_REST_SECRET/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: "short-secret", TURN_URLS: '"turn:turn.example.test"' }), /at least 32 bytes/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: "s".repeat(4097), TURN_URLS: '"turn:turn.example.test"' }), /at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: `0123456789abcdef\n0123456789abcdef`, TURN_URLS: '"turn:turn.example.test"' }), /control characters/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: `${strongTurnSecret}\n`, TURN_URLS: '"turn:turn.example.test"' }), /control characters/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: `${strongTurnSecret}\u200b`, TURN_URLS: '"turn:turn.example.test"' }), /format characters/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '"stun:stun.example.test"' }), /TURN_URLS/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: " ".repeat(8 * 1024 + 1) }), /TURN_URLS.*at most/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: "[]" }), /TURN_URLS/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: JSON.stringify(new Array(9).fill("turn:turn.example.test")) }), /TURN_URLS/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '"turn:turn.example.test:0"' }), /TURN_URLS/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '"turn:user:pass@turn.example.test"' }), /must not embed credentials/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '["turns:user@turn.example.test"]' }), /must not embed credentials/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '"turn:turn.example.test"', TURN_TTL_SECONDS: "5" }), /TURN_TTL_SECONDS/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_ANY_WSS: "yes" }), /BROWSER_ALLOW_ANY_WSS/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_LOOPBACK_WS: "yes" }), /BROWSER_ALLOW_LOOPBACK_WS/);
  assert.throws(() => loadServerConfig({ SIGNALING_TOPOLOGY: "multi-replica" }), /SIGNALING_TOPOLOGY/);
  assert.throws(() => loadServerConfig({ SIGNALING_TOPOLOGY: " single-instance" }), /SIGNALING_TOPOLOGY/);
  assert.throws(() => loadServerConfig({ TRUSTED_PROXY_HOPS: "one" }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => loadServerConfig({ TRUSTED_PROXY_HOPS: "4" }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => loadServerConfig({ TRUSTED_PROXY_HOPS: " 1" }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => loadServerConfig({ ALLOW_INSECURE_ORIGINS: "yes" }), /ALLOW_INSECURE_ORIGINS/);
  assert.throws(() => loadServerConfig({ ALLOW_ANY_ORIGIN: "true", ALLOWED_ORIGINS: "https://files.example" }), /ALLOW_ANY_ORIGIN/);
  assert.throws(() => parseAllowedOrigins(" https://files.example"), /ALLOWED_ORIGINS entries must not contain whitespace/);
  assert.throws(() => parseAllowedOrigins("https://files.example "), /ALLOWED_ORIGINS entries must not contain whitespace/);
  assert.throws(() => parseAllowedOrigins("https://files.example, https://www.files.example"), /ALLOWED_ORIGINS entries must not contain whitespace/);
});

test("server config byte-caps scalar environment values before string parsing", () => {
  const oversized = "1".repeat(4097);
  assert.throws(() => loadServerConfig({ NODE_ENV: oversized }), /NODE_ENV must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ PORT: oversized }), /PORT must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ HOST: oversized }), /HOST must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ SIGNALING_TOPOLOGY: oversized }), /SIGNALING_TOPOLOGY must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ TRUSTED_PROXY_HOPS: oversized }), /TRUSTED_PROXY_HOPS must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_ANY_WSS: oversized }), /BROWSER_ALLOW_ANY_WSS must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_LOOPBACK_WS: oversized }), /BROWSER_ALLOW_LOOPBACK_WS must be at most 4096 bytes/);
  assert.throws(() => loadServerConfig({ WEB_ROOT: " ".repeat(4097) }), /WEB_ROOT must be at most 4096 bytes/);
  assert.throws(
    () => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: '"turn:turn.example.test"', TURN_TTL_SECONDS: oversized }),
    /TURN_TTL_SECONDS must be at most 4096 bytes/
  );
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: "s".repeat(4097), TURN_URLS: '"turn:turn.example.test"' }), /TURN_REST_SECRET must be at most 4096 bytes/);

  assert.match(securityPolicy, /scalar server environment values must be byte-capped before trim, regex, numeric conversion, path resolution, or credential checks/);
  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /const MAX_SCALAR_ENV_BYTES = 4096/);
    assert.match(source, /parsePort[\s\S]*assertEnvStringByteLength\(value, "PORT", MAX_SCALAR_ENV_BYTES\)[\s\S]*value\.trim\(\)/);
    assert.match(source, /parseHost[\s\S]*assertEnvStringByteLength\(value, "HOST", MAX_SCALAR_ENV_BYTES\)[\s\S]*value\.trim\(\)/);
    assert.match(source, /parseBooleanEnv[\s\S]*assertEnvStringByteLength\(value, name, MAX_SCALAR_ENV_BYTES\)[\s\S]*value\.trim\(\)/);
    assert.match(source, /parseWebRoot[\s\S]*assertEnvStringByteLength\(value, "WEB_ROOT", MAX_WEB_ROOT_ENV_BYTES\)[\s\S]*value\.trim\(\)/);
  }
});

test("server config rejects non-string env values before parsing or coercion", () => {
  let toStringCalled = false;
  const hostile = {
    toString() {
      toStringCalled = true;
      return "https://files.example";
    },
    valueOf() {
      toStringCalled = true;
      return "https://files.example";
    }
  };

  assert.throws(() => parseAllowedOrigins(hostile as never), /ALLOWED_ORIGINS must be a string/);
  assert.throws(() => parseIceServers(hostile as never), /ICE_SERVERS must be a string/);
  assert.throws(() => parseTurnUrls(hostile as never), /TURN_URLS must be a string/);
  assert.throws(() => loadServerConfig({ NODE_ENV: hostile as never }), /NODE_ENV must be a string/);
  assert.throws(() => loadServerConfig({ PORT: hostile as never }), /PORT must be a string/);
  assert.throws(() => loadServerConfig({ HOST: hostile as never }), /HOST must be a string/);
  assert.throws(() => loadServerConfig({ ALLOWED_ORIGINS: hostile as never }), /ALLOWED_ORIGINS must be a string/);
  assert.throws(() => loadServerConfig({ TURN_REST_SECRET: strongTurnSecret, TURN_URLS: hostile as never }), /TURN_URLS must be a string/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_ANY_WSS: hostile as never }), /BROWSER_ALLOW_ANY_WSS must be a string/);
  assert.throws(() => loadServerConfig({ BROWSER_ALLOW_LOOPBACK_WS: hostile as never }), /BROWSER_ALLOW_LOOPBACK_WS must be a string/);
  assert.throws(() => loadServerConfig({ SIGNALING_TOPOLOGY: hostile as never }), /SIGNALING_TOPOLOGY must be a string/);
  assert.throws(() => loadServerConfig({ TRUSTED_PROXY_HOPS: hostile as never }), /TRUSTED_PROXY_HOPS must be a string/);
  assert.throws(() => loadServerConfig({ WEB_ROOT: hostile as never }), /WEB_ROOT must be a string/);
  assert.equal(toStringCalled, false);

  assert.match(securityPolicy, /server configuration must reject non-string environment values before trim, split, JSON parse, URL parse, or byte-length checks/);
  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function optionalEnvString/);
    assert.match(source, /function requiredEnvString/);
    assert.match(source, /must be a string/);
    assert.match(source, /parseIceServers[\s\S]*optionalEnvString\(raw, "ICE_SERVERS"\)/);
    assert.match(source, /parseAllowedOrigins[\s\S]*optionalEnvString\(raw, "ALLOWED_ORIGINS"\)/);
    assert.match(source, /parseTurnUrls[\s\S]*requiredEnvString\(raw, "TURN_URLS"\)/);
    assert.match(source, /parseBrowserLoopbackWs[\s\S]*optionalEnvString\(envValue\(env, "BROWSER_ALLOW_LOOPBACK_WS"\), "BROWSER_ALLOW_LOOPBACK_WS"\)/);
    assert.match(source, /parseWebRoot[\s\S]*optionalEnvString\(raw, "WEB_ROOT"\)/);
  }
});

test("server config reads environment values through own data descriptors", () => {
  assert.match(securityPolicy, /server configuration must read environment values through own data descriptors/);

  const validEnv = {
    NODE_ENV: "production",
    ICE_SERVERS: '[{"urls":"stun:stun.example.test"}]',
    HOST: "127.0.0.1",
    ALLOWED_ORIGINS: "https://files.example",
    ALLOW_ANY_ORIGIN: "false",
    ALLOW_INSECURE_ORIGINS: "false",
    PORT: "8787",
    WEB_ROOT: "dist-web",
    BROWSER_ALLOW_ANY_WSS: "false",
    BROWSER_ALLOW_LOOPBACK_WS: "false",
    SIGNALING_TOPOLOGY: "single-instance",
    TURN_REST_SECRET: strongTurnSecret,
    TURN_URLS: '"turn:turn.example.test"',
    TURN_TTL_SECONDS: "600"
  };

  for (const name of Object.keys(validEnv)) {
    let invoked = false;
    const env = { ...validEnv };
    Object.defineProperty(env, name, {
      get() {
        invoked = true;
        return validEnv[name as keyof typeof validEnv];
      }
    });
    assert.throws(() => loadServerConfig(env as never), new RegExp(`${name} must be a data property`));
    assert.equal(invoked, false, `${name} getter should not run`);
  }

  assert.throws(() => loadServerConfig(null as never), /Server environment is invalid/);
  assert.throws(() => loadServerConfig([] as never), /Server environment is invalid/);

  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function envValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(env, name\)/);
    assert.doesNotMatch(source, /env\.[A-Z_]+/);
  }
});

test("server config accepts explicit STUN and TURN ICE servers", () => {
  const iceServers = parseIceServers(
    '[{"urls":["stun:stun.example.test:3478","turns:turn.example.test:5349?transport=tcp"],"username":"u","credential":"p"}]'
  );
  assert.deepEqual(iceServers, [
    { urls: ["stun:stun.example.test:3478", "turns:turn.example.test:5349?transport=tcp"], username: "u", credential: "p" }
  ]);
});

test("server config rejects static TURN credentials in production", () => {
  const iceServers = '[{"urls":"turn:turn.example.test:3478","username":"u","credential":"p"}]';
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance", ICE_SERVERS: iceServers }), /Static TURN credentials/);
  assert.throws(
    () => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance", ICE_SERVERS: '[{"urls":"turn:user@turn.example.test:3478"}]' }),
    /ICE_SERVERS/
  );
  assert.throws(
    () => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance", ALLOW_STATIC_TURN_CREDENTIALS: "true", ICE_SERVERS: iceServers }),
    /Static TURN credentials/
  );
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance", ICE_SERVERS: '[{"urls":"turn:turn.example.test:3478"}]' }), /ICE_SERVERS/);
  assert.match(securityPolicy, /production configuration must reject reusable static TURN credentials/);
});

test("server config requires an explicit browser origin policy in production", () => {
  assert.match(securityPolicy, /production-mode checks must parse `NODE_ENV` fail-closed/);
  assert.match(securityPolicy, /server environment JSON and list inputs must be byte-capped before trim, split, JSON parse, or credential use/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "production" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOW_ANY_ORIGIN: "true" }), /ALLOW_ANY_ORIGIN/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOW_ANY_ORIGIN: "true", ALLOWED_ORIGINS: "https://files.example" }), /ALLOW_ANY_ORIGIN/);
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example" }), /SIGNALING_TOPOLOGY/);
  assert.deepEqual(loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).allowedOrigins, ["https://files.example"]);
  assert.equal(loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "sticky-sessions" }).signalingTopology, "sticky-sessions");
  assert.throws(() => loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "http://files.example", SIGNALING_TOPOLOGY: "single-instance" }), /must use https/);
  assert.deepEqual(loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "http://files.example", SIGNALING_TOPOLOGY: "single-instance", ALLOW_INSECURE_ORIGINS: "true" }).allowedOrigins, [
    "http://files.example"
  ]);
});

test("server config requires an explicit browser origin policy for non-loopback binds", () => {
  assert.throws(() => loadServerConfig({ HOST: "0.0.0.0" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadServerConfig({ HOST: "::" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadServerConfig({ HOST: "files.example" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadServerConfig({ HOST: "0.0.0.0", ALLOWED_ORIGINS: "https://files.example" }), /SIGNALING_TOPOLOGY/);
  assert.equal(loadServerConfig({ HOST: "0.0.0.0", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "0.0.0.0");
  assert.equal(loadServerConfig({ HOST: "::", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "::");
  assert.equal(loadServerConfig({ HOST: "files.example", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "sticky-sessions" }).host, "files.example");
  assert.equal(loadServerConfig({ HOST: "localhost" }).host, "localhost");
  assert.equal(loadServerConfig({ HOST: "127.0.0.1" }).host, "127.0.0.1");
  assert.equal(loadServerConfig({ HOST: "::1" }).host, "::1");
});

test("server config defaults are explicit and usable for local development", () => {
  const config = loadServerConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.iceServers.length > 0, true);
  assert.equal(config.webRoot, projectWebRoot);
  assert.equal(loadServerConfig({ WEB_ROOT: "" }).webRoot, projectWebRoot);
  assert.equal(loadServerConfig({ WEB_ROOT: "   " }).webRoot, projectWebRoot);
  assert.throws(() => loadServerConfig({ WEB_ROOT: "x".repeat(4097) }), /WEB_ROOT.*at most/);
  assert.throws(() => loadServerConfig({ WEB_ROOT: "dist-web\n" }), /WEB_ROOT.*control characters/);
  assert.throws(() => loadServerConfig({ WEB_ROOT: "dist-web\u200b" }), /WEB_ROOT.*format characters/);
  assert.equal(config.allowedOrigins, undefined);
  assert.equal(config.signalingTopology, undefined);
  assert.equal(config.browserAllowAnyWss, false);
  assert.equal(config.browserAllowLoopbackWs, true);
  assert.equal(config.trustedProxyHops, 0);
  assert.equal(loadServerConfig({ TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops, 1);
  assert.equal(loadServerConfig({ TRUSTED_PROXY_HOPS: "3" }).trustedProxyHops, 3);
  assert.equal(config.turnRest, undefined);
});

test("default web root is anchored to the shipped server module, not process cwd", () => {
  assert.match(securityPolicy, /default static web root must resolve relative to the shipped server module/);
  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
    assert.match(source, /function defaultWebRoot/);
    assert.doesNotMatch(source, /return path\.resolve\("dist-web"\)/);
  }

  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-config-cwd-"));
  try {
    process.chdir(tmp);
    assert.equal(loadServerConfig({}).webRoot, projectWebRoot);
    assert.equal(loadServerConfig({ WEB_ROOT: "" }).webRoot, projectWebRoot);
    assert.equal(loadServerConfig({ WEB_ROOT: "relative-web" }).webRoot, path.resolve("relative-web"));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("default ICE server constants are immutable runtime snapshots", () => {
  assert.match(securityPolicy, /default ICE server constants must be immutable runtime snapshots/);
  assert.equal(Object.isFrozen(DEFAULT_ICE_SERVERS), true);
  assert.equal(Object.isFrozen(DEFAULT_ICE_SERVERS[0]), true);
  assert.throws(() => (DEFAULT_ICE_SERVERS as RTCIceServer[]).push({ urls: "stun:mutated.example.test" }), TypeError);
  assert.throws(() => {
    (DEFAULT_ICE_SERVERS[0] as RTCIceServer).urls = "stun:mutated.example.test";
  }, TypeError);
  assert.deepEqual(loadServerConfig({}).iceServers, [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]);
});

test("server ICE configuration helpers return defensive snapshots", () => {
  assert.match(securityPolicy, /server ICE configuration helpers must return defensive snapshots/);

  const defaultConfig = loadServerConfig({});
  defaultConfig.iceServers[0]!.urls = "stun:mutated.example.test";
  assert.deepEqual(loadServerConfig({}).iceServers, DEFAULT_ICE_SERVERS);

  const explicitConfig = loadServerConfig({
    ICE_SERVERS: '[{"urls":["stun:stun-a.example.test","stun:stun-b.example.test"]}]',
    TURN_REST_SECRET: strongTurnSecret,
    TURN_URLS: '["turn:turn.example.test","turns:turn.example.test:5349"]'
  });

  const authenticated = iceServersForRequest(explicitConfig, 1_700_000_000_000);
  (authenticated[0]!.urls as string[]).push("stun:mutated.example.test");
  (authenticated[1]!.urls as string[]).push("turn:mutated.example.test");
  assert.deepEqual(explicitConfig.iceServers, [{ urls: ["stun:stun-a.example.test", "stun:stun-b.example.test"] }]);

  const nextAuthenticated = iceServersForRequest(explicitConfig, 1_700_000_000_000);
  assert.deepEqual(nextAuthenticated[0]!.urls, ["stun:stun-a.example.test", "stun:stun-b.example.test"]);
  assert.deepEqual(nextAuthenticated[1]!.urls, ["turn:turn.example.test", "turns:turn.example.test:5349"]);

  const unauthenticated = iceServersForUnauthenticatedRequest(explicitConfig);
  (unauthenticated[0]!.urls as string[]).push("stun:mutated.example.test");
  assert.deepEqual(iceServersForUnauthenticatedRequest(explicitConfig), [{ urls: ["stun:stun-a.example.test", "stun:stun-b.example.test"] }]);

  const turnOnlyConfig = loadServerConfig({ ICE_SERVERS: '[{"urls":"turn:turn.example.test","username":"u","credential":"p"}]' });
  const fallback = iceServersForUnauthenticatedRequest(turnOnlyConfig);
  fallback[0]!.urls = "stun:mutated.example.test";
  assert.deepEqual(iceServersForUnauthenticatedRequest(turnOnlyConfig), DEFAULT_ICE_SERVERS);
});

test("server ICE configuration helpers reject malformed runtime config without invoking accessors", () => {
  assert.match(securityPolicy, /exported ICE\/TURN configuration helpers must read runtime config through own data descriptors/);

  let invoked = false;
  const accessorIceConfig = {};
  Object.defineProperty(accessorIceConfig, "iceServers", {
    get() {
      invoked = true;
      return [{ urls: "stun:stun.example.test" }];
    }
  });
  assert.throws(() => iceServersForRequest(accessorIceConfig as never, 1_700_000_000_000), /Server config is invalid/);
  assert.throws(() => iceServersForUnauthenticatedRequest(accessorIceConfig as never), /Server config is invalid/);

  const accessorTurnRestConfig = { iceServers: [{ urls: "stun:stun.example.test" }] };
  Object.defineProperty(accessorTurnRestConfig, "turnRest", {
    get() {
      invoked = true;
      return { urls: "turn:turn.example.test", secret: strongTurnSecret, ttlSeconds: 600 };
    }
  });
  assert.throws(() => iceServersForRequest(accessorTurnRestConfig as never, 1_700_000_000_000), /Server config fields must be data properties/);

  const accessorSecret = { urls: "turn:turn.example.test", ttlSeconds: 600 };
  Object.defineProperty(accessorSecret, "secret", {
    get() {
      invoked = true;
      return strongTurnSecret;
    }
  });
  assert.throws(() => iceServersForRequest({ iceServers: [], turnRest: accessorSecret } as never, 1_700_000_000_000), /TURN REST config is invalid/);

  const accessorUrlList = ["turn:turn.example.test"];
  Object.defineProperty(accessorUrlList, "0", {
    get() {
      invoked = true;
      return "turn:turn.example.test";
    }
  });
  assert.throws(
    () => iceServersForRequest({ iceServers: [], turnRest: { urls: accessorUrlList, secret: strongTurnSecret, ttlSeconds: 600 } } as never, 1_700_000_000_000),
    /TURN REST config is invalid/
  );
  const oversizedTurnUrls = new Array(9).fill("turn:turn.example.test");
  Object.defineProperty(oversizedTurnUrls, "0", {
    get() {
      invoked = true;
      return "turn:turn.example.test";
    }
  });
  assert.throws(
    () => iceServersForRequest({ iceServers: [], turnRest: { urls: oversizedTurnUrls, secret: strongTurnSecret, ttlSeconds: 600 } } as never, 1_700_000_000_000),
    /TURN REST config is invalid/
  );

  assert.throws(
    () =>
      iceServersForRequest(
        { iceServers: [], turnRest: { urls: "turn:turn.example.test", secret: strongTurnSecret, ttlSeconds: 600 } } as never,
        {
          valueOf() {
            invoked = true;
            return 1_700_000_000_000;
          }
        } as never
      ),
    /TURN credential timestamp is invalid/
  );
  assert.equal(invoked, false);

  assert.deepEqual(iceServersForUnauthenticatedRequest({ iceServers: [{ urls: ["stun:stun.example.test", "stun:bad\nhost"] }] } as never), [
    { urls: "stun:stun.example.test" }
  ]);

  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function configIceServers/);
    assert.match(source, /function configTurnRest/);
    assert.match(source, /value\.length === 0 \|\| value\.length > MAX_TURN_URLS[\s\S]*for \(let index = 0; index < value\.length; index \+= 1\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor/);
    assert.match(source, /function turnCredentialExpiresAt/);
    assert.doesNotMatch(source, /config\.iceServers/);
    assert.doesNotMatch(source, /config\.turnRest/);
  }
});

test("server config rejects ephemeral port binding", () => {
  assert.equal(loadServerConfig({ PORT: "1" }).port, 1);
  assert.equal(loadServerConfig({ PORT: "65535" }).port, 65535);
  assert.throws(() => loadServerConfig({ PORT: "0" }), /between 1 and 65535/);
});

test("server config requires explicit opt-in before browser CSP allows arbitrary secure signaling hosts", () => {
  assert.equal(loadServerConfig({}).browserAllowAnyWss, false);
  assert.equal(loadServerConfig({ BROWSER_ALLOW_ANY_WSS: "false" }).browserAllowAnyWss, false);
  assert.equal(loadServerConfig({ BROWSER_ALLOW_ANY_WSS: "true" }).browserAllowAnyWss, true);
});

test("server config disables browser loopback WebSockets in production unless explicitly enabled", () => {
  assert.equal(loadServerConfig({}).browserAllowLoopbackWs, true);
  assert.equal(loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).browserAllowLoopbackWs, false);
  assert.equal(
    loadServerConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance", BROWSER_ALLOW_LOOPBACK_WS: "true" }).browserAllowLoopbackWs,
    true
  );
  assert.equal(loadServerConfig({ BROWSER_ALLOW_LOOPBACK_WS: "false" }).browserAllowLoopbackWs, false);
});

test("server config accepts explicit hostnames and IP bind addresses", () => {
  assert.equal(loadServerConfig({ HOST: "files.example", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "files.example");
  assert.equal(loadServerConfig({ HOST: "1.example", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "1.example");
  assert.equal(loadServerConfig({ HOST: "0.0.0.0", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "0.0.0.0");
  assert.equal(loadServerConfig({ HOST: "::", ALLOWED_ORIGINS: "https://files.example", SIGNALING_TOPOLOGY: "single-instance" }).host, "::");
  assert.equal(loadServerConfig({ HOST: "::1" }).host, "::1");
});

test("server config issues ephemeral TURN REST credentials without static secrets", () => {
  assert.match(securityPolicy, /`TURN_URLS` parsing must reject empty or over-cap JSON arrays before element validation/);
  assert.equal(parseTurnUrls('"turn:turn.example.test:3478?transport=tcp"'), "turn:turn.example.test:3478?transport=tcp");
  assert.deepEqual(parseTurnUrls('["turn:turn.example.test","turns:turn.example.test:5349"]'), ["turn:turn.example.test", "turns:turn.example.test:5349"]);
  assert.throws(() => parseTurnUrls(JSON.stringify(new Array(9).fill("turn:turn.example.test"))), /TURN_URLS/);
  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function parseTurnUrlArray/);
    assert.match(source, /value\.length === 0 \|\| value\.length > MAX_TURN_URLS[\s\S]*Object\.getOwnPropertyDescriptor\(value, String\(index\)\)/);
    assert.doesNotMatch(source, /Array\.isArray\(parsed\) && parsed\.every/);
    assert.doesNotMatch(source, /list\.some\(hasUrlCredentials\)/);
    assert.doesNotMatch(source, /list\.every\(isTurnUrl\)/);
  }
  const config = loadServerConfig({
    ICE_SERVERS: '[{"urls":"stun:stun.example.test"}]',
    TURN_REST_SECRET: strongTurnSecret,
    TURN_URLS: '["turn:turn.example.test:3478?transport=tcp"]',
    TURN_TTL_SECONDS: "600"
  });
  const issued = iceServersForRequest(config, 1_700_000_000_000);
  assert.deepEqual(issued[0], { urls: "stun:stun.example.test" });
  assert.equal(issued[1]?.urls instanceof Array, true);
  assert.match(String(issued[1]?.username), /^1700000600:[a-f0-9]{16}$/);
  assert.match(String(issued[1]?.credential), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(iceServersForUnauthenticatedRequest(config), [{ urls: "stun:stun.example.test" }]);
  assert.deepEqual(
    iceServersForUnauthenticatedRequest(
      loadServerConfig({
        ICE_SERVERS: '[{"urls":["stun:stun.example.test","turn:turn.example.test"],"username":"u","credential":"p"},{"urls":"turns:turn2.example.test","username":"u2","credential":"p2"}]'
      })
    ),
    [{ urls: "stun:stun.example.test" }]
  );
  assert.deepEqual(
    iceServersForUnauthenticatedRequest(loadServerConfig({ ICE_SERVERS: '[{"urls":"turn:turn.example.test","username":"u","credential":"p"}]' })),
    loadServerConfig({}).iceServers
  );
});

test("server config parses strict browser origin allowlists", () => {
  assert.match(securityPolicy, /`ALLOWED_ORIGINS` parsing must reject empty comma entries, leading\/trailing entry whitespace, and over-cap origin counts while scanning/);
  assert.deepEqual(parseAllowedOrigins("https://send.example,http://localhost:5173"), ["https://send.example", "http://localhost:5173"]);
  assert.deepEqual(parseAllowedOrigins("https://1.example,http://[::1]:5173"), ["https://1.example", "http://[::1]:5173"]);
  assert.equal(originAllowed("https://send.example", ["https://send.example"]), true);
  assert.equal(originAllowed("https://evil.example", ["https://send.example"]), false);
  assert.equal(originAllowed(undefined, ["https://send.example"]), true);
  assert.equal(originAllowedForRequest(undefined, undefined, "files.example"), true);
  assert.equal(originAllowedForRequest("http://localhost:5173", undefined, "localhost:8787"), true);
  assert.equal(originAllowedForRequest("http://127.0.0.1:5173", undefined, "127.0.0.1:8787"), true);
  assert.equal(originAllowedForRequest("http://[::1]:5173", undefined, "[::1]:8787"), true);
  assert.equal(originAllowedForRequest("http://localhost:5173/path", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("http://localhost:5173?debug=1", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("http://localhost:5173#debug", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("http://user@localhost:5173", undefined, "localhost:8787"), false);
  assert.equal(distOriginAllowedForRequest("http://localhost:5173/path", undefined, "localhost:8787"), false);
  assert.equal(distOriginAllowedForRequest("http://localhost:5173?debug=1", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("https://send.example", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("https://send.example", undefined, "127.0.0.1:8787"), false);
  assert.equal(originAllowedForRequest("https://send.example", undefined, "[::1]:8787"), false);
  assert.equal(originAllowedForRequest("https://send.example", undefined, "files.example"), false);
  assert.equal(originAllowedForRequest("https://send.example", undefined, null), false);
  assert.equal(originAllowedForRequest("https://send.example", ["https://send.example"], "files.example"), true);
  assert.equal(originAllowedForRequest("https://evil.example", ["https://send.example"], "localhost:8787"), false);
  assert.deepEqual(corsHeaders("https://send.example", ["https://send.example"]), {
    "access-control-allow-origin": "https://send.example",
    vary: "Origin"
  });
  assert.deepEqual(corsHeaders(undefined, ["https://send.example"]), {});
  assert.deepEqual(corsHeaders("https://send.example", undefined), { "access-control-allow-origin": "*" });
  assert.equal(corsHeaders("https://evil.example", ["https://send.example"]), null);
  assert.equal(corsHeaders(["https://send.example", "https://evil.example"], ["https://send.example"]), null);
  assert.equal(corsHeaders(["https://send.example", "https://evil.example"], undefined), null);
  assert.throws(() => parseAllowedOrigins(" ".repeat(16 * 1024 + 1)), /ALLOWED_ORIGINS.*at most/);
  assert.throws(() => parseAllowedOrigins("https://send.example,"), /must not be empty/);
  assert.throws(() => parseAllowedOrigins(",https://send.example"), /must not be empty/);
  assert.throws(() => parseAllowedOrigins("https://send.example,,https://evil.example"), /must not be empty/);
  assert.throws(() => parseAllowedOrigins("https://send.example, https://evil.example"), /must not contain whitespace/);
  assert.throws(() => parseAllowedOrigins(" https://send.example"), /must not contain whitespace/);
  assert.throws(() => parseAllowedOrigins("https://send.example "), /must not contain whitespace/);
  assert.throws(() => parseAllowedOrigins(",".repeat(16 * 1024)), /must not be empty/);
  assert.throws(() => parseAllowedOrigins("https://bad_host"), /valid hostnames/);
  assert.throws(() => parseAllowedOrigins("https://-send.example"), /valid hostnames/);
  assert.throws(() => parseAllowedOrigins("https://send.example."), /valid hostnames/);
  assert.throws(() => parseAllowedOrigins("https://send..example"), /valid hostnames/);
  assert.throws(() => parseAllowedOrigins("https://send.example/path"), /exact URL origins/);
  assert.throws(() => parseAllowedOrigins("https://send.example:0"), /port 0/);
  assert.throws(() => parseAllowedOrigins("https://send.example\nhttps://evil.example"), /control characters/);
  assert.throws(() => parseAllowedOrigins("https://send.example\u200b"), /format characters/);
  assert.throws(() => parseAllowedOrigins("https://2130706433"), /exact URL origins/);
  assert.throws(() => parseAllowedOrigins("https://0x7f000001"), /exact URL origins/);
  assert.throws(() => parseAllowedOrigins("wss://send.example"), /http or https/);
  assert.throws(() => parseAllowedOrigins("null"), /exact URL origins/);
  assert.throws(() => parseAllowedOrigins(new Array(33).fill("https://send.example").join(",")), /at most 32/);
  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function parseAllowedOriginList/);
    assert.match(source, /origins\.length >= 32[\s\S]*raw\.slice\(start, index\)[\s\S]*origin !== origin\.trim\(\)/);
    assert.doesNotMatch(source, /\.split\(","\)[\s\S]*\.filter\(\(origin\) => origin\.length > 0\)/);
  }
});

test("origin policy helpers reject malformed runtime inputs without invoking accessors or coercion", () => {
  assert.match(securityPolicy, /origin policy helpers must reject non-string runtime origins and descriptor-validate allowlists/);

  let invoked = false;
  const hostileOrigin = {
    toString() {
      invoked = true;
      return "http://localhost:5173";
    }
  };
  const accessorAllowlist = ["https://send.example"];
  Object.defineProperty(accessorAllowlist, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return "https://send.example";
    }
  });

  assert.equal(originAllowedForRequest(hostileOrigin as never, undefined, "localhost:8787"), false);
  assert.equal(distOriginAllowedForRequest(hostileOrigin as never, undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest(`http://localhost/${"a".repeat(2048)}`, undefined, "localhost:8787"), false);
  assert.equal(distOriginAllowedForRequest(`http://localhost/${"a".repeat(2048)}`, undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("http://localhost\n", undefined, "localhost:8787"), false);
  assert.equal(distOriginAllowedForRequest("http://localhost\n", undefined, "localhost:8787"), false);
  assert.equal(originAllowedForRequest("https://send.example", accessorAllowlist as never, "files.example"), false);
  assert.equal(distOriginAllowedForRequest("https://send.example", accessorAllowlist as never, "files.example"), false);
  assert.equal(corsHeaders("https://send.example", accessorAllowlist as never), null);
  assert.equal(distCorsHeaders("https://send.example", accessorAllowlist as never), null);
  assert.equal(corsHeaders("https://send.example", new Array(33).fill("https://send.example") as never), null);
  assert.equal(invoked, false);
  assert.match(securityPolicy, /origin policy helpers must cap raw `Origin` values and require exact URL origins before loopback URL parsing succeeds/);

  for (const source of [configSource, distConfigSource]) {
    assert.match(source, /function allowedOriginContains/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(allowedOrigins, String\(index\)\)/);
    assert.doesNotMatch(source, /allowedOrigins\.includes/);
    assert.match(source, /typeof origin !== "string"/);
    assert.match(source, /MAX_ORIGIN_HEADER_BYTES/);
    assert.match(source, /function utf8ByteLengthExceeds/);
    assert.match(source, /parsed\.origin === origin/);
    assert.match(source, /parsed\.port !== "0"/);
    assert.match(source, /typeof requestAuthority === "string"/);
  }
});
