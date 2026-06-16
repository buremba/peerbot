import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import type { PlatformRegistry } from "../platform.js";
import type { IFileHandler } from "../platform/file-handler.js";
import { createFileRoutes } from "../routes/internal/files.js";
import { createPublicFileRoutes } from "../routes/public/files.js";
import {
  type ArtifactTestEnv,
  createArtifactTestEnv,
  TEST_GATEWAY_URL,
} from "./setup.js";

describe("file routes", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  /** Build an in-memory app wired to the given (optional) platform handler. */
  function buildApp(handler?: IFileHandler) {
    const app = new Hono();
    const platformRegistry = {
      get: () => ({ getFileHandler: () => handler }),
    } as unknown as PlatformRegistry;
    app.route(
      "/internal/files",
      createFileRoutes(platformRegistry, env.artifactStore, TEST_GATEWAY_URL)
    );
    app.route("", createPublicFileRoutes(env.artifactStore));
    return app;
  }

  async function uploadProof(app: Hono, filename: string, contents: string) {
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
    });
    const form = new FormData();
    form.set("file", new File([contents], filename, { type: "text/plain" }));
    form.set("filename", filename);
    return app.request("/internal/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Channel-Id": "channel-1",
        "X-Conversation-Id": "conv-1",
      },
      body: form,
    });
  }

  // Both upload paths — "no platform handler" and "platform handler throws"
  // — must transparently fall back to a signed artifact URL. They are the
  // same contract triggered two different ways.
  const FALLBACK_CASES: Array<{
    name: string;
    handler?: IFileHandler;
    expectAttempts: number;
  }> = [
    { name: "no platform file handler exists", expectAttempts: 0 },
    {
      name: "platform upload fails",
      expectAttempts: 1,
      handler: {
        uploadFile: async () => {
          throw new Error("telegram upload failed");
        },
      },
    },
  ];

  test.each(
    FALLBACK_CASES
  )("falls back to a signed artifact URL when $name", async ({
    handler,
    expectAttempts,
  }) => {
    let attempts = 0;
    const wrapped: IFileHandler | undefined = handler && {
      uploadFile: async (...args) => {
        attempts += 1;
        return handler.uploadFile(...args);
      },
    };

    const app = buildApp(wrapped);

    const filename = expectAttempts === 0 ? "proof.txt" : "fallback.txt";
    const contents =
      expectAttempts === 0 ? "hello artifact" : "fallback artifact";
    const uploadResponse = await uploadProof(app, filename, contents);

    expect(attempts).toBe(expectAttempts);
    expect(uploadResponse.status).toBe(200);
    const uploadBody = (await uploadResponse.json()) as {
      success: boolean;
      fileId: string;
      permalink: string;
      name: string;
      size: number;
      delivery: string;
      artifactId?: string;
    };

    expect(uploadBody.success).toBe(true);
    expect(uploadBody.delivery).toBe("artifact-url");
    expect(uploadBody.name).toBe(filename);
    expect(uploadBody.permalink).toContain("/api/v1/files/");
    expect(uploadBody.artifactId).toBe(uploadBody.fileId);

    // The signed permalink the worker would receive is fetchable end-to-end.
    const downloadUrl = new URL(uploadBody.permalink);
    const downloadResponse = await app.request(
      `${downloadUrl.pathname}${downloadUrl.search}`
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toContain(
      "text/plain"
    );
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      `filename="${filename}"`
    );
    expect(await downloadResponse.text()).toBe(contents);
  });

  // SECURITY regression: the upload route read the destination channel from the
  // X-Channel-Id / X-Conversation-Id request headers, never comparing them to
  // the verified worker token. A worker could override them to deliver
  // attachments to ANY channel the connection's bot can reach. The route must
  // use the token-bound channel/conversation and ignore the headers.
  test("upload routes to the TOKEN-bound channel, not attacker-supplied headers", async () => {
    let seen: { channelId?: string; threadTs?: string } | undefined;
    const handler: IFileHandler = {
      uploadFile: async (_stream, opts) => {
        seen = { channelId: opts.channelId, threadTs: opts.threadTs };
        return {
          fileId: "f1",
          permalink: "https://example.test/f1",
          name: opts.filename ?? "f",
          size: 1,
          delivery: "platform-upload" as const,
        };
      },
    };
    const app = buildApp(handler);

    // Token scopes the worker to channel-1 / conv-1.
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
    });
    const form = new FormData();
    form.set("file", new File(["x"], "p.txt", { type: "text/plain" }));
    form.set("filename", "p.txt");

    // Attacker-supplied headers point at a different channel/conversation.
    const res = await app.request("/internal/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Channel-Id": "victim-channel",
        "X-Conversation-Id": "victim-conv",
      },
      body: form,
    });

    expect(res.status).toBe(200);
    // The file handler must have been invoked with the token-bound channel,
    // NOT the attacker's header values.
    expect(seen?.channelId).toBe("channel-1");
    expect(seen?.threadTs).toBe("conv-1");
    expect(seen?.channelId).not.toBe("victim-channel");
    expect(seen?.threadTs).not.toBe("victim-conv");
  });
});
