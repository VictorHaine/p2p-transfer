import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const MAX_DOCKER_CONFIG_BYTES = 64 * 1024;
const MAX_DOCKER_CONTEXT_BYTES = 32 * 1024;
const DOCKER_CONTEXT_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/u;
const DOCKER_CLI_PLUGIN_NAME_RE = /^docker-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export function createIsolatedDockerConfig(prefix = "p2p-transfer-docker-", sourceConfigRoot = defaultDockerConfigRoot()) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  const localContext = localDockerContext(sourceConfigRoot);
  const config = localContext ? { auths: {}, currentContext: localContext.name } : { auths: {} };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  if (localContext) writeDockerContext(dir, localContext);
  return dir;
}

export function assertNoUserDockerCliPlugins(sourceConfigRoot = defaultDockerConfigRoot()) {
  const pluginDir = path.join(sourceConfigRoot, "cli-plugins");
  let entries;
  try {
    entries = readdirSync(pluginDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) return;
    throw new Error("Docker CLI plugin directory could not be safely inspected for release validation.");
  }
  for (const entry of entries) {
    if (!DOCKER_CLI_PLUGIN_NAME_RE.test(entry.name)) continue;
    let info;
    try {
      info = lstatSync(path.join(pluginDir, entry.name));
    } catch {
      throw new Error("Docker CLI plugin directory changed during release validation.");
    }
    if (info.isFile() || info.isSymbolicLink()) {
      throw new Error("User Docker CLI plugins must be disabled before Docker release validation because Docker can execute plugin metadata outside isolated DOCKER_CONFIG.");
    }
  }
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
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(info, opened)) return undefined;
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = readSync(fd, bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) return undefined;
    if (!sameFile(opened, fstatSync(fd))) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isMissingDirectoryError(error) {
  return error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
