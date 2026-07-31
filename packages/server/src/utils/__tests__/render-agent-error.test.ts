/**
 * renderAgentError is THE renderer every surface (Slack/Telegram bridge,
 * browser SSE) shares. These tests pin the code → (text, CTA) contract so the
 * same agent error reads identically everywhere — the thing that was NOT true
 * while four layers each formatted errors independently.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentErrorCode } from "@lobu/core";
import { type AgentErrorCtaResolvers, renderAgentError } from "../url-builder";

const SETTINGS_URL = "https://app.lobu.ai/acme/agents/agent-1/settings";
const CONNECT_URL =
  "https://app.lobu.ai/acme/connectors/inference-provider%3Az-ai?reason=model_provider_not_connected";
const MANAGE_URL =
  "https://app.lobu.ai/acme/connectors/inference-provider%3Az-ai?model=glm-5.2";

// Distinct resolvers per CTA kind, so a test can assert that a code routes to
// the RIGHT page (pick-a-model vs connect-a-provider), not just "some url".
const resolvers: AgentErrorCtaResolvers = {
  "agent-settings": async () => SETTINGS_URL,
  "provider-connect": async () => CONNECT_URL,
  "provider-management": async () => MANAGE_URL,
};
const resolveNothing: AgentErrorCtaResolvers = {
  "agent-settings": async () => null,
  "provider-connect": async () => null,
  "provider-management": async () => null,
};

describe("renderAgentError", () => {
  it("provider quota relays the provider message + routes to existing-provider management", async () => {
    // The provider's message already says when the quota resets — we relay it
    // unchanged (no reset-time parsing, no reword) and only add the CTA link. A
    // quota/provider-level failure is fixed on existing-provider management.
    const raw =
      "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      raw,
      resolvers
    );
    expect(r.text).toBe(raw);
    expect(r.ctaUrl).toBe(MANAGE_URL);
    expect(r.ctaLabel).toBe("Manage provider");
    expect(r.silent).toBe(false);
  });

  it("provider error with no relayed message renders empty text but keeps the CTA", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      undefined,
      resolvers
    );
    expect(r.text).toBe("");
    expect(r.ctaUrl).toBe(MANAGE_URL);
  });

  it("auth failure routes to existing-provider management (not add-new or settings)", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_AUTH,
      'Authentication failed for "openai"',
      resolvers
    );
    expect(r.text).toBe('Authentication failed for "openai"');
    expect(r.ctaUrl).toBe(MANAGE_URL);
    expect(r.ctaUrl).not.toBe(SETTINGS_URL);
    expect(r.ctaUrl).not.toBe(CONNECT_URL);
    expect(r.ctaLabel).toBe("Reconnect provider");
  });

  it("NO_MODEL_CONFIGURED (agent-settings kind) routes to the SETTINGS page", async () => {
    const r = await renderAgentError(
      AgentErrorCode.NO_MODEL_CONFIGURED,
      undefined,
      resolvers
    );
    expect(r.text).toContain("No model");
    expect(r.ctaUrl).toBe(SETTINGS_URL);
    expect(r.ctaLabel).toBe("Choose a model");
  });

  it("WORKER_UNRESPONSIVE uses OUR catalog text (no provider message) and NO CTA", async () => {
    let called = false;
    const r = await renderAgentError(
      AgentErrorCode.WORKER_UNRESPONSIVE,
      // Even if a stray message is passed, a synthesized error prefers its own
      // catalog text.
      "some raw string",
      {
        "agent-settings": async () => {
          called = true;
          return SETTINGS_URL;
        },
      }
    );
    expect(r.text.toLowerCase()).toContain("try again");
    expect(r.text).not.toBe("some raw string");
    expect(r.ctaUrl).toBeNull();
    expect(called).toBe(false);
  });

  it("SESSION_TIMEOUT is silent", async () => {
    const r = await renderAgentError(
      AgentErrorCode.SESSION_TIMEOUT,
      undefined,
      resolvers
    );
    expect(r.silent).toBe(true);
  });

  it("a CTA code whose resolver returns null degrades to text-only", async () => {
    const r = await renderAgentError(
      AgentErrorCode.NO_MODEL_CONFIGURED,
      undefined,
      resolveNothing
    );
    expect(r.text).toContain("No model");
    expect(r.ctaUrl).toBeNull();
  });

  it("a CTA code whose resolver is ABSENT degrades to text-only (no throw)", async () => {
    // provider-management resolver omitted → PROVIDER_AUTH renders text-only.
    const r = await renderAgentError(AgentErrorCode.PROVIDER_AUTH, "auth fail", {
      "agent-settings": async () => SETTINGS_URL,
    });
    expect(r.text).toBe("auth fail");
    expect(r.ctaUrl).toBeNull();
  });
});

describe("provider error bodies are labelled and unwrapped", () => {
  // Regression for Anthropic's status-prefixed JSON error envelope.
  const RAW_400 =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdVJwuwSg3kq5CWVwRR7N"}';

  it("names the provider and unwraps the JSON envelope", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      RAW_400,
      resolvers,
      { provider: "anthropic" }
    );
    expect(r.text).toBe(
      "Anthropic returned an error:\nYour credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
    );
  });

  it("unwraps a top-level JSON message", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_AUTH,
      '{"message":"API key expired"}',
      resolvers,
      { provider: "openai" }
    );
    expect(r.text).toBe("OpenAI API returned an error:\nAPI key expired");
  });

  it("relays a plain provider sentence unchanged apart from the label", async () => {
    // Non-JSON bodies are already human-readable; unwrapping must not mangle
    // them, and we must not double-report the status code.
    const plain =
      "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      plain,
      resolvers,
      { provider: "z-ai" }
    );
    expect(r.text).toBe(`z.ai returned an error:\n${plain}`);
  });

  it("falls back to the raw body when no provider is known", async () => {
    // errorContext is optional; with no provider there is nothing to label
    // with, and the old behaviour (relay verbatim) must still hold.
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      "429 slow down",
      resolvers
    );
    expect(r.text).toBe("429 slow down");
  });
});

describe("provider display names track the registry", () => {
  // The runtime avoids registry I/O, so pin every static/fallback label here.
  it("matches config/providers.json for every registered provider", async () => {
    const raw = readFileSync(
      resolve(__dirname, "../../../../../config/providers.json"),
      "utf8"
    );
    const registry: { providers: Array<{ id: string; name: string }> } =
      JSON.parse(raw);

    for (const p of registry.providers) {
      const rendered = await renderAgentError(
        AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
        "boom",
        resolveNothing,
        { provider: p.id }
      );
      expect(rendered.text).toBe(`${p.name} returned an error:\nboom`);
    }
  });
});
