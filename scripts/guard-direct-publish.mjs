#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("Direct workspace publishing is disabled.");
    console.error(`- ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function main(args) {
  assertNoArgs(args);
  throw new Error("Use the tag-only GitHub release workflow; it verifies and publishes the checked tarball with trusted npm provenance.");
}

function assertNoArgs(args) {
  if (args.length !== 0) throw new Error("Usage: node scripts/guard-direct-publish.mjs");
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown direct publish guard failure.";
}
