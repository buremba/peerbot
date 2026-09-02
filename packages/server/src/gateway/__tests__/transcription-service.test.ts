import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderConfigEntry } from "@lobu/core";
import {
  ProviderHttpError,
  TranscriptionService,
} from "../services/transcription-service.js";

const openAiProviderConfig = (): Record<string, ProviderConfigEntry> => ({
  openai: {
    displayName: "OpenAI",
    iconUrl: "https://example.com/icon.png",
    envVarName: "OPENAI_API_KEY",
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKeyInstructions: "x",
    apiKeyPlaceholder: "x",
    sdkCompat: "openai",
    modalities: ["text", "stt"],
    stt: {
      enabled: true,
      transcriptionPath: "/audio/transcriptions",
      model: "gpt-transcribe",
    },
  },
});

describe("TranscriptionService provider fallback", () => {
  afterEach(() => {
    mock.restore();
  });

  test("falls back to a config-driven STT provider when the built-in fails", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "chatgpt") {
          return { credential: "openai-key" };
        }
        if (providerId === "groq") {
          return { credential: "groq-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      groq: {
        displayName: "Groq",
        iconUrl: "https://example.com/icon.png",
        envVarName: "GROQ_API_KEY",
        upstreamBaseUrl: "https://api.groq.com/openai/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
        stt: {
          enabled: true,
          transcriptionPath: "/audio/transcriptions",
          model: "whisper-large-v3-turbo",
        },
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );
    const transcribeWithProvider = mock(
      async (_buffer: Buffer, config: any) => {
        if (config.profileProviderId === "chatgpt") {
          throw new Error("openai unauthorized");
        }
        return "hello from groq";
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
      expect(result.text).toBe("hello from groq");
      expect(result.provider).toBe("openai");
    }
  });

  test("carries the upstream HTTP status per attempt, not just in the message", async () => {
    // The status must survive as a FIELD. `provider-health-status.ts` is
    // status-only precisely because matching provider wording missed OpenAI's
    // "no credits remaining" in prod — so a caller must never have to parse
    // the sentence to learn this was a 429.
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) =>
        providerId === "chatgpt" ? { credential: "openai-key" } : null
      ),
    } as any;
    const service = new TranscriptionService(authProfilesManager);
    (service as any).transcribeWithProvider = mock(async () => {
      throw new ProviderHttpError(
        429,
        'OpenAI API error: 429 - {"code":"credit_balance_exhausted"}'
      );
    });

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-429",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0]?.status).toBe(429);
      expect(result.attempts?.[0]?.providerSlug).toBe("chatgpt");
    }
  });

  test("reports no status when the call never reached the provider", async () => {
    // A DNS failure or timeout is not a health verdict about the account.
    // Leaving `status` undefined is what keeps it from marking a provider
    // unhealthy — distinct from a 429, which does.
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) =>
        providerId === "chatgpt" ? { credential: "openai-key" } : null
      ),
    } as any;
    const service = new TranscriptionService(authProfilesManager);
    (service as any).transcribeWithProvider = mock(async () => {
      throw new Error("fetch failed");
    });

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-net",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0]?.status).toBeUndefined();
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

  test("uses the org inference-provider key without requiring an stt override block", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async () => null),
    } as any;
    const providerConfigSource = mock(async () => openAiProviderConfig());
    const orgCredentialSource = mock(async () => ({
      kind: "openai",
      apiKey: "org-openai-key",
    }));
    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );
    service.setInferenceProviderCredentialSource(orgCredentialSource);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.openai.com/v1/audio/transcriptions"
        );
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer org-openai-key"
        );
        const body = init?.body as FormData;
        expect(body.get("model")).toBe("gpt-transcribe");
        return new Response(JSON.stringify({ text: "hello from whatsapp" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    ) as any;

    try {
      const result = await service.transcribe(
        Buffer.from("m4a audio"),
        "agent-buremba",
        "audio/m4a"
      );
      expect(result).toEqual({
        text: "hello from whatsapp",
        provider: "openai",
        // The slug that served it — this is what lets a successful
        // transcription clear a health error the STT path itself set.
        providerSlug: "openai",
      });
      expect(orgCredentialSource).toHaveBeenCalledWith(
        "agent-buremba",
        "openai",
        "stt"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not send a differently-kinded org credential to the catalog endpoint", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async () => null),
    } as any;
    const providerConfigSource = mock(async () => openAiProviderConfig());
    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );
    service.setInferenceProviderCredentialSource(
      mock(async () => ({ kind: "gemini", apiKey: "gemini-key" }))
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("a Gemini credential must not be sent to OpenAI");
    });
    globalThis.fetch = fetchMock as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-credential-boundary",
        "audio/m4a"
      );
      expect(result).toEqual({
        error: "No transcription provider configured",
        availableProviders: ["openai"],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
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
        modalities: ["text"],
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

  test("does NOT treat an OpenAI-compatible provider as STT when it declares no stt modality", async () => {
    // OpenRouter (and Cerebras, z.ai, Mistral, …) speak the OpenAI chat protocol
    // but have no /audio/transcriptions endpoint. Previously STT defaulted ON for
    // every openai-compatible provider, so these were wrongly listed as
    // transcription candidates and 404'd. With no `stt` in modalities and no `stt`
    // block, the provider must be skipped and fetch never called.
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
        modalities: ["text"],
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called for a non-STT provider");
    });
    globalThis.fetch = fetchMock as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-4",
        "audio/ogg"
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("No transcription provider configured");
      }
      expect(fetchMock).not.toHaveBeenCalled();
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
