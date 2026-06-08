import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { STATIC_MAX_FILE_BYTES } from "../shared/constants.js";
import { isPathInsideRoot } from "./static-path.js";

const MANIFEST_FILE_NAME = "asset-manifest.json";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type WebAssetEntry = {
  bytes: number;
  sha256: string;
  sri: string;
};

export type WebAssetManifest = {
  files: ReadonlyMap<string, WebAssetEntry>;
};

export async function loadWebAssetManifest(webRoot: string, production: boolean): Promise<WebAssetManifest | undefined> {
  const manifestPath = path.join(webRoot, MANIFEST_FILE_NAME);
  let body: string;
  try {
    body = await readManifestText(manifestPath);
  } catch (error) {
    if (isMissingManifestError(error) && !production) return undefined;
    throw new Error("web asset manifest is invalid");
  }
  const manifest = parseWebAssetManifest(body);
  await verifyManifestAssets(webRoot, manifest);
  return manifest;
}

async function readManifestText(manifestPath: string): Promise<string> {
  const info = await fs.lstat(manifestPath);
  if (!info.isFile() || info.size < 1 || info.size > STATIC_MAX_FILE_BYTES) throw new Error("web asset manifest is invalid");
  const handle = await fs.open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > STATIC_MAX_FILE_BYTES || !sameFile(info, stat)) throw new Error("web asset manifest is invalid");
    const body = await readExactFile(handle, stat.size);
    const afterRead = await handle.stat();
    if (!sameFile(stat, afterRead)) throw new Error("web asset manifest is invalid");
    return UTF8_DECODER.decode(body);
  } finally {
    await handle.close();
  }
}

async function readExactFile(handle: FileHandle, size: number): Promise<Buffer> {
  const body = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(body, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error("web asset manifest is invalid");
    offset += bytesRead;
  }
  return body;
}

function sameFile(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function verifyManifestAssets(webRoot: string, manifest: WebAssetManifest): Promise<void> {
  const realRoot = await fs.realpath(webRoot);
  for (const assetPath of manifest.files.keys()) {
    const candidate = path.resolve(realRoot, `.${assetPath}`);
    if (!isPathInsideRoot(realRoot, candidate)) throw new Error("web asset manifest is invalid");
    const realFilePath = await fs.realpath(candidate);
    if (!isPathInsideRoot(realRoot, realFilePath)) throw new Error("web asset manifest is invalid");
    const body = await readAssetBytes(realFilePath);
    verifyWebAssetIntegrity(manifest, realRoot, realFilePath, body);
  }
}

async function readAssetBytes(filePath: string): Promise<Buffer> {
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.size < 0 || info.size > STATIC_MAX_FILE_BYTES) throw new Error("web asset manifest is invalid");
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > STATIC_MAX_FILE_BYTES || !sameFile(info, stat)) throw new Error("web asset manifest is invalid");
    const body = await readExactFile(handle, stat.size);
    const afterRead = await handle.stat();
    if (!sameFile(stat, afterRead)) throw new Error("web asset manifest is invalid");
    return body;
  } finally {
    await handle.close();
  }
}

export function verifyWebAssetIntegrity(manifest: WebAssetManifest | undefined, realRoot: string, realFilePath: string, body: Buffer): void {
  if (!manifest) return;
  const assetPath = webAssetPath(realRoot, realFilePath);
  if (!assetRequiresIntegrity(assetPath)) return;
  const expected = manifest.files.get(assetPath);
  if (!expected) throw new Error("static asset integrity check failed");
  const actual = digestBody(body);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.sri !== expected.sri) {
    throw new Error("static asset integrity check failed");
  }
}

function parseWebAssetManifest(body: string): WebAssetManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("web asset manifest is invalid");
  }
  if (!isPlainObject(parsed)) throw new Error("web asset manifest is invalid");
  if (ownDataValue(parsed, "version") !== 1 || ownDataValue(parsed, "algorithm") !== "sha256") throw new Error("web asset manifest is invalid");
  const rawFiles = ownDataValue(parsed, "files");
  if (!isPlainObject(rawFiles)) throw new Error("web asset manifest is invalid");

  const files = new Map<string, WebAssetEntry>();
  for (const [assetPath, rawEntry] of Object.entries(rawFiles)) {
    if (!isSafeManifestAssetPath(assetPath) || !isPlainObject(rawEntry)) throw new Error("web asset manifest is invalid");
    const bytes = ownDataValue(rawEntry, "bytes");
    const sha256 = ownDataValue(rawEntry, "sha256");
    const sri = ownDataValue(rawEntry, "sri");
    if (!isSafeByteLength(bytes) || !isSha256Hex(sha256) || sri !== `sha256-${Buffer.from(sha256, "hex").toString("base64")}`) {
      throw new Error("web asset manifest is invalid");
    }
    files.set(assetPath, { bytes, sha256, sri });
  }

  if (!files.has("/index.html")) throw new Error("web asset manifest is invalid");
  if (![...files.keys()].some((assetPath) => assetPath.endsWith(".js"))) throw new Error("web asset manifest is invalid");
  return { files };
}

function webAssetPath(realRoot: string, realFilePath: string): string {
  if (!isPathInsideRoot(realRoot, realFilePath)) throw new Error("static asset integrity check failed");
  const relative = path.relative(realRoot, realFilePath).split(path.sep).join("/");
  return `/${relative}`;
}

function assetRequiresIntegrity(assetPath: string): boolean {
  return assetPath === "/index.html" || assetPath.endsWith(".js") || assetPath.endsWith(".css");
}

function isSafeManifestAssetPath(assetPath: string): boolean {
  return (
    typeof assetPath === "string" &&
    assetRequiresIntegrity(assetPath) &&
    assetPath.startsWith("/") &&
    !assetPath.startsWith("//") &&
    !assetPath.includes("..") &&
    !/[\p{Cc}\p{Cf}\\]/u.test(assetPath)
  );
}

function digestBody(body: Buffer): WebAssetEntry {
  const hash = createHash("sha256").update(body).digest();
  const sha256 = hash.toString("hex");
  return {
    bytes: body.byteLength,
    sha256,
    sri: `sha256-${hash.toString("base64")}`
  };
}

function isMissingManifestError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && (descriptor.value === "ENOENT" || descriptor.value === "ENOTDIR");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isSafeByteLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= STATIC_MAX_FILE_BYTES;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
