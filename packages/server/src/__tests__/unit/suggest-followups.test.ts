import { afterEach, describe, expect, test } from "bun:test";
import {
  createSuggestFollowupsGuardrail,
  generateSuggestFollowups,
  isEnrichmentGuardrail,
  SUGGEST_FOLLOWUPS_NAME,
} from "../../gateway/guardrails/suggest-followups";
import { partitionBlockingOutputGuardrails } from "../../gateway/guardrails/output-scan";
import type { Guardrail } from "@lobu/core";

const REPLY =
  "I looked at the connector and it polls every 15 minutes. The rate limit is 100 requests per hour, so the current schedule leaves plenty of headroom.";

function env(over: Record<string, string | undefined> = {}) {
  return {
    SUGGESTION_GENERATOR_API_KEY: "sk-test",
    SUGGESTION_GENERATOR_BASE_URL: "https://api.example.com/v1",
    SUGGESTION_GENERATOR_MODEL: "gpt-test",
    ...over,
  };
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

describe("suggest-followups guardrail", () => {
  test("registers under the operator-facing name", () => {
    const g = createSuggestFollowupsGuardrail();
    expect(g.name).toBe(SUGGEST_FOLLOWUPS_NAME);
    expect(g.stage).toBe("output");
  });

  test("run is a pure no-op pass (generation is out-of-band)", async () => {
    const g = createSuggestFollowupsGuardrail();
    const result = await g.run({
      agentId: "a",
      userId: "u",
      text: REPLY,
      platform: "api",
    });
    expect(result).toEqual({ tripped: false });
  });

  test("isEnrichmentGuardrail partitions the name", () => {
    expect(isEnrichmentGuardrail(SUGGEST_FOLLOWUPS_NAME)).toBe(true);
    expect(isEnrichmentGuardrail("secret-scan")).toBe(false);
  });

  test("partitionBlockingOutputGuardrails drops enrichment entries", () => {
    const list = [
      { name: "secret-scan", stage: "output" as const, run: async () => ({ tripped: false }) },
      {
        name: SUGGEST_FOLLOWUPS_NAME,
        stage: "output" as const,
        run: async () => ({ tripped: false }),
      },
    ] as Guardrail<"output">[];
    const blocking = partitionBlockingOutputGuardrails(list);
    expect(blocking.map((g) => g.name)).toEqual(["secret-scan"]);
  });
});

describe("generateSuggestFollowups", () => {
  test("parses well-formed prompts from the model", async () => {
    restore = stubFetch(
      JSON.stringify({
        prompts: [
          { title: "Raise the interval", message: "Change the poll to 5 min" },
          { title: "Show the rate limit", message: "Where is the limit set?" },
        ],
      })
    );
    const out = await generateSuggestFollowups(REPLY, env());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: "Raise the interval",
      message: "Change the poll to 5 min",
    });
  });

  test("tolerates a markdown code fence around the JSON", async () => {
    restore = stubFetch(
      '```json\n{"prompts":[{"title":"T","message":"M"}]}\n```'
    );
    const out = await generateSuggestFollowups(REPLY, env());
    expect(out).toEqual([{ title: "T", message: "M" }]);
  });

  test("returns [] when unconfigured rather than calling out", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups(
      REPLY,
      env({ SUGGESTION_GENERATOR_API_KEY: undefined })
    );
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] on short replies without calling out", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups("ok", env());
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] when the model HTTP-errors", async () => {
    restore = stubFetch("{}", false);
    const out = await generateSuggestFollowups(REPLY, env());
    expect(out).toEqual([]);
  });
});
