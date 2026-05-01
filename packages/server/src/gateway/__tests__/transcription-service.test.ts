import { afterEach, describe, expect, mock, test } from "bun:test";
import { TranscriptionService } from "../services/transcription-service.js";

describe("TranscriptionService provider fallback", () => {
  afterEach(() => {
    mock.restore();
  });

  test("falls back to next configured provider when first fails", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "chatgpt") {
          return { credential: "openai-key" };
        }
        if (providerId === "gemini") {
          return { credential: "gemini-key" };
        }
        return null;
      }),
    } as any;

    const service = new TranscriptionService(authProfilesManager);
    const transcribeWithProvider = mock(
      async (_buffer: Buffer, config: any) => {
        if (config.provider === "openai") {
          throw new Error("openai unauthorized");
        }
        return "hello from gemini";
      }
    );
    (service as any).transcribeWithProvider = transcribeWithProvider;

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-1",
      "audio/ogg"
    );

    expect(transcribeWithProvider).toHaveBeenCalledTimes(2);
    expect("text" in result).toBe(true);
    if ("text" in result) {
      expect(result.text).toBe("hello from gemini");
      expect(result.provider).toBe("gemini");
    }
  });

  test("returns no-provider error when no auth profiles exist", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async () => null),
    } as any;
    const service = new TranscriptionService(authProfilesManager);

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-2",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No transcription provider configured");
    }
  });

  test("uses config-driven OpenAI-compatible STT provider", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "openrouter") {
          return { credential: "or-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      openrouter: {
        displayName: "OpenRouter",
        iconUrl: "https://example.com/icon.png",
        envVarName: "OPENROUTER_API_KEY",
        upstreamBaseUrl: "https://openrouter.ai/api/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
        stt: {
          enabled: true,
          transcriptionPath: "/audio/transcriptions",
          model: "gpt-4o-mini-transcribe",
        },
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer or-key"
        );
        return new Response(JSON.stringify({ text: "hello from openrouter" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    ) as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-3",
        "audio/ogg"
      );
      expect("text" in result).toBe(true);
      if ("text" in result) {
        expect(result.text).toBe("hello from openrouter");
        expect(result.provider).toBe("openai");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses sdkCompat openai STT by default when stt block is missing", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "openrouter") {
          return { credential: "or-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      openrouter: {
        displayName: "OpenRouter",
        iconUrl: "https://example.com/icon.png",
        envVarName: "OPENROUTER_API_KEY",
        upstreamBaseUrl: "https://openrouter.ai/api/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      return new Response(JSON.stringify({ text: "default stt works" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-4",
        "audio/ogg"
      );
      expect("text" in result).toBe(true);
      if ("text" in result) {
        expect(result.text).toBe("default stt works");
        expect(result.provider).toBe("openai");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects stt.enabled=false for config-driven providers", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "openrouter") {
          return { credential: "or-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      openrouter: {
        displayName: "OpenRouter",
        iconUrl: "https://example.com/icon.png",
        envVarName: "OPENROUTER_API_KEY",
        upstreamBaseUrl: "https://openrouter.ai/api/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
        stt: {
          enabled: false,
        },
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-5",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No transcription provider configured");
    }
  });
});
