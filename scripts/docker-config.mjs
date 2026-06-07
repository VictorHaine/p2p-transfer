import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const MAX_DOCKER_CONFIG_BYTES = 64 * 1024;
const MAX_DOCKER_CONTEXT_BYTES = 32 * 1024;
const DOCKER_CONTEXT_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/u;

export function createIsolatedDockerConfig(prefix = "p2p-transfer-docker-", sourceConfigRoot = defaultDockerConfigRoot()) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  const localContext = localDockerContext(sourceConfigRoot);
  const config = localContext ? { auths: {}, currentContext: localContext.name } : { auths: {} };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  if (localContext) writeDockerContext(dir, localContext);
  return dir;
}

function defaultDockerConfigRoot() {
  return path.join(homedir(), ".docker");
}

function localDockerContext(configRoot) {
  const currentContext = currentDockerContext(configRoot);
  if (!currentContext) return undefined;
  const context = dockerContextMetadata(configRoot, currentContext);
  if (!context) return undefined;
  return localContextFromMetadata(context);
}

function currentDockerContext(configRoot) {
  const config = readJsonFile(path.join(configRoot, "config.json"), MAX_DOCKER_CONFIG_BYTES);
  const currentContext = config?.currentContext;
  if (typeof currentContext !== "string" || currentContext === "default") return undefined;
  return DOCKER_CONTEXT_NAME_RE.test(currentContext) ? currentContext : undefined;
}

function dockerContextMetadata(configRoot, name) {
  const digest = createHash("sha256").update(name).digest("hex");
  return readJsonFile(path.join(configRoot, "contexts", "meta", digest, "meta.json"), MAX_DOCKER_CONTEXT_BYTES);
}

function localContextFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const name = metadata.Name;
  if (typeof name !== "string" || !DOCKER_CONTEXT_NAME_RE.test(name)) return undefined;
  const docker = metadata.Endpoints?.docker;
  if (!docker || typeof docker !== "object" || Array.isArray(docker)) return undefined;
  const host = docker.Host;
  if (typeof host !== "string" || !isLocalDockerHost(host)) return undefined;
  if (docker.SkipTLSVerify !== undefined && docker.SkipTLSVerify !== false) return undefined;
  if (metadata.TLSMaterial && Object.keys(metadata.TLSMaterial).length > 0) return undefined;
  return { name, host };
}

function isLocalDockerHost(host) {
  if (host.startsWith("unix://")) return path.isAbsolute(host.slice("unix://".length));
  return /^npipe:\/\/\/{2}\.\/pipe\/docker_engine$/iu.test(host);
}

function writeDockerContext(configDir, context) {
  const digest = createHash("sha256").update(context.name).digest("hex");
  const metadataDir = path.join(configDir, "contexts", "meta", digest);
  mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(metadataDir, "meta.json"),
    JSON.stringify({
      Name: context.name,
      Metadata: { Description: "Imported local Docker context for release validation" },
      Endpoints: { docker: { Host: context.host, SkipTLSVerify: false } }
    }),
    { mode: 0o600 }
  );
}

function readJsonFile(file, maxBytes) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) return undefined;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
