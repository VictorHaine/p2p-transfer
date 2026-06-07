import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildManifest, closeSendFiles, ensureOutputDir, isMissingPathError, reserveOutputFile } from "../src/cli/files.js";
import { buildManifest as distBuildManifest, closeSendFiles as distCloseSendFiles, ensureOutputDir as distEnsureOutputDir, reserveOutputFile as distReserveOutputFile } from "../dist-node/cli/files.js";
import { publishPartFile, shouldFallbackToExclusiveCopy } from "../src/cli/transfer.js";
import { publishPartFile as distPublishPartFile } from "../dist-node/cli/transfer.js";
import { MAX_OUTPUT_NAME_ATTEMPTS } from "../src/shared/constants.js";
import { SAFE_FILE_NAME_BYTES, safeFileName } from "../src/shared/limits.js";

const PART_FILE_SUFFIX = ".part";
const RANDOM_PART_SUFFIX = /^ff-[a-f0-9]{32}\.part$/;
const sourceTransfer = fsSync.readFileSync(new URL("../src/cli/transfer.ts", import.meta.url), "utf8");
const distTransfer = fsSync.readFileSync(new URL("../dist-node/cli/transfer.js", import.meta.url), "utf8");
const sourceFiles = fsSync.readFileSync(new URL("../src/cli/files.ts", import.meta.url), "utf8");
const distFiles = fsSync.readFileSync(new URL("../dist-node/cli/files.js", import.meta.url), "utf8");
const securityPolicy = fsSync.readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("publishPartFile atomically refuses to overwrite an existing file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-existing-"));
  const partPath = path.join(dir, "file.txt.part");
  const finalPath = path.join(dir, "file.txt");
  await fs.writeFile(partPath, "new");
  await fs.writeFile(finalPath, "existing");

  await assert.rejects(() => publishPartFile(partPath, finalPath), { code: "EEXIST" });
  assert.equal(await fs.readFile(finalPath, "utf8"), "existing");
  assert.equal(await fs.readFile(partPath, "utf8"), "new");
});

test("CLI cleanup quarantines verified paths before removal", () => {
  assert.match(securityPolicy, /CLI receive, reservation, and publish cleanup must quarantine same-directory verified paths before removal/);
  for (const source of [sourceTransfer, distTransfer, sourceFiles, distFiles]) {
    assert.match(source, /MAX_CLEANUP_QUARANTINE_ATTEMPTS/);
    assert.match(source, /cleanupQuarantinePath/);
    assert.match(source, /rename\(\w+, \w+\)/);
    assert.match(source, /lstat\(\w+\)[\s\S]*if \(!\w+\(\w+\)\)[\s\S]*Cleanup target changed before removal/);
    assert.doesNotMatch(source, /if \(sameFileIdentity\([^)]*\)\) await fs\.promises\.rm\(filePath/);
    assert.doesNotMatch(source, /if \(samePathIdentity\([^)]*\)\) await fs\.promises\.rm\(filePath/);
  }
});

test("publishPartFile publishes a completed part file and removes the part path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-ok-"));
  const partPath = path.join(dir, "file.txt.part");
  const finalPath = path.join(dir, "file.txt");
  await fs.writeFile(partPath, "contents");

  const identity = await publishPartFile(partPath, finalPath);

  assert.equal(await fs.readFile(finalPath, "utf8"), "contents");
  const stat = await fs.stat(finalPath);
  assert.equal(identity.dev, stat.dev);
  assert.equal(identity.ino, stat.ino);
  await assert.rejects(() => fs.stat(partPath), { code: "ENOENT" });
});

test("publishPartFile removes the final output if partial cleanup fails", { skip: process.platform === "win32" ? "POSIX permissions required." : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-cleanup-fail-"));
  const partDir = path.join(root, "part");
  const finalDir = path.join(root, "final");
  await fs.mkdir(partDir);
  await fs.mkdir(finalDir);
  const partPath = path.join(partDir, "file.txt.part");
  const finalPath = path.join(finalDir, "file.txt");
  await fs.writeFile(partPath, "contents");
  await fs.chmod(partDir, 0o555);

  try {
    await assert.rejects(() => publishPartFile(partPath, finalPath), /EACCES|EPERM/);
    await assert.rejects(() => fs.stat(finalPath), { code: "ENOENT" });
    assert.equal(await fs.readFile(partPath, "utf8"), "contents");
  } finally {
    await fs.chmod(partDir, 0o755);
  }
});

test("exclusive-copy fallback is limited to hard-link portability failures", () => {
  for (const code of ["EACCES", "EINVAL", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]) {
    assert.equal(shouldFallbackToExclusiveCopy({ code }), true);
  }

  for (const code of ["EEXIST", "ENOENT", "ENOTDIR", "ENOSPC", "EROFS"]) {
    assert.equal(shouldFallbackToExclusiveCopy({ code }), false);
  }

  let getterCalled = false;
  const accessorError = {};
  Object.defineProperty(accessorError, "code", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "EXDEV";
    }
  });
  assert.equal(shouldFallbackToExclusiveCopy(accessorError), false);
  assert.equal(getterCalled, false);

  let coerced = false;
  assert.equal(
    shouldFallbackToExclusiveCopy({
      code: {
        toString() {
          coerced = true;
          return "EXDEV";
        }
      }
    }),
    false
  );
  assert.equal(coerced, false);
});

test("publishPartFile rejects malformed runtime inputs before filesystem calls or coercion", async () => {
  assert.match(securityPolicy, /exported CLI publish helpers must reject malformed publish paths, expected partial identities, and expected sizes/);
  let coerced = false;
  const hostilePath = {
    get length() {
      coerced = true;
      return 1;
    },
    toString() {
      coerced = true;
      return "file.txt";
    }
  };
  let identityGetterRead = false;
  const hostileIdentity = {};
  Object.defineProperty(hostileIdentity, "dev", {
    enumerable: true,
    get() {
      identityGetterRead = true;
      return 1;
    }
  });
  const hostileSize = {
    valueOf() {
      coerced = true;
      return 1;
    }
  };

  for (const publish of [publishPartFile, distPublishPartFile]) {
    await assert.rejects(() => publish(hostilePath as never, "final.txt"), /Partial path is invalid/);
    await assert.rejects(() => publish("part.txt", hostilePath as never), /Final path is invalid/);
    await assert.rejects(() => publish("", "final.txt"), /Partial path is required/);
    await assert.rejects(() => publish("part.txt", " \t "), /Final path is required/);
    await assert.rejects(() => publish("a".repeat(4097), "final.txt"), /Partial path is too long/);
    await assert.rejects(() => publish("part.txt", `safe\u202efinal.txt`), /Final path must not contain control or format/);
    await assert.rejects(() => publish("part.txt", "final.txt", hostileIdentity as never), /Expected partial identity is invalid/);
    await assert.rejects(() => publish("part.txt", "final.txt", undefined, hostileSize as never), /Expected publish size is invalid/);
  }
  assert.equal(coerced, false);
  assert.equal(identityGetterRead, false);

  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /function publishPathInput/);
    assert.match(source, /function fileIdentityInput/);
    assert.match(source, /function publishExpectedSizeInput/);
    assert.match(source, /const safePartPath = publishPathInput\(partPath, "Partial"\)/);
    assert.match(source, /const safeFinalPath = publishPathInput\(finalPath, "Final"\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(value, key\)/);
    assert.match(source, /MAX_PUBLISH_PATH_BYTES = 4096/);
    assert.match(source, /UNSAFE_PUBLISH_PATH_CHARS/);
  }
});

test("CLI filesystem path validators reject overlong UTF-8 without encoded-copy allocation", async () => {
  assert.match(securityPolicy, /CLI filesystem path validators must reject overlong UTF-8 paths with early-exit byte counting/);
  const oversized = "😀".repeat(1025);

  for (const build of [buildManifest, distBuildManifest]) {
    await assert.rejects(() => build([oversized]), /File path is too long/);
  }
  for (const ensure of [ensureOutputDir, distEnsureOutputDir]) {
    await assert.rejects(() => ensure(oversized), /Output directory path is too long/);
  }
  for (const publish of [publishPartFile, distPublishPartFile]) {
    await assert.rejects(() => publish(oversized, "final.txt"), /Partial path is too long/);
    await assert.rejects(() => publish("part.txt", oversized), /Final path is too long/);
  }

  for (const source of [sourceFiles, distFiles, sourceTransfer, distTransfer]) {
    assert.match(source, /function utf8ByteLengthExceeds/);
    assert.match(source, /charCodeAt\(index\)/);
  }
  for (const source of [sourceFiles, distFiles]) {
    assert.doesNotMatch(source, /new TextEncoder\(\)/);
    assert.doesNotMatch(source, /text\.encode\(input\)\.byteLength/);
    assert.doesNotMatch(source, /text\.encode\(dir\)\.byteLength/);
  }
  for (const source of [sourceTransfer, distTransfer]) {
    assert.doesNotMatch(source, /new TextEncoder\(\)/);
    assert.doesNotMatch(source, /text\.encode\(value\)\.byteLength/);
  }
});

test("publishPartFile fallback copies from a verified partial file handle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-copy-fallback-"));
  const partPath = path.join(dir, "file.txt.part");
  const finalPath = path.join(dir, "file.txt");
  await fs.writeFile(partPath, "contents");
  const originalLink = fsSync.promises.link;
  try {
    fsSync.promises.link = async () => {
      const error = new Error("cross-device link") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    };

    await publishPartFile(partPath, finalPath);
  } finally {
    fsSync.promises.link = originalLink;
  }

  assert.equal(await fs.readFile(finalPath, "utf8"), "contents");
  await assert.rejects(() => fs.stat(partPath), { code: "ENOENT" });
});

test("publishPartFile fallback refuses a final path swapped after copy", async () => {
  for (const publish of [publishPartFile, distPublishPartFile]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-copy-final-swap-"));
    const partPath = path.join(dir, "file.txt.part");
    const finalPath = path.join(dir, "file.txt");
    await fs.writeFile(partPath, "trusted");
    const originalLink = fsSync.promises.link;
    const originalOpen = fsSync.promises.open;
    let wrappedTarget = false;
    try {
      fsSync.promises.link = async () => {
        const error = new Error("cross-device link") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      };
      fsSync.promises.open = (async (targetPath: fsSync.PathLike, flags?: string | number, mode?: fsSync.Mode) => {
        const handle = await originalOpen.call(fsSync.promises, targetPath, flags as never, mode as never);
        if (!wrappedTarget && String(targetPath) === finalPath && flags === "wx") {
          wrappedTarget = true;
          const originalClose = handle.close.bind(handle);
          let swapped = false;
          Object.defineProperty(handle, "close", {
            value: async () => {
              const result = await originalClose();
              if (!swapped) {
                swapped = true;
                await fs.rm(finalPath, { force: true });
                await fs.writeFile(finalPath, "attacker");
              }
              return result;
            }
          });
        }
        return handle;
      }) as typeof fsSync.promises.open;

      await assert.rejects(() => publish(partPath, finalPath, undefined, "trusted".length), /Published path changed before verification/);
    } finally {
      fsSync.promises.link = originalLink;
      fsSync.promises.open = originalOpen;
    }

    assert.equal(wrappedTarget, true);
    assert.equal(await fs.readFile(finalPath, "utf8"), "attacker");
    assert.equal(await fs.readFile(partPath, "utf8"), "trusted");
  }
});

test("publishPartFile refuses partial files whose size changed after verification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-size-change-"));
  const reserved = await reserveOutputFile(dir, "file.txt");
  await reserved.handle.writeFile("trusted");
  await reserved.handle.close();
  await fs.appendFile(reserved.partPath, "extra");

  await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved, "trusted".length), /Partial file changed/);
  await assert.rejects(() => fs.stat(reserved.finalPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(reserved.partPath, "utf8"), "trustedextra");
});

test(
  "publishPartFile fallback refuses a partial path swapped after hard-link failure",
  { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-copy-swap-"));
    const reserved = await reserveOutputFile(dir, "file.txt");
    const attacker = path.join(dir, "attacker.txt");
    await reserved.handle.writeFile("trusted");
    await reserved.handle.close();
    await fs.writeFile(attacker, "attacker");
    const originalLink = fsSync.promises.link;
    try {
      fsSync.promises.link = async () => {
        await fs.rm(reserved.partPath);
        await fs.symlink(attacker, reserved.partPath);
        const error = new Error("cross-device link") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      };

      await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved), /Partial file changed/);
    } finally {
      fsSync.promises.link = originalLink;
    }

    await assert.rejects(() => fs.lstat(reserved.finalPath), { code: "ENOENT" });
    assert.equal((await fs.lstat(reserved.partPath)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(attacker, "utf8"), "attacker");
  }
);

test(
  "publishPartFile fallback refuses a same-identity partial symlink after hard-link failure",
  { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-copy-symlink-"));
    const reserved = await reserveOutputFile(dir, "file.txt");
    const movedPart = path.join(dir, "moved.part");
    await reserved.handle.writeFile("trusted");
    await reserved.handle.close();
    const originalLink = fsSync.promises.link;
    try {
      fsSync.promises.link = async () => {
        await fs.rename(reserved.partPath, movedPart);
        await fs.symlink(movedPart, reserved.partPath);
        const error = new Error("cross-device link") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      };

      await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved), /Partial file changed/);
    } finally {
      fsSync.promises.link = originalLink;
    }

    await assert.rejects(() => fs.lstat(reserved.finalPath), { code: "ENOENT" });
    assert.equal((await fs.lstat(reserved.partPath)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(movedPart, "utf8"), "trusted");
  }
);

test(
  "publishPartFile removes a mismatched final path created by the hard-link step",
  { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-link-swap-"));
    const reserved = await reserveOutputFile(dir, "file.txt");
    const attacker = path.join(dir, "attacker.txt");
    await reserved.handle.writeFile("trusted");
    await reserved.handle.close();
    await fs.writeFile(attacker, "attacker");
    const originalLink = fsSync.promises.link;
    try {
      fsSync.promises.link = async (_partPath, finalPath) => {
        await fs.symlink(attacker, finalPath);
      };

      await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved), /Partial file changed/);
    } finally {
      fsSync.promises.link = originalLink;
    }

    await assert.rejects(() => fs.lstat(reserved.finalPath), { code: "ENOENT" });
    assert.equal(await fs.readFile(reserved.partPath, "utf8"), "trusted");
    assert.equal(await fs.readFile(attacker, "utf8"), "attacker");
  }
);

test("publishPartFile fallback does not use pathname-following copyFile", () => {
  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(securityPolicy, /publish copy fallbacks must carry forward the identity of the final file handle/);
    assert.match(source, /function linkPartFileExclusive/);
    assert.match(source, /function copyPartFileExclusive/);
    assert.match(source, /finalIdentity = await copyPartFileExclusive\(safePartPath, safeFinalPath, partIdentity, safeExpectedSize\)/);
    assert.match(source, /await assertPublishedFileIdentity\(safeFinalPath, finalIdentity, safeExpectedSize\)/);
    assert.match(source, /return targetIdentity/);
    assert.match(source, /function openPartFileNoFollow/);
    assert.match(source, /function copyOpenFile/);
    assert.match(source, /NOFOLLOW_READ_FLAGS/);
    assert.match(source, /fs\.constants\.O_NOFOLLOW/);
    assert.match(source, /linkPartFileExclusive\(safePartPath, safeFinalPath, partIdentity, safeExpectedSize\)/);
    assert.doesNotMatch(source, /fs\.promises\.link\(partPath, finalPath\);\n\s*\} catch/);
    assert.match(source, /openPartFileNoFollow\(partPath\)/);
    assert.match(source, /fs\.promises\.open\(partPath, NOFOLLOW_READ_FLAGS\)/);
    assert.match(source, /nodeErrorCode\(error\) === "ELOOP"/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(error, "code"\)/);
    assert.match(source, /expectedSize !== undefined && sourceStat\.size !== expectedSize/);
    assert.match(source, /copyOpenFile\(source, target, expectedSize\)/);
    assert.match(source, /source\.read\(scratch/);
    assert.match(source, /position !== expectedSize/);
    assert.match(source, /source\.read\(scratch, 0, 1, expectedSize\)/);
    assert.match(source, /writeAll\(target, scratch, bytesRead\)/);
    assert.match(source, /const scratch = Buffer\.alloc\(64 \* 1024\)/);
    assert.doesNotMatch(source, /Buffer\.allocUnsafe/);
    assert.doesNotMatch(source, /finalIdentity = await fileIdentity\(safeFinalPath\)/);
    assert.match(source, /function writeAll/);
    assert.match(source, /while \(written < length\)/);
    assert.match(source, /result\.bytesWritten <= 0/);
    assert.doesNotMatch(source, /copyFile\(partPath, finalPath/);
  }
});

test("reserveOutputFile uses collision-resistant partial names instead of predictable final.part names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-stale-"));
  await fs.writeFile(path.join(dir, "file.txt.part"), "stale");

  const reserved = await reserveOutputFile(dir, "file.txt");
  try {
    assert.equal(path.basename(reserved.finalPath), "file.txt");
    assert.match(path.basename(reserved.partPath), /^ff-[a-f0-9]{32}\.part$/);
    assert.equal(path.basename(reserved.partPath).includes("file.txt"), false);
    assert.notEqual(path.basename(reserved.partPath), "file.txt.part");
  } finally {
    await reserved.handle.close();
  }
});

test("reserveOutputFile can publish received files under opaque final names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-opaque-"));
  const reserved = await reserveOutputFile(dir, "private-name.txt", { opaqueName: true });
  try {
    const finalName = path.basename(reserved.finalPath);
    assert.match(finalName, /^ff-[a-f0-9]{32}$/);
    assert.equal(finalName.includes("private-name"), false);
    assert.equal(path.basename(reserved.partPath).includes("private-name"), false);
  } finally {
    await reserved.handle.close();
  }
});

test("reserveOutputFile uses stable opaque final names for CLI resume", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-opaque-resume-"));
  const first = await reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length, opaqueName: true });
  try {
    const finalName = path.basename(first.finalPath);
    assert.match(finalName, /^ff-[a-f0-9]{32}$/);
    assert.equal(finalName.includes("private-name"), false);
    await first.handle.writeFile(Buffer.from("partial"));
  } finally {
    await first.handle.close();
  }

  const second = await reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length, opaqueName: true });
  try {
    assert.equal(second.finalPath, first.finalPath);
    assert.equal(second.partPath, first.partPath);
    assert.equal(second.resumeBytes, "partial".length);
  } finally {
    await second.handle.close();
  }
});

test("reserveOutputFile uses opaque deterministic CLI resume partial names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-resume-"));
  const first = await reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length });
  try {
    const partName = path.basename(first.partPath);
    assert.match(partName, /^ff-resume-[a-f0-9]{64}\.part$/);
    assert.equal(partName.includes("private-name"), false);
    await first.handle.writeFile(Buffer.from("partial"));
  } finally {
    await first.handle.close();
  }

  const second = await reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length });
  try {
    assert.equal(second.partPath, first.partPath);
    assert.equal(second.resumeBytes, "partial".length);
  } finally {
    await second.handle.close();
  }
});

test("reserveOutputFile rejects output directory replacement during partial creation", { skip: process.platform === "win32" ? "directory replacement behavior differs on Windows." : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-dir-swap-"));
  const dir = path.join(root, "out");
  const moved = path.join(root, "moved");
  await fs.mkdir(dir);
  const originalOpen = fsSync.promises.open;
  const mutablePromises = fsSync.promises as typeof fsSync.promises & { open: typeof fsSync.promises.open };
  let swapped = false;
  try {
    mutablePromises.open = async (target, flags, mode) => {
      if (!swapped && typeof target === "string" && target.startsWith(dir + path.sep) && flags === "wx") {
        swapped = true;
        await fs.rename(dir, moved);
        await fs.mkdir(dir);
      }
      return originalOpen.call(fsSync.promises, target, flags, mode);
    };

    await assert.rejects(() => reserveOutputFile(dir, "file.txt"), /Output directory changed during reservation/);
  } finally {
    mutablePromises.open = originalOpen;
  }

  assert.equal(swapped, true);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("reserveOutputFile cleanup does not delete a replaced partial pathname", { skip: process.platform === "win32" ? "directory replacement behavior differs on Windows." : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-cleanup-race-"));
  const dir = path.join(root, "out");
  const moved = path.join(root, "moved");
  await fs.mkdir(dir);
  const originalOpen = fsSync.promises.open;
  const originalLstat = fsSync.promises.lstat;
  const mutablePromises = fsSync.promises as typeof fsSync.promises & { open: typeof fsSync.promises.open; lstat: typeof fsSync.promises.lstat };
  let swapped = false;
  let raced = false;
  try {
    mutablePromises.open = async (target, flags, mode) => {
      if (!swapped && typeof target === "string" && target.startsWith(dir + path.sep) && flags === "wx") {
        swapped = true;
        await fs.rename(dir, moved);
        await fs.mkdir(dir);
      }
      return originalOpen.call(fsSync.promises, target, flags, mode);
    };
    mutablePromises.lstat = (async (target: fsSync.PathLike) => {
      if (!raced && swapped && typeof target === "string" && target.startsWith(dir + path.sep) && target.endsWith(PART_FILE_SUFFIX)) {
        const stat = await originalLstat.call(fsSync.promises, target);
        await fs.rm(target);
        await fs.writeFile(target, "replacement");
        raced = true;
        return stat;
      }
      return originalLstat.call(fsSync.promises, target);
    }) as typeof fsSync.promises.lstat;

    await assert.rejects(() => reserveOutputFile(dir, "file.txt"), /Output directory changed during reservation/);
  } finally {
    mutablePromises.open = originalOpen;
    mutablePromises.lstat = originalLstat;
  }

  assert.equal(swapped, true);
  assert.equal(raced, true);
  const entries = await fs.readdir(dir);
  const quarantined = entries.filter((entry) => entry.startsWith(".ff-delete-") && entry.endsWith(".tmp"));
  assert.equal(quarantined.length, 1);
  assert.equal(await fs.readFile(path.join(dir, quarantined[0]!), "utf8"), "replacement");
});

test("publishPartFile rejects output directory replacement before final publish", { skip: process.platform === "win32" ? "directory replacement behavior differs on Windows." : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-dir-swap-"));
  const dir = path.join(root, "out");
  const moved = path.join(root, "moved");
  await fs.mkdir(dir);
  const reserved = await reserveOutputFile(dir, "file.txt");
  try {
    await reserved.handle.writeFile(Buffer.from("trusted"));
  } finally {
    await reserved.handle.close();
  }

  await fs.rename(dir, moved);
  await fs.mkdir(dir);

  await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved, "trusted".length, { dev: reserved.dirDev, ino: reserved.dirIno }), /Output directory changed before publish/);
  await assert.rejects(() => fs.stat(path.join(dir, "file.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(moved, path.basename(reserved.partPath)), "utf8"), "trusted");
});

test("reserveOutputFile rejects hardlinked CLI resume partial files", { skip: process.platform === "win32" ? "hardlink behavior differs on Windows." : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-resume-hardlink-"));
  const first = await reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length });
  try {
    await first.handle.writeFile(Buffer.from("partial"));
  } finally {
    await first.handle.close();
  }

  const linkedPath = path.join(dir, "linked-target");
  await fs.link(first.partPath, linkedPath);

  await assert.rejects(() => reserveOutputFile(dir, "private-name.txt", { resume: true, size: "partial".length }), /Resume partial has multiple hard links/);
  assert.equal(await fs.readFile(linkedPath, "utf8"), "partial");
});

test("CLI resume partial hardlink policy is documented and enforced", () => {
  assert.match(securityPolicy, /resumable partial files must reject multiple hard links before hashing, truncation, or restart truncation/);
  assert.match(securityPolicy, /resume secret file must reject multiple hard links before keying resumable names/);
  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /function assertSingleLink\(stat/);
    assert.match(source, /Resume partial"\)/);
    assert.match(source, /Resume secret"\)/);
    assert.match(source, /multiple hard links/);
  }
  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /assertSingleLink\(stat, "Resume partial"\)/);
  }
});

test("reserveOutputFile keeps the CLI resume secret private and fixed size", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-secret-"));
  const reserved = await reserveOutputFile(dir, "secret-name.txt", { resume: true, size: 1 });
  try {
    const secretPath = path.join(dir, ".ff-resume-key");
    const stat = await fs.stat(secretPath);
    assert.equal(stat.size, 32);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(path.basename(reserved.partPath).includes("secret-name"), false);
  } finally {
    await reserved.handle.close();
  }
});

test("reserveOutputFile rejects invalid or symlinked CLI resume secrets", { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false }, async () => {
  const invalidDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-invalid-secret-"));
  await fs.writeFile(path.join(invalidDir, ".ff-resume-key"), "short", { mode: 0o600 });
  await assert.rejects(() => reserveOutputFile(invalidDir, "file.txt", { resume: true, size: 1 }), /Resume secret is invalid/);

  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-public-secret-"));
  await fs.writeFile(path.join(publicDir, ".ff-resume-key"), Buffer.alloc(32, 1), { mode: 0o644 });
  await assert.rejects(() => reserveOutputFile(publicDir, "file.txt", { resume: true, size: 1 }), /Resume secret is not private/);

  const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-symlink-secret-"));
  await fs.writeFile(path.join(symlinkDir, "target"), Buffer.alloc(32, 1), { mode: 0o600 });
  await fs.symlink(path.join(symlinkDir, "target"), path.join(symlinkDir, ".ff-resume-key"));
  await assert.rejects(() => reserveOutputFile(symlinkDir, "file.txt", { resume: true, size: 1 }));
});

test("reserveOutputFile rejects hardlinked CLI resume secrets", { skip: process.platform === "win32" ? "hardlink behavior differs on Windows." : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-hardlinked-secret-"));
  const secretPath = path.join(dir, ".ff-resume-key");
  const linkedPath = path.join(dir, "linked-resume-key");
  await fs.writeFile(secretPath, Buffer.alloc(32, 1), { mode: 0o600 });
  await fs.link(secretPath, linkedPath);

  await assert.rejects(() => reserveOutputFile(dir, "file.txt", { resume: true, size: 1 }), /Resume secret has multiple hard links/);
});

test("reserveOutputFile treats dangling final-path symlinks as occupied", { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-dangling-link-"));
  await fs.symlink(path.join(dir, "missing-target"), path.join(dir, "file.txt"));

  const reserved = await reserveOutputFile(dir, "file.txt");
  try {
    assert.equal(path.basename(reserved.finalPath), "file (1).txt");
    assert.match(path.basename(reserved.partPath), /^ff-[a-f0-9]{32}\.part$/);
    assert.equal(path.basename(reserved.partPath).includes("file"), false);
  } finally {
    await reserved.handle.close();
  }
});

test("reserveOutputFile uses directory-entry checks instead of following final-path symlinks", () => {
  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /fs\.promises\.lstat\(finalPath\)/);
    assert.doesNotMatch(source, /fs\.promises\.access\(finalPath\)/);
  }
});

test("ensureOutputDir returns the canonical directory path before receiving files", { skip: process.platform === "win32" ? "directory symlink behavior differs on Windows." : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-out-realpath-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await fs.mkdir(target);
  await fs.symlink(target, link, "dir");

  assert.equal(await ensureOutputDir(link), await fs.realpath(target));
});

test("ensureOutputDir rejects unsafe runtime values before path resolution", async () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 1;
    },
    toString() {
      coerced = true;
      return ".";
    }
  };
  for (const outputDir of [ensureOutputDir, distEnsureOutputDir]) {
    await assert.rejects(() => outputDir(hostile as never), /Output directory is invalid/);
    await assert.rejects(() => outputDir(""), /Output directory is required/);
    await assert.rejects(() => outputDir(" \t "), /Output directory is required/);
    await assert.rejects(() => outputDir(`${"a".repeat(4097)}`), /too long/);
    await assert.rejects(() => outputDir(`safe\u202edir`), /control or format/);
  }
  assert.equal(coerced, false);
});

test("ensureOutputDir input policy is present in source and shipped artifacts", () => {
  assert.match(securityPolicy, /CLI receiver output-directory and reservation helpers must reject non-string, empty, oversized, or control\/format-character paths before path resolution, mkdir, lstat, open, or path joining/);
  assert.match(securityPolicy, /reservations must carry the output directory identity through partial creation and final publish/);
  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /function outputDirInput/);
    assert.match(source, /typeof dir !== "string"/);
    assert.match(source, /dir\.trim\(\)\.length === 0/);
    assert.match(source, /MAX_OUTPUT_DIR_BYTES = 4096/);
    assert.match(source, /UNSAFE_OUTPUT_DIR_CHARS/);
    assert.match(source, /path\.resolve\(outputDirInput\(dir\)\)/);
    assert.match(source, /const outputDirIdentity = await directoryIdentity\(outputDir\)/);
    assert.match(source, /await assertDirectoryIdentity\(outputDir, outputDirIdentity\)/);
    assert.match(source, /dirDev: outputDirIdentity\.dev/);
    assert.match(source, /dirIno: outputDirIdentity\.ino/);
    assert.doesNotMatch(source, /path\.resolve\(dir\)/);
  }
  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /expectedDirectory/);
    assert.match(source, /await assertDirectoryIdentity\(path\.dirname\(safeFinalPath\), safeExpectedDirectory\)/);
    assert.match(source, /Output directory changed before publish/);
  }
});

test("reserveOutputFile rejects unsafe runtime output directories before path joining", async () => {
  let coerced = false;
  const hostile = {
    get length() {
      coerced = true;
      return 1;
    },
    toString() {
      coerced = true;
      return ".";
    }
  };

  for (const reserve of [reserveOutputFile, distReserveOutputFile]) {
    await assert.rejects(() => reserve(hostile as never, "file.txt"), /Output directory is invalid/);
    await assert.rejects(() => reserve("", "file.txt"), /Output directory is required/);
    await assert.rejects(() => reserve(" \t ", "file.txt"), /Output directory is required/);
    await assert.rejects(() => reserve("a".repeat(4097), "file.txt"), /too long/);
    await assert.rejects(() => reserve(`safe\u202edir`, "file.txt"), /control or format/);
  }
  assert.equal(coerced, false);

  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /const outputDir = path\.resolve\(outputDirInput\(dir\)\)/);
    assert.match(source, /path\.join\(outputDir, candidateName\)/);
    assert.match(source, /path\.join\(outputDir, randomPartFileName\(\)\)/);
    assert.match(source, /path\.join\(outputDir, await resumablePartFileName\(outputDir, candidateName, resumeSize\)\)/);
    assert.match(source, /const RESUME_SECRET_FILE = "\.ff-resume-key"/);
    assert.match(source, /const SAFE_SECRET_READ_FLAGS = fs\.constants\.O_RDONLY \| fs\.constants\.O_NOFOLLOW \| fs\.constants\.O_NONBLOCK/);
    assert.match(source, /fs\.promises\.open\(secretPath, "wx", 0o600\)/);
    assert.match(source, /stat\.size !== RESUME_SECRET_BYTES/);
    assert.doesNotMatch(source, /path\.join\(dir, candidateName\)/);
    assert.doesNotMatch(source, /path\.join\(dir, randomPartFileName\(candidateName\)\)/);
  }
});

test("reserveOutputFile bounds output name probing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-bound-"));
  for (let index = 0; index < MAX_OUTPUT_NAME_ATTEMPTS; index += 1) {
    const candidate = index === 0 ? "file.txt" : `file (${index}).txt`;
    await fs.writeFile(path.join(dir, candidate), "existing");
  }

  await assert.rejects(() => reserveOutputFile(dir, "file.txt"), /Could not reserve an output name/);
});

test("reserveOutputFile keeps collision names within portable byte limits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-collision-long-"));
  const requested = `${"a".repeat(240)}.txt`;
  const first = safeFileName(requested, SAFE_FILE_NAME_BYTES);
  await fs.writeFile(path.join(dir, first), "existing");

  const reserved = await reserveOutputFile(dir, requested);
  await reserved.handle.close();

  const outputName = path.basename(reserved.finalPath);
  const partName = path.basename(reserved.partPath);
  assert.equal(new TextEncoder().encode(outputName).byteLength <= SAFE_FILE_NAME_BYTES, true);
  assert.equal(new TextEncoder().encode(partName).byteLength <= SAFE_FILE_NAME_BYTES, true);
  assert.equal(outputName.includes("(1)"), true);
  assert.equal(outputName.endsWith(".txt"), true);
  assert.match(partName, RANDOM_PART_SUFFIX);
  assert.notEqual(partName, `${outputName}${PART_FILE_SUFFIX}`);
});

test("reserveOutputFile creates private partial files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-reserve-mode-"));
  const reserved = await reserveOutputFile(dir, "file.txt");
  try {
    if (process.platform !== "win32") {
      const stat = await fs.stat(reserved.partPath);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    await reserved.handle.close();
  }
});

test("publishPartFile refuses to publish a replaced partial path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-replaced-"));
  const reserved = await reserveOutputFile(dir, "file.txt");
  await reserved.handle.writeFile("trusted");
  await reserved.handle.close();
  await fs.rm(reserved.partPath);
  await fs.writeFile(reserved.partPath, "attacker");

  await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved), /Partial file changed/);
  await assert.rejects(() => fs.stat(reserved.finalPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(reserved.partPath, "utf8"), "attacker");
});

test("publishPartFile rejects partial paths replaced by symlinks", { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-publish-symlink-part-"));
  const reserved = await reserveOutputFile(dir, "file.txt");
  const movedPart = path.join(dir, "moved.part");
  await reserved.handle.writeFile("trusted");
  await reserved.handle.close();
  await fs.rename(reserved.partPath, movedPart);
  await fs.symlink(movedPart, reserved.partPath);

  await assert.rejects(() => publishPartFile(reserved.partPath, reserved.finalPath, reserved), /Partial file changed|Published path is not a file/);
  await assert.rejects(() => fs.lstat(reserved.finalPath), { code: "ENOENT" });
  assert.equal((await fs.lstat(reserved.partPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(movedPart, "utf8"), "trusted");
});

test("filesystem absence checks do not treat permission or IO errors as missing files", () => {
  assert.match(securityPolicy, /CLI filesystem error classifiers must inspect `code` through own data descriptors/);
  assert.equal(isMissingPathError({ code: "ENOENT" }), true);
  assert.equal(isMissingPathError({ code: "EACCES" }), false);
  assert.equal(isMissingPathError({ code: "EPERM" }), false);
  assert.equal(isMissingPathError(new Error("no code")), false);

  let getterCalled = false;
  const accessorError = {};
  Object.defineProperty(accessorError, "code", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "ENOENT";
    }
  });
  assert.equal(isMissingPathError(accessorError), false);
  assert.equal(getterCalled, false);

  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /Object\.getOwnPropertyDescriptor\(error, "code"\)/);
    assert.doesNotMatch(source, /"code" in error/);
  }
  for (const source of [sourceTransfer, distTransfer]) {
    assert.match(source, /Object\.getOwnPropertyDescriptor\(error, "code"\)/);
    assert.doesNotMatch(source, /"code" in Object\(error\)/);
    assert.doesNotMatch(source, /String\([^)]*\.code/);
  }
});

test("sender manifest refuses symbolic links instead of following targets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-symlink-send-"));
  const target = path.join(dir, "secret.txt");
  const link = path.join(dir, "link.txt");
  await fs.writeFile(target, "secret");
  await fs.symlink(target, link);

  await assert.rejects(() => buildManifest([link]), /symbolic link/);
});

test("sender manifest rejects hostile path arrays before resolving paths", async () => {
  assert.match(securityPolicy, /CLI sender manifest builders must descriptor-validate selected file path arrays and reject empty, oversized, or control\/format-character paths before path resolution or stat calls/);

  let accessorRead = false;
  const accessorPaths: unknown[] = [];
  Object.defineProperty(accessorPaths, "0", {
    enumerable: true,
    get() {
      accessorRead = true;
      return "file.txt";
    }
  });

  let coerced = false;
  const stringLikePath = {
    toString() {
      coerced = true;
      return "file.txt";
    }
  };

  for (const manifestBuilder of [buildManifest, distBuildManifest]) {
    await assert.rejects(() => manifestBuilder(accessorPaths as never), /File path is invalid/);
    await assert.rejects(() => manifestBuilder([stringLikePath] as never), /File path is invalid/);
    await assert.rejects(() => manifestBuilder([""]), /File path is required/);
    await assert.rejects(() => manifestBuilder([" \t "]), /File path is required/);
    await assert.rejects(() => manifestBuilder(["a".repeat(4097)]), /File path is too long/);
    await assert.rejects(() => manifestBuilder(["safe\u202epath.txt"]), /control or format/);
  }

  assert.equal(accessorRead, false);
  assert.equal(coerced, false);

  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /function sendPathInputs/);
    assert.match(source, /function sendPathInput/);
    assert.match(source, /Array\.isArray\(paths\)/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(paths, String\(index\)\)/);
    assert.match(source, /MAX_SEND_PATH_BYTES = 4096/);
    assert.match(source, /UNSAFE_SEND_PATH_CHARS/);
    assert.match(source, /sendPathInput\(descriptor\.value\)/);
    assert.doesNotMatch(source, /for \(const input of paths\)/);
  }
});

test("sender file cleanup ignores accessors and settles close failures", async () => {
  assert.match(securityPolicy, /CLI sender file cleanup must walk file arrays and handles through own data descriptors/);
  let accessorRead = false;
  const files: unknown[] = [
    {
      handle: {
        close() {
          throw new Error("close failed");
        }
      }
    },
    {
      handle: {
        close: async () => undefined
      }
    }
  ];
  Object.defineProperty(files, "2", {
    enumerable: true,
    get() {
      accessorRead = true;
      throw new Error("file getter executed");
    }
  });
  files.length = 3;
  const accessorHandle = {};
  Object.defineProperty(accessorHandle, "close", {
    enumerable: true,
    get() {
      accessorRead = true;
      return async () => undefined;
    }
  });
  files.push({ handle: accessorHandle });

  for (const cleanup of [closeSendFiles, distCloseSendFiles]) {
    await assert.doesNotReject(() => cleanup(files as never));
  }
  assert.equal(accessorRead, false);

  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /function sendFileCloseOperation/);
    assert.match(source, /function ownDataValue/);
    assert.match(source, /Object\.getOwnPropertyDescriptor\(files, String\(index\)\)/);
    assert.match(source, /Promise\.resolve\(\)\.then\(\(\) => close\.call\(handle\)\)/);
    assert.doesNotMatch(source, /files\.map\(\(file\) => file\.handle\.close\(\)\)/);
  }
});

test(
  "sender manifest refuses a path swapped to a symlink after lstat",
  { skip: process.platform === "win32" ? "symlink behavior differs on Windows." : false },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-send-lstat-swap-"));
    const filePath = path.join(dir, "file.txt");
    const target = path.join(dir, "secret.txt");
    await fs.writeFile(filePath, "safe");
    await fs.writeFile(target, "secret");
    const originalLstat = fsSync.promises.lstat as (targetPath: fsSync.PathLike) => Promise<fsSync.Stats>;
    const mutablePromises = fsSync.promises as unknown as {
      lstat: (targetPath: fsSync.PathLike) => Promise<fsSync.Stats>;
    };
    let swapped = false;
    try {
      mutablePromises.lstat = async (targetPath) => {
        const stat = await originalLstat.call(fsSync.promises, targetPath);
        if (!swapped && String(targetPath) === filePath) {
          swapped = true;
          await fs.rm(filePath);
          await fs.symlink(target, filePath);
        }
        return stat;
      };

      await assert.rejects(() => buildManifest([filePath]), /ELOOP|symbolic link|changed while preparing/i);
    } finally {
      mutablePromises.lstat = originalLstat;
    }
  }
);

test("sender manifest opens candidates with no-follow and nonblocking flags", () => {
  for (const source of [sourceFiles, distFiles]) {
    assert.match(source, /SAFE_READ_FLAGS/);
    assert.match(source, /fs\.constants\.O_NOFOLLOW/);
    assert.match(source, /fs\.constants\.O_NONBLOCK/);
    assert.match(source, /fs\.promises\.open\(filePath, SAFE_READ_FLAGS\)/);
    assert.doesNotMatch(source, /fs\.promises\.open\(filePath, "r"\)/);
  }
});
