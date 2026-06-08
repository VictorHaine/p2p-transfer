import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { STATIC_MAX_FILE_BYTES } from "../shared/constants.js";
import { isPathInsideRoot } from "./static-path.js";

const MANIFEST_FILE_NAME = "asset-manifest.json";

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
    const handle = await fs.open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > STATIC_MAX_FILE_BYTES) throw new Error("web asset manifest is invalid");
      body = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingManifestError(error) && !production) return undefined;
    throw new Error("web asset manifest is invalid");
  }
  return parseWebAssetManifest(body);
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
