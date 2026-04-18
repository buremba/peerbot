import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawCustomTools } from "../openclaw/custom-tools";

const originalFetch = globalThis.fetch;

describe("createOpenClawCustomTools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("registers every built-in Lobu tool", () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "telegram",
      workspaceDir: "/tmp/test-workspace",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "UploadUserFile",
      "GenerateImage",
      "GenerateAudio",
      "GetChannelHistory",
      "AskUserQuestion",
    ]);
  });

  test("UploadUserFile emits a file-uploaded custom event after a successful upload", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-custom-tool-"));
    const filePath = join(tempDir, "proof.txt");
    writeFileSync(filePath, "proof");

    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/internal/files/upload")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({
        fileId: "file-123",
        name: "proof.txt",
        permalink: "https://files.example/proof.txt",
      });
    }) as unknown as typeof fetch;

    try {
      const uploadTool = createOpenClawCustomTools({
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
        workspaceDir: tempDir,
        onCustomEvent: (name, data) => {
          events.push({ name, data });
        },
      }).find((tool) => tool.name === "UploadUserFile");

      expect(uploadTool).toBeDefined();

      const result = await uploadTool!.execute("tool-call-1", {
        file_path: filePath,
      });

      expect(result.content[0]?.text).toContain(
        "Successfully showed proof.txt to the user"
      );
      expect(events).toEqual([
        {
          name: "file-uploaded",
          data: {
            tool: "UploadUserFile",
            platform: "telegram",
            fileId: "file-123",
            name: "proof.txt",
            permalink: "https://files.example/proof.txt",
            size: 5,
          },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
