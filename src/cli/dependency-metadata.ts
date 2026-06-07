import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

export type DependencyEvidence = {
  name: string;
  version: string;
};

const MAX_PACKAGE_JSON_BYTES = 128 * 1024;

export function packageEvidenceFromResolvedFile(resolvedFile: string): DependencyEvidence & { root: string } {
  const root = packageRootFromResolvedFile(resolvedFile);
  const evidence = readPackageMetadata(path.join(root, "package.json"));
  if (typeof evidence.name !== "string" || typeof evidence.version !== "string") {
    throw new Error("Dependency package metadata is invalid.");
  }
  return { root, name: evidence.name, version: evidence.version };
}

function packageRootFromResolvedFile(resolvedFile: string): string {
  let current = path.dirname(resolvedFile);
  for (;;) {
    const packageJson = path.join(current, "package.json");
    if (pathExists(packageJson)) {
      const evidence = readPackageMetadata(packageJson);
      if (typeof evidence.name === "string") return current;
      throw new Error("Dependency package metadata is invalid.");
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Dependency package metadata is missing.");
    current = parent;
  }
}

function readPackageMetadata(file: string): { name?: unknown; version?: unknown } {
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error("Dependency package metadata is invalid.");
  if (info.size < 1 || info.size > MAX_PACKAGE_JSON_BYTES) throw new Error("Dependency package metadata is invalid.");

  const fd = openSync(file, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(info, opened)) {
      throw new Error("Dependency package metadata is invalid.");
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = readSync(fd, bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("Dependency package metadata is invalid.");
    if (!sameFile(opened, fstatSync(fd))) throw new Error("Dependency package metadata is invalid.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { name?: unknown; version?: unknown };
  } finally {
    closeSync(fd);
  }
}

function sameFile(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function pathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && "value" in descriptor && descriptor.value === "ENOENT");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
