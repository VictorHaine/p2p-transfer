import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendBoundedOutput, assertTemporaryDiskSpace, checkedChildStdin, endCheckedChildStdin, expectedPackedTarballName, isolatedChildEnv, optionalEnvString, optionalProvidedTarball, parseJsonEvidence, readBoundedResponseText, renderCommandForLog, safeChildEnv, stageVerifiedTarball } from "../scripts/smoke-packed.mjs";

const packedSmokeSource = await readFile(new URL("../scripts/smoke-packed.mjs", import.meta.url), "utf8");

test("packed smoke response reader rejects invalid UTF-8 with deterministic error", async () => {
  const response = new Response(new Uint8Array([0xff]));

  await assert.rejects(
    readBoundedResponseText(response, 8192),
    /Packed smoke response is not valid UTF-8\./
  );
});

test("packed smoke response reader returns bounded valid UTF-8 text", async () => {
  const response = new Response("ff transfer");

  assert.equal(await readBoundedResponseText(response, 8192), "ff transfer");
});

test("packed smoke JSON evidence parser owns parse failures", () => {
  assert.deepEqual(parseJsonEvidence("{\"ok\":true}", "packed ff-server health response"), { ok: true });
  assert.throws(
    () => parseJsonEvidence("{bad json from package}", "packed ff-server health response"),
    (error) => {
      const message = String((error as Error).message);
      assert.equal(message, "packed ff-server health response is not valid JSON.");
      assert.equal(/bad json|package/.test(message), false);
      return true;
    }
  );
});

test("packed smoke JSON evidence parser rejects hostile labels before reporting", () => {
  assert.throws(
    () => parseJsonEvidence("{}", "health\u001b[31m" as never),
    /Packed smoke JSON evidence is invalid\./
  );
});

test("packed smoke derives the exact expected npm tarball name", () => {
  assert.equal(expectedPackedTarballName("@victorhaine/p2p-transfer", "1.2.3"), "victorhaine-p2p-transfer-1.2.3.tgz");
  assert.equal(expectedPackedTarballName("plain-package", "1.2.3"), "plain-package-1.2.3.tgz");
});

test("packed smoke rejects invalid package metadata before tarball naming", () => {
  assert.throws(
    () => expectedPackedTarballName("../bad", "1.2.3"),
    /package\.json name must be an exact npm package name\./
  );
  assert.throws(
    () => expectedPackedTarballName("@scope/pkg", "1.2.3-beta"),
    /package\.json version must be an exact semver release\./
  );
});

test("packed smoke top-level failures do not print stacks or raw package evidence", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-smoke-top-"));
  try {
    const scriptsDir = path.join(tmp, "scripts");
    await mkdir(scriptsDir);
    await writeFile(path.join(scriptsDir, "smoke-packed.mjs"), packedSmokeSource, { mode: 0o755 });
    await writeFile(path.join(tmp, "package.json"), "{bad package json from workspace}\n");

    const result = spawnSync(process.execPath, [path.join(scriptsDir, "smoke-packed.mjs")], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 10_000
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Packed smoke failed:/);
    assert.match(result.stderr, /package\.json is not valid JSON\./);
    assert.doesNotMatch(result.stderr, /bad package|workspace|smoke-packed\.mjs\s*:|SyntaxError/);
    assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(tmp)));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("packed smoke child output strips terminal controls before logging", () => {
  const captured = appendBoundedOutput("prefix:", Buffer.from("ok\u001b[31mred\u202eevil\r\nnext\tok", "utf8"));

  assert.equal(captured, "prefix:ok[31mredevil\nnext\tok");
  assert.equal(/\u001b|\u202e|\r/.test(captured), false);
});

test("packed smoke child output redacts path-shaped evidence before logging", () => {
  const captured = appendBoundedOutput("", Buffer.from("failed at /Users/alice/private/file.txt and C:\\Users\\alice\\secret.txt", "utf8"));

  assert.equal(captured, "failed at [path] and [path]");
  assert.doesNotMatch(captured, /Users|alice|private|secret/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

test("packed smoke command labels strip terminal controls before logging", () => {
  const label = renderCommandForLog("pnpm\u001b", ["add", "verified-\u202etarball.tgz", "line\rbreak"]);

  assert.equal(label, "pnpm add verified-tarball.tgz linebreak");
  assert.equal(/\u001b|\u202e|\r/.test(label), false);
});

test("packed smoke command labels redact path-shaped arguments before logging", () => {
  const label = renderCommandForLog("pnpm", ["add", "/private/tmp/package.tgz", "C:\\Users\\alice\\package.tgz", "safe"]);

  assert.equal(label, "pnpm add [path] [path] safe");
  assert.doesNotMatch(label, /private|Users|alice|package\.tgz/);
});

test("packed smoke output helpers reject hostile coercion inputs", () => {
  let toStringCalled = false;
  const hostile = {
    toString() {
      toStringCalled = true;
      return "evil";
    }
  };

  assert.throws(() => appendBoundedOutput(hostile as never, Buffer.from("ok")), /captured output buffer is invalid/);
  assert.throws(() => appendBoundedOutput("", hostile as never), /child output chunk is invalid/);
  assert.equal(toStringCalled, false);
});

test("packed smoke command labels reject non-string and accessor-backed parts", () => {
  let getterCalled = false;
  const accessorArgs: string[] = [];
  Object.defineProperty(accessorArgs, "0", {
    get() {
      getterCalled = true;
      return "add";
    }
  });
  accessorArgs.length = 1;

  assert.throws(() => renderCommandForLog({ toString: () => "pnpm" } as never, ["add"]), /command label is invalid/);
  assert.throws(() => renderCommandForLog("pnpm", [1] as never), /command label is invalid/);
  assert.throws(() => renderCommandForLog("pnpm", accessorArgs), /command label is invalid/);
  assert.equal(getterCalled, false);
});

test("packed smoke child stdin is bounded and control-free", () => {
  assert.equal(checkedChildStdin("12345678-apple-anchor\nfile.txt\n"), "12345678-apple-anchor\nfile.txt\n");
  assert.throws(() => checkedChildStdin("" as never), /child stdin/);
  assert.throws(() => checkedChildStdin("12345678-apple-anchor\u001b\nfile.txt\n"), /child stdin/);
  assert.throws(() => checkedChildStdin("x".repeat(8_193)), /child stdin/);
  assert.throws(() => checkedChildStdin({ toString: () => "12345678-apple-anchor\n" } as never), /child stdin/);
});

test("packed smoke child stdin helper reports pipe errors without echoing private input", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let written = "";
  const child = {
    stdin: {
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
        return this;
      },
      off(event: string) {
        listeners.delete(event);
        return this;
      },
      end(value: string) {
        written = value;
      }
    }
  };
  let failure: Error | undefined;

  endCheckedChildStdin(child, "12345678-apple-anchor\n/private/file.txt\n", "packed ff send", (error: Error) => {
    failure = error;
  });
  listeners.get("error")?.(new Error("EPIPE /private/file.txt"));

  assert.equal(written, "12345678-apple-anchor\n/private/file.txt\n");
  assert.equal(failure?.message, "packed ff send stdin pipe failed.");
  assert.doesNotMatch(failure?.message ?? "", /apple-anchor|private|file\.txt|EPIPE/);
});

test("packed smoke child environment drops unsafe optional inherited values", () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  try {
    process.env.PATH = "safe-path";
    process.env.HOME = `${"a".repeat(8192)}b`;

    const env = safeChildEnv();

    assert.equal(env.PATH, "safe-path");
    assert.equal("HOME" in env, false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("packed smoke exercises private receive output input", () => {
  assert.match(packedSmokeSource, /process\.platform === "win32"[\s\S]*"--redact-output", "--require-private-input", "recv", "--opaque-output-names", "--code-stdin", "--yes", "--out-env", "FF_RECEIVE_OUT"/);
  assert.match(packedSmokeSource, /: \["exec", "ff", "--server-env", "FF_SIGNALING_SERVER", "--json", "--local-private-mode", "recv", "--code-stdin", "--yes", "--out-env", "FF_RECEIVE_OUT"\]/);
  assert.match(packedSmokeSource, /env: \{ \.\.\.childEnv, FF_RECEIVE_OUT: out, FF_SIGNALING_SERVER: serverUrl \}/);
  assert.doesNotMatch(packedSmokeSource, /"--local-private-mode", "recv", "--code-stdin", "--yes", "--out", out/);
});

test("packed smoke exercises npm global bin installation", () => {
  assert.match(packedSmokeSource, /const npm = process\.platform === "win32" \? "npm\.cmd" : "npm"/);
  assert.match(packedSmokeSource, /await smokeNpmGlobalInstall\(installTarball, childEnv, tmp, expectedVersion\)/);
  assert.match(packedSmokeSource, /await run\(npm, \["install", "--global", "--ignore-scripts=false", tarball\]/);
  assert.match(packedSmokeSource, /npmGlobalBin\(childEnv\.NPM_CONFIG_PREFIX, "ff"\)/);
  assert.match(packedSmokeSource, /npmGlobalBin\(childEnv\.NPM_CONFIG_PREFIX, "ff-server"\)/);
  assert.match(packedSmokeSource, /!info\.isFile\(\) && !info\.isSymbolicLink\(\)/);
  assert.match(packedSmokeSource, /const target = await stat\(file\)/);
  assert.match(packedSmokeSource, /npm global ff --version did not report exactly/);
});

test("packed smoke child environment rejects unsafe required inherited values", () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${"a".repeat(8192)}b`;

    assert.throws(
      () => safeChildEnv(),
      /PATH must be a non-empty control-free child environment value under 8192 UTF-8 bytes\./
    );

    process.env.PATH = "safe\u001b[31m";
    assert.throws(
      () => safeChildEnv(),
      /PATH must be a non-empty control-free child environment value under 8192 UTF-8 bytes\./
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("packed smoke optional environment inputs are descriptor-read and byte-capped", () => {
  const original = process.env.KEEP_PACKED_SMOKE_TMP;
  try {
    process.env.KEEP_PACKED_SMOKE_TMP = "true";
    assert.equal(optionalEnvString("KEEP_PACKED_SMOKE_TMP"), "true");

    process.env.KEEP_PACKED_SMOKE_TMP = `${"a".repeat(8192)}b`;
    assert.throws(
      () => optionalEnvString("KEEP_PACKED_SMOKE_TMP"),
      /KEEP_PACKED_SMOKE_TMP must be a non-empty control-free environment value under 8192 UTF-8 bytes\./
    );

    process.env.KEEP_PACKED_SMOKE_TMP = "true\u202e";
    assert.throws(
      () => optionalEnvString("KEEP_PACKED_SMOKE_TMP"),
      /KEEP_PACKED_SMOKE_TMP must be a non-empty control-free environment value under 8192 UTF-8 bytes\./
    );
  } finally {
    if (original === undefined) delete process.env.KEEP_PACKED_SMOKE_TMP;
    else process.env.KEEP_PACKED_SMOKE_TMP = original;
  }
});

test("packed smoke temporary disk preflight fails without raw paths", async () => {
  await assert.rejects(
    () => assertTemporaryDiskSpace(Number.MAX_SAFE_INTEGER, "packed smoke temporary space is too low."),
    (error) => {
      const message = String((error as Error).message);
      assert.equal(message, "packed smoke temporary space is too low.");
      assert.doesNotMatch(message, /\/|[A-Za-z]:[\\/]|tmp|var|Users/);
      return true;
    }
  );
});

test("packed smoke child environment isolates host home and package-manager config", async () => {
  const original = new Map<string, string | undefined>();
  const names = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "PNPM_HOME",
    "COREPACK_HOME",
    "LOCALAPPDATA",
    "APPDATA",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
    "NPM_CONFIG_PREFIX",
    "npm_config_prefix",
    "NPM_CONFIG_CACHE",
    "npm_config_cache"
  ];
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-smoke-env-"));
  const privateHome = path.join(tmp, "home");
  try {
    for (const name of names) original.set(name, process.env[name]);
    process.env.PATH = "safe-path";
    process.env.HOME = "/host/home";
    process.env.USERPROFILE = "/host/userprofile";
    process.env.PNPM_HOME = "/host/pnpm";
    process.env.COREPACK_HOME = "/host/corepack";
    process.env.LOCALAPPDATA = "/host/localappdata";
    process.env.APPDATA = "/host/appdata";
    process.env.NPM_CONFIG_USERCONFIG = "/host/.npmrc";
    process.env.npm_config_userconfig = "/host/.npmrc";
    process.env.NPM_CONFIG_PREFIX = "/host/npm-prefix";
    process.env.npm_config_prefix = "/host/npm-prefix";
    process.env.NPM_CONFIG_CACHE = "/host/npm-cache";
    process.env.npm_config_cache = "/host/npm-cache";

    const env = isolatedChildEnv(privateHome);

    assert.equal(env.PATH, "safe-path");
    assert.equal(env.HOME, privateHome);
    assert.equal(env.USERPROFILE, privateHome);
    assert.equal(env.XDG_CONFIG_HOME, path.join(privateHome, "xdg-config"));
    assert.equal(env.NPM_CONFIG_USERCONFIG, path.join(privateHome, ".npmrc"));
    assert.equal(env.npm_config_userconfig, path.join(privateHome, ".npmrc"));
    assert.equal(env.NPM_CONFIG_PREFIX, path.join(privateHome, "npm-prefix"));
    assert.equal(env.npm_config_prefix, path.join(privateHome, "npm-prefix"));
    assert.equal(env.NPM_CONFIG_CACHE, path.join(privateHome, "npm-cache"));
    assert.equal(env.npm_config_cache, path.join(privateHome, "npm-cache"));
    assert.equal(env.PNPM_HOME, path.join(privateHome, "pnpm-home"));
    assert.equal(env.COREPACK_HOME, path.join(privateHome, "corepack-home"));
    assert.equal(env.LOCALAPPDATA, path.join(privateHome, "local-app-data"));
    assert.equal(env.APPDATA, path.join(privateHome, "app-data"));
    for (const value of Object.values(env)) {
      assert.doesNotMatch(value, /\/host\//);
    }
  } finally {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test("packed smoke isolated child environment rejects hostile private home inputs", () => {
  let toStringCalled = false;
  const hostile = {
    toString() {
      toStringCalled = true;
      return "home";
    }
  };

  assert.throws(
    () => isolatedChildEnv(hostile as never),
    /Packed smoke private home must be a non-empty control-free path under 4096 UTF-8 bytes\./
  );
  assert.throws(
    () => isolatedChildEnv(`safe\u001b[31m`),
    /Packed smoke private home must be a non-empty control-free path under 4096 UTF-8 bytes\./
  );
  assert.equal(toStringCalled, false);
});

test("packed smoke provided tarball path is capped by UTF-8 bytes", () => {
  const original = process.env.PACKED_SMOKE_TARBALL;
  try {
    process.env.PACKED_SMOKE_TARBALL = `${"😀".repeat(1024)}.tgz`;

    assert.throws(
      () => optionalProvidedTarball(),
      /PACKED_SMOKE_TARBALL must be a non-empty control-free path under 4096 UTF-8 bytes\./
    );
  } finally {
    if (original === undefined) delete process.env.PACKED_SMOKE_TARBALL;
    else process.env.PACKED_SMOKE_TARBALL = original;
  }
});

test("packed smoke provided tarball path rejects terminal controls", () => {
  const original = process.env.PACKED_SMOKE_TARBALL;
  try {
    process.env.PACKED_SMOKE_TARBALL = `safe\u001b[31m.tgz`;

    assert.throws(
      () => optionalProvidedTarball(),
      /PACKED_SMOKE_TARBALL must be a non-empty control-free path under 4096 UTF-8 bytes\./
    );
  } finally {
    if (original === undefined) delete process.env.PACKED_SMOKE_TARBALL;
    else process.env.PACKED_SMOKE_TARBALL = original;
  }
});

test("packed smoke tarball staging failures do not echo raw paths", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ff-smoke-test-"));
  try {
    const destination = path.join(tmp, "stage");
    await mkdir(destination);
    const unsafeTarball = path.join(tmp, "raw\u001b[31m", "safe.tgz");

    await assert.rejects(
      () => stageVerifiedTarball(unsafeTarball, destination),
      (error) => {
        const message = String((error as Error).message);
        assert.equal(message, "Packed smoke tarball could not be opened for verification.");
        assert.equal(/raw|\u001b|\[31m/.test(message), false);
        return true;
      }
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
