#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_ERROR_MESSAGE_CHARS = 1024;

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
  const message = errorMessage(error);
  if (
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= MAX_ERROR_MESSAGE_CHARS &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(message) &&
    !containsSensitiveErrorText(message)
  ) {
    return message;
  }
  return "direct publish guard failed.";
}

function errorMessage(error) {
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function containsAbsolutePathText(value) {
  return /(^|[\s("'=])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\/\s]+[\\/])/i.test(value);
}

function containsSensitiveErrorText(value) {
  return containsAbsolutePathText(value) || /(^|[\s("'=])(?:https?:\/\/|wss?:\/\/)/i.test(value) || /[?&][A-Za-z0-9_.-]+=/i.test(value) || /\b(?:github_pat_|gh[opsru]_|token-(?!stdin\b)[A-Za-z0-9._-]{12,})/i.test(value);
}
