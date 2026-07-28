import { afterEach, describe, expect, test } from "bun:test";
import { gatewayCompletion } from "../../gateway/inference/gateway-completion";

const TARGET = {
  baseUrl: "https://api.example.test/v1",
  apiKey: "sk-test",
  model: "test-model",
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Stub `fetch`, capturing the request for assertions. */
function stubFetch(
  body: unknown,
  init: { ok?: boolean } = {}
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return new Response(JSON.stringify(body), {
      status: init.ok === false ? 500 : 200,
    });
  }) as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return { calls };
}

function completionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("gatewayCompletion", () => {
  test("posts an OpenAI-compatible chat/completions request", async () => {
    const { calls } = stubFetch(completionBody("hello"));

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "SYS",
      userPrompt: "USER",
      timeoutMs: 5_000,
    });

    expect(out).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/chat/completions");

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.model).toBe("test-model");
    expect(sent.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    // These callers all parse strict JSON, so determinism is the default.
    expect(sent.temperature).toBe(0);
  });

  test("sends the key as a bearer token", async () => {
    const { calls } = stubFetch(completionBody("ok"));
    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  test("an explicit temperature overrides the deterministic default", async () => {
    const { calls } = stubFetch(completionBody("ok"));
    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      temperature: 0.3,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(String(calls[0]?.init.body)).temperature).toBe(0.3);
  });

  test("throws on a non-ok response", async () => {
    stubFetch({}, { ok: false });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/500/);
  });

  test("throws when the response carries no text", async () => {
    stubFetch({ choices: [{ message: { content: null } }] });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/no text/);
  });

  test("an elapsed timeout aborts the request", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 10,
      })
    ).rejects.toThrow();
  });
});
