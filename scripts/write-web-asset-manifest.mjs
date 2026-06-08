#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "dist-web");
const indexPath = path.join(webRoot, "index.html");
const manifestPath = path.join(webRoot, "asset-manifest.json");
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const indexHtml = (await readBoundedNoFollow(indexPath)).toString("utf8");
const assetRefs = [...findAssetRefs(indexHtml)];
if (assetRefs.length === 0) throw new Error("No browser assets found in dist-web/index.html.");

const files = {};
let html = indexHtml;
for (const ref of assetRefs) {
  const assetPath = path.resolve(webRoot, `.${ref}`);
  if (!isPathInsideRoot(webRoot, assetPath)) throw new Error("Browser asset path escapes dist-web.");
  const body = await readBoundedNoFollow(assetPath);
  const digest = digestBody(body);
  files[ref] = digest;
  html = injectIntegrity(html, ref, digest.sri);
}

if (html === indexHtml) throw new Error("No browser asset integrity attributes were injected.");
await writeNoFollow(indexPath, html);

const finalIndex = await readBoundedNoFollow(indexPath);
files["/index.html"] = digestBody(finalIndex);

await fs.writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      version: 1,
      algorithm: "sha256",
      files
    },
    null,
    2
  )}\n`,
  { encoding: "utf8", flag: "w" }
);

function* findAssetRefs(html) {
  const pattern = /<(?:script|link)\b[^>]+(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"[^>]*>/g;
  const seen = new Set();
  for (const match of html.matchAll(pattern)) {
    const ref = match[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    yield ref;
  }
}

function injectIntegrity(html, ref, sri) {
  const escapedRef = escapeRegExp(ref);
  const pattern = new RegExp(`(<(?:script|link)\\b(?=[^>]+(?:src|href)="${escapedRef}")[^>]*)(>)`, "g");
  return html.replace(pattern, (_match, open, close) => {
    const withoutOldIntegrity = open.replace(/\s+integrity="[^"]*"/g, "");
    return `${withoutOldIntegrity} integrity="${sri}"${close}`;
  });
}

function digestBody(body) {
  const hash = createHash("sha256").update(body).digest();
  return {
    bytes: body.byteLength,
    sha256: hash.toString("hex"),
    sri: `sha256-${hash.toString("base64")}`
  };
}

async function readBoundedNoFollow(filePath) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_ASSET_BYTES) throw new Error("Browser asset exceeds maximum size.");
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(body, offset, stat.size - offset, offset);
      if (bytesRead === 0) throw new Error("Browser asset changed while reading.");
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    if (afterRead.dev !== stat.dev || afterRead.ino !== stat.ino || afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || afterRead.ctimeMs !== stat.ctimeMs) {
      throw new Error("Browser asset changed while reading.");
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function writeNoFollow(filePath, body) {
  const handle = await fs.open(filePath, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Browser index is not a regular file.");
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
}

function isPathInsideRoot(rootPath, candidate) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
