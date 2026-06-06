import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { name?: unknown; version?: unknown };

export const PACKAGE_NAME = requirePackageString(packageJson.name, "name");
export const PACKAGE_VERSION = requirePackageString(packageJson.version, "version");

function requirePackageString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`package.json ${field} must be a non-empty string.`);
  return value;
}
