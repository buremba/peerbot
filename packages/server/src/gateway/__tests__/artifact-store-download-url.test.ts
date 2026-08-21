import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore, runArtifactBinding } from "../files/artifact-store.js";
import { type ArtifactTestEnv, createArtifactTestEnv } from "./setup.js";

describe("ArtifactStore.buildDownloadUrl", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("preserves a base-path prefix on the public gateway URL", () => {
    // Regression: the embedded/local gateway is mounted under `/lobu`, so the
    // worker must fetch `/lobu/api/v1/files/...`. Building the URL with
    // `new URL("/api/v1/files/...", base)` silently dropped the prefix (a
    // leading-slash path is absolute from the origin root), so the worker hit
    // `/api/v1/files/...` → 404 and inbound attachments never reached the agent.
    const url = env.artifactStore.buildDownloadUrl(
      "http://localhost:8954/lobu",
      "artifact-123",
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/lobu/api/v1/files/artifact-123");
    expect(parsed.searchParams.get("token")).toBeTruthy();
  });

  test("works for a root-mounted gateway (no path prefix)", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "https://gateway.example.com",
      "artifact-456",
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/files/artifact-456");
  });

  test("tolerates a trailing slash on the base URL", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "http://localhost:8954/lobu/",
      "artifact-789",
    );
    expect(new URL(url).pathname).toBe("/lobu/api/v1/files/artifact-789");
  });

  test("rejects oversized download tokens before decryption", () => {
    expect(
      env.artifactStore.validateDownloadToken(
        "x".repeat(4097),
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toEqual({ valid: false, error: "malformed" });
  });

  test("round-trips: a published artifact is served from its own URL path", async () => {
    const { artifactId, downloadUrl } = await env.artifactStore.publish({
      buffer: Buffer.from("hello world"),
      filename: "note.txt",
      contentType: "text/plain",
      publicGatewayUrl: "http://localhost:8954/lobu",
    });
    const parsed = new URL(downloadUrl);
    expect(parsed.pathname).toBe(`/lobu/api/v1/files/${artifactId}`);
    const token = parsed.searchParams.get("token");
    expect(token).toBeTruthy();
    expect(
      env.artifactStore.validateDownloadToken(token as string, artifactId)
        .valid,
    ).toBe(true);
    const read = await env.artifactStore.read(artifactId);
    expect(read?.metadata.filename).toBe("note.txt");
  });
  test("enforces immutable internal bindings and supports cleanup", async () => {
    const binding = runArtifactBinding(42);
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("bound"),
      filename: "bound.txt",
      contentType: "text/plain",
      publicGatewayUrl: "http://localhost:8954/lobu",
      binding,
    });

    expect(await env.artifactStore.read(artifactId, { binding })).toBeTruthy();
    expect(
      await env.artifactStore.read(artifactId, {
        binding: runArtifactBinding(43),
      }),
    ).toBeNull();

    await env.artifactStore.delete(artifactId);
    expect(await env.artifactStore.read(artifactId)).toBeNull();
  });
});

describe("ArtifactStore shared filesystem backend", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("fails closed when production has no durable artifacts directory", () => {
    const previousEnvironment = process.env.ENVIRONMENT;
    const previousArtifactsDir = process.env.LOBU_ARTIFACTS_DIR;
    try {
      process.env.ENVIRONMENT = "production";
      delete process.env.LOBU_ARTIFACTS_DIR;
      expect(() => new ArtifactStore()).toThrow(
        "Production artifact storage requires LOBU_ARTIFACTS_DIR on a durable shared filesystem",
      );
    } finally {
      if (previousEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = previousEnvironment;
      if (previousArtifactsDir === undefined)
        delete process.env.LOBU_ARTIFACTS_DIR;
      else process.env.LOBU_ARTIFACTS_DIR = previousArtifactsDir;
    }
  });

  test("shares verified private artifacts across store instances", async () => {
    const writer = new ArtifactStore(env.artifactsDir);
    const reader = new ArtifactStore(env.artifactsDir);
    const binding = runArtifactBinding(314);
    const bytes = Buffer.from("shared-image-bytes");

    const published = await writer.publish({
      buffer: bytes,
      filename: "mémory photo.webp",
      contentType: "image/webp",
      publicGatewayUrl: "https://lobu.example.com",
      binding,
    });

    expect(
      await reader.read(published.artifactId, {
        binding,
        maxBytes: bytes.length - 1,
      }),
    ).toBeNull();
    expect(
      await reader.read(published.artifactId, {
        binding: runArtifactBinding(315),
      }),
    ).toBeNull();

    const stored = await reader.read(published.artifactId, { binding });
    expect(stored?.metadata).toEqual(
      expect.objectContaining({
        filename: "mémory photo.webp",
        contentType: "image/webp",
        size: bytes.length,
        binding,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(stored?.bytes).toEqual(bytes);

    await writer.delete(published.artifactId);
    expect(await reader.read(published.artifactId)).toBeNull();
  });

  test("keeps reserved metadata filenames separate from payload bytes", async () => {
    const bytes = Buffer.from("not artifact metadata");
    const published = await env.artifactStore.publish({
      buffer: bytes,
      filename: "metadata.json",
      contentType: "application/json",
      publicGatewayUrl: "https://lobu.example.com",
    });

    const stored = await env.artifactStore.read(published.artifactId);
    expect(stored?.metadata.filename).toBe("metadata.json");
    expect(stored?.bytes).toEqual(bytes);
  });

  test("rejects artifact ids that can escape the configured directory", async () => {
    expect(await env.artifactStore.read("../outside")).toBeNull();
    await expect(
      env.artifactStore.delete("../outside"),
    ).resolves.toBeUndefined();
  });

  test("rejects oversized metadata before parsing it", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("small"),
      filename: "small.txt",
      publicGatewayUrl: "https://lobu.example.com",
    });
    await writeFile(
      join(env.artifactsDir, published.artifactId, "metadata.json"),
      JSON.stringify({
        artifactId: published.artifactId,
        filename: "x".repeat(128 * 1024),
        contentType: "text/plain",
        size: 5,
        createdAt: Date.now(),
        sha256: createHash("sha256").update("small").digest("hex"),
      }),
    );

    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
  });

  test("does not follow a replacement symlink even when bytes match", async () => {
    const bytes = Buffer.from("same-secret-bytes");
    const published = await env.artifactStore.publish({
      buffer: bytes,
      filename: "safe.txt",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const outside = join(env.artifactsDir, "outside-secret");
    await writeFile(outside, bytes);
    const payload = join(env.artifactsDir, published.artifactId, "content");
    await Bun.file(payload).delete();
    await symlink(outside, payload);

    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
  });

  test("quarantines a failed delete and drains the leftover before another publish", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("abandoned"),
      filename: "abandoned.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const realRm = fs.rm;
    let failQuarantinedRemoval = true;
    const rmSpy = spyOn(fs, "rm").mockImplementation(
      async (target, options) => {
        if (
          failQuarantinedRemoval &&
          String(target).includes(`${join(env.artifactsDir, ".trash")}/`)
        ) {
          failQuarantinedRemoval = false;
          throw new Error("injected retained-PVC removal failure");
        }
        return realRm(target, options);
      },
    );

    try {
      await expect(
        env.artifactStore.delete(published.artifactId),
      ).rejects.toThrow("injected retained-PVC removal failure");
    } finally {
      rmSpy.mockRestore();
    }
    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
    const trashDir = join(env.artifactsDir, ".trash");
    const [quarantined] = await readdir(trashDir);
    expect(quarantined).toContain(published.artifactId);

    // A retained PVC has nothing else to reclaim the leftover. Publication
    // cannot continue while known uncommitted bytes remain abandoned.
    const next = await env.artifactStore.publish({
      buffer: Buffer.from("next"),
      filename: "next.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    expect(await readdir(trashDir)).toEqual([]);

    await env.artifactStore.delete(next.artifactId);
    expect(await readdir(trashDir)).toEqual([]);
  });

  test("fails closed when a quarantined orphan still cannot be removed", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("abandoned"),
      filename: "abandoned.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const realRm = fs.rm;
    const rmSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(`${join(env.artifactsDir, ".trash")}/`)) {
        throw new Error("retained PVC remains unavailable");
      }
      return realRm(target, options);
    });

    try {
      await expect(env.artifactStore.delete(published.artifactId)).rejects.toThrow(
        "retained PVC remains unavailable",
      );
      await expect(
        env.artifactStore.publish({
          buffer: Buffer.from("must-not-publish"),
          filename: "blocked.bin",
          publicGatewayUrl: "https://lobu.example.com",
        }),
      ).rejects.toThrow("retained PVC remains unavailable");
    } finally {
      rmSpy.mockRestore();
    }

    expect(await readdir(join(env.artifactsDir, ".trash"))).toHaveLength(1);
  });
});
