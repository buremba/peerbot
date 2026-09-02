import { afterEach, describe, expect, test } from "bun:test";
import {
  GatewayCompletionTimeoutError,
  gatewayCompletion,
} from "../../gateway/inference/gateway-completion";

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
  init: { ok?: boolean; status?: number } = {}
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  const status = init.status ?? (init.ok === false ? 500 : 200);
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return new Response(JSON.stringify(body), { status });
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
    stubFetch({}, { status: 401 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/401/);
  });

  test("retries a transient 500 with backoff, then fails", async () => {
    const { calls } = stubFetch({}, { status: 500 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/500/);
    // Initial + 2 bounded retries — no unbounded loop.
    expect(calls.length).toBe(3);
  });

  test("does NOT start a retry whose backoff cannot fit the shared timeout budget", async () => {
    const { calls } = stubFetch({}, { status: 500 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 100,
      })
    ).rejects.toThrow(/500/);
    expect(calls.length).toBe(1);
  });

  test("retries a 429 then succeeds", async () => {
    const original = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({}), { status: 429 });
      return new Response(JSON.stringify(completionBody("recovered")), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });
    expect(out).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("does NOT retry a terminal 401", async () => {
    const { calls } = stubFetch({}, { status: 401 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/401/);
    expect(calls.length).toBe(1);
  });

  test("does NOT retry 'returned no text' (terminal empty result)", async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: null } }] });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/no text/);
    expect(calls.length).toBe(1);
  });

  test("an elapsed timeout aborts the request", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError"))
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
    expect(calls).toBe(1);
  });
});

/**
 * Options added for the fail-closed judge transport. The judge needs a bounded
 * reply, no retries (the circuit breaker is its retry policy), and a timeout it
 * can tell apart from an upstream fault when deciding what to alert on.
 */
describe("gatewayCompletion — fail-closed caller options", () => {
  test("omits max_tokens by default so existing callers are unchanged", async () => {
    const { calls } = stubFetch(completionBody("ok"));

    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect("max_tokens" in sent).toBe(false);
  });

  test("sends max_tokens when the caller sets a ceiling", async () => {
    const { calls } = stubFetch(completionBody("ok"));

    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
      maxTokens: 256,
    });

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.max_tokens).toBe(256);
  });

  test("maxRetries: 0 makes exactly one upstream attempt on a retryable 500", async () => {
    // Without the option this retries twice, so a naive judge migration would
    // triple the upstream load and delay every fail-closed deny.
    const { calls } = stubFetch({}, { status: 500 });

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
        maxRetries: 0,
      })
    ).rejects.toThrow();

    expect(calls).toHaveLength(1);
  });

  test("default retry budget is still 2 attempts after the first", async () => {
    const { calls } = stubFetch({}, { status: 500 });

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 30_000,
      })
    ).rejects.toThrow();

    expect(calls).toHaveLength(3);
  });

  test("a blown deadline throws GatewayCompletionTimeoutError, not a generic error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const err = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 10,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayCompletionTimeoutError);
    expect((err as GatewayCompletionTimeoutError).timeoutMs).toBe(10);
  });
});
