#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertReviewedCryptoDependencies } from "../src/cli/crypto-dependencies.ts";

if (isMain()) {
  try {
    assertReviewedCryptoDependencies();
  } catch {
    console.error("Reviewed cryptographic dependency metadata is not installed.");
    process.exitCode = 1;
  }
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
