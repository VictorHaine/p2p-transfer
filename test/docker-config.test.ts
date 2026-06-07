import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
