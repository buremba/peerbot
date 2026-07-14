import { afterEach, describe, expect, mock, test } from "bun:test";
import { classifyError } from "../core/error-handler";
import { LobuAgentWorker } from "../runtime/worker";
import {
  fetchAudioProviderSuggestions,
  generateAudio,
  normalizeAudioProviderSuggestions,
} from "@lobu/plugin-media";

const originalFetch = globalThis.fetch;

function extractText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content[0]?.text || "";
}

describe("audio provider suggestions", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("normalizes gateway capability providers into prefill IDs + display list", () => {
    const normalized = normalizeAudioProviderSuggestions({
      available: false,
      providers: [
        { provider: "openai", name: "OpenAI" },
        { provider: "acme-voice", name: "Acme Voice" },
      ],
    });

    expect(normalized.available).toBe(false);
    expect(normalized.usedFallback).toBe(false);
    expect(normalized.providerIds).toEqual(["chatgpt", "openai", "acme-voice"]);
    expect(normalized.providerDisplayList).toBe("OpenAI, Acme Voice");
  });

  test("falls back safely when capability payload is malformed", () => {
    const normalized = normalizeAudioProviderSuggestions({
      available: true,
      providers: [{ unexpected: "value" }],
    });

    expect(normalized.available).toBe(true);
    expect(normalized.usedFallback).toBe(true);
    expect(normalized.providerIds).toEqual(["chatgpt"]);
    expect(normalized.providerDisplayList).toBe("");
  });

  test("falls back safely when capability fetch fails", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const normalized = await fetchAudioProviderSuggestions({
      gatewayUrl: "http://gateway",
      workerToken: "token",
    });

    expect(normalized.available).toBeNull();
    expect(normalized.usedFallback).toBe(true);
    expect(normalized.providerIds).toEqual(["chatgpt"]);
    expect(normalized.providerDisplayList).toBe("");
  });
});

describe("generate_audio dynamic provider messaging", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("uses dynamic capability providers in missing-scope guidance", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/internal/audio/capabilities")) {
          return new Response(
            JSON.stringify({
              available: true,
              providers: [{ provider: "openai", name: "OpenAI" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/internal/audio/synthesize")) {
          expect(init?.method).toBe("POST");
          return new Response(
            JSON.stringify({
              error: "missing_scope: api.model.audio.request",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateAudio(
      {
        gatewayUrl: "http://gateway",
        workerToken: "token",
        channelId: "ch",
        conversationId: "conv",
        platform: "telegram",
      },
      { text: "hello world" }
    );

    const text = extractText(result as any);

    expect(text).toContain("OpenAI");
    expect(text).toContain("Ask an admin");
  });
});

describe("LobuAgentWorker audio permission hint", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("uses dynamic providers in admin guidance", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/internal/audio/capabilities")) {
        return new Response(
          JSON.stringify({
            available: true,
            providers: [{ provider: "openai", name: "OpenAI" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hint = await (
      LobuAgentWorker.prototype as any
    ).maybeBuildAudioPermissionHintMessage(
      "Audio generation failed because token lacks api.model.audio.request",
      "http://gateway",
      "token"
    );

    expect(hint).toContain("OpenAI");
    expect(hint).toContain("Ask an admin");
  });

  test("falls back to generic provider suggestions when capabilities lookup fails", async () => {
    const fetchMock = mock(async () => {
      throw new Error("capabilities unavailable");
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hint = await (
      LobuAgentWorker.prototype as any
    ).maybeBuildAudioPermissionHintMessage(
      "api.model.audio.request is missing",
      "http://gateway",
      "token"
    );

    expect(hint).toContain("an audio-capable provider");
    expect(hint).toContain("Ask an admin");
  });
});

describe("provider auth classification (no bespoke hint round-trip)", () => {
  test("a raw provider auth error classifies to PROVIDER_AUTH", () => {
    // The worker no longer rewrites the raw error into an admin-guidance
    // sentence that the classifier then re-parses. The raw error classifies
    // directly to a code; that code selects the reconnect CTA, and the raw
    // provider message is relayed verbatim as the body.
    expect(classifyError(new Error('Authentication failed for "openai"'))).toBe(
      "PROVIDER_AUTH"
    );
  });
});
