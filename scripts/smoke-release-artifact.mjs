#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, "release-artifacts");

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error("Release artifact smoke failed:");
    console.error(`- ${smokeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = requiredVersion(packageJson.version);
  await rm(artifactDir, { recursive: true, force: true });
  try {
    run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", "release-artifacts"], {});
    run(process.execPath, ["scripts/write-release-checksum.mjs"], {});
    run(process.execPath, ["scripts/verify-release-artifact.mjs"], { GITHUB_REF_NAME: `v${version}` });
  } finally {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 120_000
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error("package version must be an exact semver release.");
  return value;
}

function smokeErrorMessage(error) {
  if (!(error instanceof Error) || typeof error.message !== "string" || error.message.length < 1 || error.message.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(error.message)) {
    return "release artifact smoke failed with an internal error.";
  }
  return error.message;
}

function isMain() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
