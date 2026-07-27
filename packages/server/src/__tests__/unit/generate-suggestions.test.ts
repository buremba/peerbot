import { afterEach, describe, expect, test } from "bun:test";
import { generateSuggestions } from "../../gateway/suggestions/generate-suggestions";
import type { Env } from "../../index";

const REPLY =
  "I looked at the connector and it polls every 15 minutes. The rate limit is 100 requests per hour, so the current schedule leaves plenty of headroom.";

function env(over: Record<string, string | undefined> = {}): Env {
  return {
    ENVIRONMENT: "test",
    SUGGESTION_GENERATOR_API_KEY: "sk-test",
    ...over,
  } as unknown as Env;
}

/** Stub `fetch` with a canned chat-completion body. */
function stubFetch(content: string | null, ok = true): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: ok ? 200 : 500,
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("generateSuggestions", () => {
  test("parses well-formed prompts from the model", async () => {
    restore = stubFetch(
      JSON.stringify({
        prompts: [
          { title: "Raise the interval", message: "Change the poll to 5 min" },
          { title: "Show the rate limit", message: "Where is the limit set?" },
        ],
      })
    );
    const out = await generateSuggestions(REPLY, env());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: "Raise the interval",
      message: "Change the poll to 5 min",
    });
  });

  test("tolerates a markdown code fence around the JSON", async () => {
    // Chat models wrap JSON in ```json fences constantly even when told not to.
    restore = stubFetch(
      '```json\n{"prompts":[{"title":"T","message":"M"}]}\n```'
    );
    const out = await generateSuggestions(REPLY, env());
    expect(out).toEqual([{ title: "T", message: "M" }]);
  });

  test("returns [] when unconfigured rather than calling out", async () => {
    // No key → the feature is off. Assert no network call is even attempted.
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestions(
      REPLY,
      env({ SUGGESTION_GENERATOR_API_KEY: undefined })
    );
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("skips a reply too short to derive follow-ups from", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    expect(await generateSuggestions("Done.", env())).toEqual([]);
    expect(called).toBe(false);
  });

  test("fails open on a non-OK response", async () => {
    // The body is deliberately VALID — if the status check were deleted, this
    // payload would parse into a prompt and the test would fail. A null body
    // here would pass vacuously via the parse-failure path instead.
    restore = stubFetch(
      JSON.stringify({ prompts: [{ title: "T", message: "M" }] }),
      false
    );
    expect(await generateSuggestions(REPLY, env())).toEqual([]);
  });

  test("fails open on unparseable output instead of throwing", async () => {
    // A model that ignores the JSON instruction must not break the turn.
    restore = stubFetch("Sure! Here are some ideas: try asking about X.");
    expect(await generateSuggestions(REPLY, env())).toEqual([]);
  });

  test("drops malformed entries via the shared sanitizer", async () => {
    // Model output is untrusted — a reply can carry attacker-controlled
    // connector text that steers it. Bare strings and missing fields go.
    restore = stubFetch(
      JSON.stringify({
        prompts: [
          "just a string",
          { title: "ok", message: "keep me" },
          { title: "no message" },
          { message: "no title" },
        ],
      })
    );
    const out = await generateSuggestions(REPLY, env());
    expect(out).toEqual([{ title: "ok", message: "keep me" }]);
  });
});
