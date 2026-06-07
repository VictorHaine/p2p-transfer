import test from "node:test";
import assert from "node:assert/strict";

import { redactLocalPathEvidence } from "../src/cli/error-redaction.js";

test("CLI local path evidence redacts quoted and unquoted absolute paths", () => {
  const message = [
    "open '/Users/alice/private file.txt' failed",
    "stat \"/var/tmp/private-name.bin\" failed",
    "outside /opt/releases/secret.tgz failed",
    "windows C:\\Users\\Alice\\secret.txt failed",
    "file url file:///Users/alice/private.txt failed",
    "unc \\\\server\\share\\private.txt failed",
    "extended \\\\?\\C:\\Users\\Alice\\private.txt failed",
    "cwd /workspace/project/nested/file.txt failed"
  ].join("\n");

  const redacted = redactLocalPathEvidence(message, "/workspace/project");

  assert.equal(redacted.includes("/Users/alice"), false);
  assert.equal(redacted.includes("/var/tmp"), false);
  assert.equal(redacted.includes("/opt/releases"), false);
  assert.equal(redacted.includes("C:\\Users"), false);
  assert.equal(redacted.includes("file:///Users"), false);
  assert.equal(redacted.includes("\\\\server\\share"), false);
  assert.equal(redacted.includes("\\\\?\\C:"), false);
  assert.equal(redacted.includes("/workspace/project"), false);
  assert.match(redacted, /open '\[path\]' failed/);
  assert.match(redacted, /stat "\[path\]" failed/);
  assert.match(redacted, /outside \[path\] failed/);
  assert.match(redacted, /windows \[path\] failed/);
  assert.match(redacted, /file url \[path\] failed/);
  assert.match(redacted, /unc \[path\] failed/);
  assert.match(redacted, /extended \[path\] failed/);
  assert.match(redacted, /cwd \[cwd\]\/nested\/file\.txt failed/);
});

test("CLI local path redaction does not redact websocket or HTTPS URLs", () => {
  const message = "connect ws://127.0.0.1:8787/v1/ws and https://files.example.com/assets/index.js failed";

  assert.equal(redactLocalPathEvidence(message, "/workspace/project"), message);
});
