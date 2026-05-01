import { afterEach, describe, expect, mock, test } from "bun:test";
import { generateAudio, generateImage } from "../shared/tool-implementations";

const originalFetch = globalThis.fetch;

function extractText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content[0]?.text || "";
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}

describe("generated media upload flow", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("GenerateImage uploads the generated image to the gateway", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/internal/images/capabilities")) {
          return Response.json({ available: true });
        }

        if (url.endsWith("/internal/images/generate")) {
          return new Response(Buffer.from("png-bytes"), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "X-Image-Provider": "openai",
            },
          });
        }

        if (url.endsWith("/internal/files/upload")) {
          const headers = new Headers(init?.headers);
          const body = bodyToString(init?.body);

          expect(init?.method).toBe("POST");
          expect(headers.get("Authorization")).toBe("Bearer worker-token");
          expect(headers.get("X-Channel-Id")).toBe("channel-1");
          expect(headers.get("X-Conversation-Id")).toBe("conversation-1");
          expect(headers.get("X-Voice-Message")).toBeNull();
          expect(headers.get("Content-Type")).toContain("multipart/form-data");
          expect(body).toContain("generated_image.png");
          expect(body).toContain("Generated content");

          return Response.json({ success: true, fileId: "file-1" });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage(
      {
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
      },
      { prompt: "A watercolor fox" }
    );

    expect(extractText(result as any)).toContain("Image sent successfully");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("GenerateAudio uploads synthesized speech as a voice message", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/internal/audio/capabilities")) {
          return Response.json({
            available: true,
            providers: [{ provider: "openai", name: "OpenAI" }],
          });
        }

        if (url.endsWith("/internal/audio/synthesize")) {
          return new Response(Buffer.from("ogg-bytes"), {
            status: 200,
            headers: {
              "Content-Type": "audio/ogg",
              "X-Audio-Provider": "openai",
            },
          });
        }

        if (url.endsWith("/internal/files/upload")) {
          const headers = new Headers(init?.headers);
          const body = bodyToString(init?.body);

          expect(init?.method).toBe("POST");
          expect(headers.get("Authorization")).toBe("Bearer worker-token");
          expect(headers.get("X-Channel-Id")).toBe("channel-1");
          expect(headers.get("X-Conversation-Id")).toBe("conversation-1");
          expect(headers.get("X-Voice-Message")).toBe("true");
          expect(headers.get("Content-Type")).toContain("multipart/form-data");
          expect(body).toContain("voice_response.ogg");
          expect(body).toContain("Generated content");

          return Response.json({ success: true, fileId: "file-2" });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateAudio(
      {
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
      },
      { text: "Hello there" }
    );

    expect(extractText(result as any)).toContain(
      "Voice message sent successfully"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
