import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyExitCode, safeErrorMessage } from "../src/cli/exit-codes.js";
import { classifyExitCode as distClassifyExitCode, safeErrorMessage as distSafeErrorMessage } from "../dist-node/cli/exit-codes.js";
import { InterruptError } from "../src/cli/interrupt.js";

const securityPolicy = fs.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("classifyExitCode preserves documented operational exit codes", () => {
  assert.equal(classifyExitCode(new Error("Transfer declined.")), 2);
  assert.equal(classifyExitCode(new Error("Timed out waiting for pair decision")), 3);
  assert.equal(classifyExitCode(new Error("WebRTC connection failed before connected.")), 3);
  assert.equal(classifyExitCode(new Error("WebRTC connection closed.")), 3);
  assert.equal(classifyExitCode(new Error("WebRTC connection disconnected.")), 3);
  assert.equal(classifyExitCode(new Error("DataChannel bulk is closed.")), 3);
  assert.equal(classifyExitCode(new Error("DataChannel bulk is closing.")), 3);
  assert.equal(classifyExitCode(new Error("DataChannel bulk closed before opening.")), 3);
  assert.equal(classifyExitCode(new Error("DataChannel bulk failed while draining.")), 3);
  assert.equal(classifyExitCode(new Error("DataChannel bulk backpressure did not drain.")), 3);
  assert.equal(classifyExitCode(new Error("Bulk channel closed before transfer completed.")), 3);
  assert.equal(classifyExitCode(new Error("Control channel errored before transfer completed.")), 3);
  assert.equal(classifyExitCode(new Error("Transfer channel closed before completion.")), 3);
  assert.equal(classifyExitCode(new Error("Transfer channel errored before completion.")), 3);
  assert.equal(classifyExitCode(new InterruptError("SIGINT")), 130);
  assert.equal(classifyExitCode(new Error("Unexpected local failure.")), 1);
  assert.equal(distClassifyExitCode(new Error("DataChannel bulk is closed.")), 3);
  assert.equal(distClassifyExitCode(new Error("Control channel errored before transfer completed.")), 3);
});

test("classifyExitCode treats security and integrity failures as exit code 4", () => {
  assert.match(securityPolicy, /encrypted payload authentication\/decryption failures must surface as security failures/);
  for (const message of [
    "PAKE confirmation failed. Wrong code or active attack.",
    "Authenticated SDP check failed.",
    "Authenticated WebRTC signal check failed. Wrong code or signaling MITM.",
    "Encrypted payload must be a text frame.",
    "Encrypted payload decrypt failed.",
    "Encrypted bulk chunk decrypt failed.",
    "Encrypted payload is not valid JSON.",
    "Session keys have been wiped.",
    "Hash mismatch for photo.jpg.",
    "On-disk hash mismatch for photo.jpg.",
    "Published file hash mismatch for photo.jpg.",
    "File path changed before verification.",
    "Partial file changed before publish.",
    "Transfer manifest does not match the accepted manifest.",
    "Peer integrity check failed."
  ]) {
    assert.equal(classifyExitCode(new Error(message)), 4, message);
  }
});

test("CLI error-message helpers do not invoke hostile coercion or accessors", () => {
  let invoked = false;
  const hostile = {
    get message() {
      invoked = true;
      return "PAKE confirmation failed.";
    },
    toString() {
      invoked = true;
      return "PAKE confirmation failed.";
    }
  };
  class HostileError extends Error {
    override get message(): string {
      invoked = true;
      return "PAKE confirmation failed.";
    }
  }

  assert.equal(safeErrorMessage("Timed out waiting for pair decision"), "Timed out waiting for pair decision");
  assert.equal(safeErrorMessage(hostile), "Unexpected error.");
  assert.equal(safeErrorMessage(new HostileError()), "Unexpected error.");
  assert.equal(classifyExitCode(hostile), 1);
  assert.equal(classifyExitCode(new HostileError()), 1);
  assert.equal(distSafeErrorMessage(hostile), "Unexpected error.");
  assert.equal(distClassifyExitCode(hostile), 1);
  assert.equal(invoked, false);
  assert.match(securityPolicy, /CLI and browser error classification and error rendering must read error messages through data descriptors/);
});
