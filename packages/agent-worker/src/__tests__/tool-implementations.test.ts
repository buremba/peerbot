import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askUserQuestion,
  getChannelHistory,
  uploadUserFile,
} from "../shared/tool-implementations";

const originalFetch = globalThis.fetch;

const gw = {
  gatewayUrl: "http://gateway",
  workerToken: "worker-token",
  channelId: "channel-1",
  conversationId: "conversation-1",
  platform: "telegram",
};

function extractText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content[0]?.text || "";
}

describe("tool implementations", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("uploadUserFile uploads an existing file and emits onUploaded metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-upload-"));
    const filePath = join(tempDir, "e2e.txt");
    writeFileSync(filePath, "lobu e2e");

    const uploaded: Array<Record<string, unknown>> = [];
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/internal/files/upload")) {
          const headers = new Headers(init?.headers);
          expect(init?.method).toBe("POST");
          expect(headers.get("Authorization")).toBe("Bearer worker-token");
          expect(headers.get("X-Channel-Id")).toBe("channel-1");
          expect(headers.get("X-Conversation-Id")).toBe("conversation-1");
          return Response.json({
            fileId: "file-123",
            name: "e2e.txt",
            permalink: "https://files.example/e2e.txt",
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadUserFile(
        gw,
        { file_path: filePath, description: "Test file" },
        {
          onUploaded: (payload) => {
            uploaded.push(payload);
          },
        }
      );

      expect(extractText(result as any)).toContain(
        "Successfully showed e2e.txt to the user"
      );
      expect(uploaded).toEqual([
        {
          tool: "UploadUserFile",
          platform: "telegram",
          fileId: "file-123",
          name: "e2e.txt",
          permalink: "https://files.example/e2e.txt",
          size: 8,
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uploadUserFile forwards artifact fallback metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-upload-artifact-"));
    const filePath = join(tempDir, "fallback.txt");
    writeFileSync(filePath, "artifact");

    const uploaded: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        fileId: "artifact-123",
        artifactId: "artifact-123",
        name: "fallback.txt",
        permalink:
          "https://gateway.example.com/api/v1/files/artifact-123?token=abc",
        delivery: "artifact-url",
      })
    ) as unknown as typeof fetch;

    try {
      const result = await uploadUserFile(
        gw,
        { file_path: filePath },
        {
          onUploaded: (payload) => uploaded.push(payload),
        }
      );

      expect(extractText(result as any)).toContain(
        "Successfully showed fallback.txt to the user"
      );
      expect(uploaded).toEqual([
        {
          tool: "UploadUserFile",
          platform: "telegram",
          fileId: "artifact-123",
          artifactId: "artifact-123",
          name: "fallback.txt",
          permalink:
            "https://gateway.example.com/api/v1/files/artifact-123?token=abc",
          size: 8,
          delivery: "artifact-url",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uploadUserFile returns a clear error for missing files", async () => {
    const result = await uploadUserFile(gw, {
      file_path: "/tmp/does-not-exist",
    });
    expect(extractText(result as any)).toContain("not found or is not a file");
  });

  test("askUserQuestion posts a question interaction", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return Response.json({ id: "question-1" });
      }
    ) as unknown as typeof fetch;

    const result = await askUserQuestion(gw, {
      question: "Pick one",
      options: ["A", "B"],
    });

    expect(capturedBody).toEqual({
      interactionType: "question",
      question: "Pick one",
      options: ["A", "B"],
    });
    expect(extractText(result as any)).toContain(
      "Question posted with buttons"
    );
  });

  test("getChannelHistory returns note responses and formatted history", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ note: "History unavailable" })
    ) as unknown as typeof fetch;

    const note = await getChannelHistory(gw, { limit: 5 });
    expect(extractText(note as any)).toBe("History unavailable");

    globalThis.fetch = mock(async () =>
      Response.json({
        messages: [
          {
            timestamp: "2026-04-11T18:30:00.000Z",
            user: "Burak",
            text: "Hello",
            isBot: false,
          },
        ],
        nextCursor: "2026-04-11T18:00:00.000Z",
        hasMore: true,
      })
    ) as unknown as typeof fetch;

    const history = await getChannelHistory(gw, { limit: 5 });
    const text = extractText(history as any);
    expect(text).toContain("Found 1 messages");
    expect(text).toContain("Burak: Hello");
    expect(text).toContain('before="2026-04-11T18:00:00.000Z"');
  });
});
