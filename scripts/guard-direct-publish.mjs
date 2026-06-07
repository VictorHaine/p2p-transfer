#!/usr/bin/env node

console.error("Direct workspace publishing is disabled.");
console.error("Use the tag-only GitHub release workflow; it verifies and publishes the checked tarball with trusted npm provenance.");
process.exitCode = 1;
