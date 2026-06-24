import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
      "artifact-123"
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/lobu/api/v1/files/artifact-123");
    expect(parsed.searchParams.get("token")).toBeTruthy();
  });

  test("works for a root-mounted gateway (no path prefix)", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "https://gateway.example.com",
      "artifact-456"
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/files/artifact-456");
  });

  test("tolerates a trailing slash on the base URL", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "http://localhost:8954/lobu/",
      "artifact-789"
    );
    expect(new URL(url).pathname).toBe("/lobu/api/v1/files/artifact-789");
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
      env.artifactStore.validateDownloadToken(token as string, artifactId).valid
    ).toBe(true);
    const read = await env.artifactStore.read(artifactId);
    expect(read?.metadata.filename).toBe("note.txt");
  });
});
