import { afterEach, describe, expect, test } from "bun:test";
import {
  GatewayJudgeClient,
  JudgeConfigurationError,
} from "../proxy/egress-judge/gateway-judge-client";
import { EgressJudge } from "../proxy/egress-judge/judge";
import { JudgeTimeoutError } from "../proxy/egress-judge/judge-utils";
import { resolveSystemJudgeTarget } from "../inference/system-judge-target";
import type { JudgeClient, JudgeRequest } from "../proxy/egress-judge/types";
import type { ResolvedJudgeRule } from "../permissions/policy-store";

const OK_TARGET = {
  ok: true as const,
  target: {
    baseUrl: "https://judge.example.test/v1",
    apiKey: "sk-operator-owned",
    model: "judge-model",
  },
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function stubFetch(
  content: string,
  init: { status?: number } = {}
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: init.status ?? 200,
    });
  }) as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return { calls };
}

describe("GatewayJudgeClient", () => {
  // POSITIVE CONTROL. Every other test here asserts a denial, and a client that
  // denied unconditionally would pass all of them while the feature is dead.
  // This is the one that fails if the happy path breaks.
  test("an allow verdict survives the round trip", async () => {
    stubFetch(JSON.stringify({ verdict: "allow", reason: "known host" }));
    const client = new GatewayJudgeClient({
      resolveTarget: async () => OK_TARGET,
    });

    const verdict = await client.judge({
      model: "acme/judge-model",
      systemPrompt: "SYS",
      userPrompt: "USER",
    });

    expect(verdict).toEqual({ verdict: "allow", reason: "known host" });
  });

  test("an unresolvable target raises JudgeConfigurationError, never a verdict", async () => {
    // Returning a deny here instead of throwing would record the denial as a
    // real model decision in the audit trail (source "judge", not
    // "judge-error"), hiding a misconfigured deployment as normal policy.
    stubFetch("unused");
    const client = new GatewayJudgeClient({
      resolveTarget: async () => ({
        ok: false as const,
        reason: "no-system-provider" as const,
        detail: "no deployment credential",
      }),
    });

    await expect(
      client.judge({ model: "acme/x", systemPrompt: "s", userPrompt: "u" })
    ).rejects.toBeInstanceOf(JudgeConfigurationError);
  });

  test("bounds the reply and makes exactly one attempt on a retryable 500", async () => {
    const { calls } = stubFetch("{}", { status: 500 });
    const client = new GatewayJudgeClient({
      resolveTarget: async () => OK_TARGET,
    });

    await expect(
      client.judge({ model: "acme/x", systemPrompt: "s", userPrompt: "u" })
    ).rejects.toThrow();

    // The circuit breaker is the retry policy; retrying inside one judge call
    // only delays the fail-closed deny.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body)).max_tokens).toBe(256);
  });

  test("uses the operator credential and target, not a caller-supplied one", async () => {
    const { calls } = stubFetch(JSON.stringify({ verdict: "deny", reason: "no" }));
    const client = new GatewayJudgeClient({
      resolveTarget: async () => OK_TARGET,
    });

    await client.judge({
      model: "acme/judge-model",
      systemPrompt: "s",
      userPrompt: "u",
    });

    expect(calls[0]?.url).toBe("https://judge.example.test/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-operator-owned");
  });

  test("a blown deadline surfaces as JudgeTimeoutError so the runner logs a timeout", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const client = new GatewayJudgeClient({
      timeoutMs: 10,
      resolveTarget: async () => OK_TARGET,
    });

    const err = await client
      .judge({ model: "acme/x", systemPrompt: "s", userPrompt: "u" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JudgeTimeoutError);
  });

  test("parses a verdict a small model wrapped in prose", async () => {
    stubFetch(
      'Sure! Here is my call: {"verdict": "deny", "reason": "unknown host"} Hope that helps.'
    );
    const client = new GatewayJudgeClient({
      resolveTarget: async () => OK_TARGET,
    });

    const verdict = await client.judge({
      model: "acme/x",
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(verdict.verdict).toBe("deny");
  });
});

/**
 * The security-critical half: a misconfiguration must not poison the circuit
 * breaker. The breaker's cooldown exists for upstreams that might recover; an
 * unconfigured deployment never does, and tripping the breaker would relabel
 * every later denial as a transient outage that never happened.
 */
describe("judge runner — configuration errors vs faults", () => {
  const RULE = {
    policy: "Allow only known hosts.",
    policyHash: "hash-a",
    judgeName: "test-judge",
    judgeModel: "acme/judge-model",
  } as ResolvedJudgeRule;

  const REQUEST: JudgeRequest = {
    agentId: "agent-1",
    organizationId: "org-1",
    hostname: "example.test",
  };

  /** Distinct hostname per call so the verdict cache never masks a live call. */
  function requestFor(n: number): JudgeRequest {
    return { ...REQUEST, hostname: `host-${n}.test` };
  }

  test("config errors deny, are attributed as judge-error, and leave the breaker closed", async () => {
    let calls = 0;
    const client: JudgeClient = {
      async judge() {
        calls += 1;
        throw new JudgeConfigurationError("no deployment credential");
      },
    };
    // Threshold is 5; drive well past it.
    const judge = new EgressJudge({ client, breakerFailureThreshold: 5 });

    for (let i = 0; i < 8; i++) {
      const decision = await judge.decide(requestFor(i), RULE);
      expect(decision.verdict).toBe("deny");
      expect(decision.source).toBe("judge-error");
    }

    // Every call reached the client: the breaker never opened and started
    // short-circuiting. A "circuit-open" source here would mean an operator
    // sees an outage where they should see a configuration error.
    expect(calls).toBe(8);
  });

  test("genuine faults DO trip the breaker, so the two paths are distinguishable", async () => {
    let calls = 0;
    const client: JudgeClient = {
      async judge() {
        calls += 1;
        throw new Error("upstream exploded");
      },
    };
    const judge = new EgressJudge({ client, breakerFailureThreshold: 5 });

    const sources: string[] = [];
    for (let i = 0; i < 8; i++) {
      sources.push((await judge.decide(requestFor(i), RULE)).source);
    }

    expect(sources.every((s) => s === "judge-error" || s === "circuit-open")).toBe(
      true
    );
    // Once open, the breaker short-circuits without calling the client — the
    // exact outcome a configuration error must NOT produce.
    expect(sources).toContain("circuit-open");
    expect(calls).toBeLessThan(8);
  });
});

describe("resolveSystemJudgeTarget", () => {
  const REGISTRY_ENV = "LOBU_PROVIDER_REGISTRY_PATH";

  const REGISTRY_PATH = new URL(
    "../../../../../config/providers.json",
    import.meta.url
  ).pathname;

  function withRegistry(): () => void {
    const prev = process.env[REGISTRY_ENV];
    process.env[REGISTRY_ENV] = REGISTRY_PATH;
    return () => {
      if (prev === undefined) delete process.env[REGISTRY_ENV];
      else process.env[REGISTRY_ENV] = prev;
    };
  }

  test("refuses a bare model id rather than guessing a provider", async () => {
    restore = withRegistry();
    const result = await resolveSystemJudgeTarget("gpt-4o-mini");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unqualified-ref");
  });

  test("refuses a provider the deployment holds no system key for", async () => {
    restore = withRegistry();
    const result = await resolveSystemJudgeTarget("definitely-not-a-provider/m");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-system-provider");
  });

  // The two branches that carry the migration risk. Everything else in this
  // describe asserts a refusal, so without these a resolver that refused
  // EVERY ref would pass the whole block while the judge is dead.
  test("resolves a provider the deployment holds an OpenAI-compatible system key for", async () => {
    const prevRegistry = process.env[REGISTRY_ENV];
    const prevKey = process.env.OPENAI_API_KEY;
    process.env[REGISTRY_ENV] = REGISTRY_PATH;
    process.env.OPENAI_API_KEY = "sk-deployment-owned";
    restore = () => {
      if (prevRegistry === undefined) delete process.env[REGISTRY_ENV];
      else process.env[REGISTRY_ENV] = prevRegistry;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    };

    const result = await resolveSystemJudgeTarget("openai/gpt-4o-mini");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.baseUrl).toBe("https://api.openai.com/v1");
      expect(result.target.model).toBe("gpt-4o-mini");
      expect(result.target.apiKey).toBe("sk-deployment-owned");
    }
  });

  test("refuses an anthropic-protocol provider even when its system key IS set", async () => {
    // The regression this guards: gatewayCompletion speaks only
    // OpenAI-compatible /chat/completions. A deployment that still holds
    // ANTHROPIC_API_KEY must not have `claude/...` accepted and then posted to
    // an endpoint that cannot parse it.
    const prevRegistry = process.env[REGISTRY_ENV];
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env[REGISTRY_ENV] = REGISTRY_PATH;
    process.env.ANTHROPIC_API_KEY = "sk-ant-still-configured";
    restore = () => {
      if (prevRegistry === undefined) delete process.env[REGISTRY_ENV];
      else process.env[REGISTRY_ENV] = prevRegistry;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    };

    const result = await resolveSystemJudgeTarget("claude/claude-haiku-4-5-20251001");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-system-provider");
      expect(result.detail).toContain("anthropic");
    }
  });

  test("an unreadable registry denies rather than falling back to another credential source", async () => {
    const prev = process.env[REGISTRY_ENV];
    process.env[REGISTRY_ENV] = "/nonexistent/providers.json";
    restore = () => {
      if (prev === undefined) delete process.env[REGISTRY_ENV];
      else process.env[REGISTRY_ENV] = prev;
    };

    const result = await resolveSystemJudgeTarget("openai/gpt-4o-mini");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-system-provider");
  });
});
