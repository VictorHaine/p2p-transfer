import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/shared/package-info.js";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

test("runtime package metadata is sourced from package.json", () => {
  assert.equal(PACKAGE_NAME, packageJson.name);
  assert.equal(PACKAGE_VERSION, packageJson.version);
});
