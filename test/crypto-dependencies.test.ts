import test from "node:test";
import assert from "node:assert/strict";
import { assertReviewedCryptoDependencies } from "../src/cli/crypto-dependencies.js";

test("CLI runtime crypto dependency attestation accepts the reviewed install graph", () => {
  assert.doesNotThrow(() => assertReviewedCryptoDependencies());
});
