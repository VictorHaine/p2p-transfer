import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIsolatedDockerConfig } from "../scripts/docker-config.mjs";

type DockerContextMetadata = {
  Name: string;
  Endpoints: { docker: { Host: string; SkipTLSVerify?: boolean } };
  TLSMaterial?: Record<string, string>;
};

test("isolated Docker config imports only local context metadata without credentials", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "ff-docker-config-source-"));
  const created = await withSourceContext(source, "desktop-linux", {
    Name: "desktop-linux",
    Endpoints: { docker: { Host: "unix:///tmp/docker.sock", SkipTLSVerify: false } },
    TLSMaterial: {}
  });
  const isolated = createIsolatedDockerConfig("ff-docker-config-test-", source);
  try {
    const config = JSON.parse(await readFile(path.join(isolated, "config.json"), "utf8"));
    assert.deepEqual(config, { auths: {}, currentContext: "desktop-linux" });
    const metadata = JSON.parse(await readFile(path.join(isolated, "contexts", "meta", created.digest, "meta.json"), "utf8"));
    assert.deepEqual(metadata, {
      Name: "desktop-linux",
      Metadata: { Description: "Imported local Docker context for release validation" },
      Endpoints: { docker: { Host: "unix:///tmp/docker.sock", SkipTLSVerify: false } }
    });
  } finally {
    await rm(isolated, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("isolated Docker config refuses remote and TLS Docker contexts", async () => {
  for (const metadata of [
    { Name: "remote", Endpoints: { docker: { Host: "tcp://docker.example:2375", SkipTLSVerify: false } } },
    { Name: "remote", Endpoints: { docker: { Host: "ssh://docker.example", SkipTLSVerify: false } } },
    { Name: "remote", Endpoints: { docker: { Host: "unix:///tmp/docker.sock", SkipTLSVerify: false } }, TLSMaterial: { ca: "cert" } }
  ]) {
    const source = await mkdtemp(path.join(tmpdir(), "ff-docker-config-source-"));
    const isolated = await withRemoteSource(source, metadata);
    try {
      const config = JSON.parse(await readFile(path.join(isolated, "config.json"), "utf8"));
      assert.deepEqual(config, { auths: {} });
    } finally {
      await rm(isolated, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  }
});

test("isolated Docker config refuses malformed Docker metadata", async () => {
  const cases = [
    async (source: string) => {
      await writeFile(path.join(source, "config.json"), Buffer.from([0xc3, 0x28]));
    },
    async (source: string) => {
      await writeFile(path.join(source, "config.json"), JSON.stringify({ currentContext: "desktop-linux" }));
      const digest = contextDigest("desktop-linux");
      await mkdir(path.join(source, "contexts", "meta", digest), { recursive: true });
      await writeFile(path.join(source, "contexts", "meta", digest, "meta.json"), Buffer.from([0xc3, 0x28]));
    },
    async (source: string) => {
      await writeFile(path.join(source, "config.json"), JSON.stringify({ currentContext: "desktop-linux" }));
      const digest = contextDigest("desktop-linux");
      await mkdir(path.join(source, "contexts", "meta", digest), { recursive: true });
      await writeFile(path.join(source, "contexts", "meta", digest, "meta.json"), Buffer.alloc(32 * 1024 + 1, "{"));
    }
  ];
  for (const prepare of cases) {
    const source = await mkdtemp(path.join(tmpdir(), "ff-docker-config-source-"));
    await prepare(source);
    const isolated = createIsolatedDockerConfig("ff-docker-config-test-", source);
    try {
      const config = JSON.parse(await readFile(path.join(isolated, "config.json"), "utf8"));
      assert.deepEqual(config, { auths: {} });
    } finally {
      await rm(isolated, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  }
});

test("isolated Docker config refuses symlinked Docker config files", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "ff-docker-config-source-"));
  const external = await mkdtemp(path.join(tmpdir(), "ff-docker-config-external-"));
  try {
    await withSourceContext(external, "desktop-linux", {
      Name: "desktop-linux",
      Endpoints: { docker: { Host: "unix:///tmp/docker.sock", SkipTLSVerify: false } },
      TLSMaterial: {}
    });
    try {
      await symlink(path.join(external, "config.json"), path.join(source, "config.json"));
    } catch (error) {
      if (hasErrorCode(error, "EPERM") || hasErrorCode(error, "EACCES")) {
        t.skip("symlink creation is unavailable on this platform");
        return;
      }
      throw error;
    }
    const isolated = createIsolatedDockerConfig("ff-docker-config-test-", source);
    try {
      const config = JSON.parse(await readFile(path.join(isolated, "config.json"), "utf8"));
      assert.deepEqual(config, { auths: {} });
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

async function withRemoteSource(source: string, metadata: DockerContextMetadata) {
  await withSourceContext(source, "remote", metadata);
  return createIsolatedDockerConfig("ff-docker-config-test-", source);
}

async function withSourceContext(source: string, currentContext: string, metadata: DockerContextMetadata) {
  await mkdir(path.join(source, "contexts", "meta", contextDigest(currentContext)), { recursive: true });
  await writeFile(path.join(source, "config.json"), JSON.stringify({ auths: { "registry.example": { auth: "must-not-copy" } }, currentContext }));
  const digest = contextDigest(currentContext);
  await writeFile(path.join(source, "contexts", "meta", digest, "meta.json"), JSON.stringify(metadata));
  return { digest };
}

function contextDigest(name: string) {
  return createHash("sha256").update(name).digest("hex");
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && Object.getOwnPropertyDescriptor(error, "code")?.value === code);
}
