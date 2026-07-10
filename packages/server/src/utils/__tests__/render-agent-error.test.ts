/**
 * renderAgentError is THE renderer every surface (Slack/Telegram bridge,
 * browser SSE) shares. These tests pin the code → (text, CTA) contract so the
 * same agent error reads identically everywhere — the thing that was NOT true
 * while four layers each formatted errors independently.
 */

import { describe, expect, it } from "vitest";
import { AgentErrorCode } from "@lobu/core";
import { type AgentErrorCtaResolvers, renderAgentError } from "../url-builder";

const SETTINGS_URL = "https://app.lobu.ai/acme/agents/agent-1/settings";
const CONNECT_URL = "https://app.lobu.ai/acme/inference-providers/new";

// Distinct resolvers per CTA kind, so a test can assert that a code routes to
// the RIGHT page (pick-a-model vs connect-a-provider), not just "some url".
const resolvers: AgentErrorCtaResolvers = {
  "agent-settings": async () => SETTINGS_URL,
  "provider-connect": async () => CONNECT_URL,
};
const resolveNothing: AgentErrorCtaResolvers = {
  "agent-settings": async () => null,
  "provider-connect": async () => null,
};

describe("renderAgentError", () => {
  it("provider quota RELAYS the provider's own message verbatim + routes to the CONNECT page", async () => {
    // The provider's message already says when the quota resets — we relay it
    // unchanged (no reset-time parsing, no reword) and only add the CTA link. A
    // quota/provider-level failure is fixed on the connect-a-provider page.
    const raw =
      "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      raw,
      resolvers
    );
    expect(r.text).toBe(raw);
    expect(r.ctaUrl).toBe(CONNECT_URL);
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
    expect(r.ctaUrl).toBe(CONNECT_URL);
  });

  it("auth failure relays the provider message + routes to the CONNECT page (not settings)", async () => {
    // PROVIDER_AUTH's cta kind is `provider-connect` — its fix is reconnecting
    // credentials, so it must land on the connect-a-provider page, NOT the
    // agent's model settings. This is the exact distinction the per-kind
    // resolver exists for (both kinds used to collapse to one URL).
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_AUTH,
      'Authentication failed for "openai"',
      resolvers
    );
    expect(r.text).toBe('Authentication failed for "openai"');
    expect(r.ctaUrl).toBe(CONNECT_URL);
    expect(r.ctaUrl).not.toBe(SETTINGS_URL);
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
    expect(r.ctaLabel).toBe("Connect a provider");
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
    // provider-connect resolver omitted → PROVIDER_AUTH renders text-only.
    const r = await renderAgentError(AgentErrorCode.PROVIDER_AUTH, "auth fail", {
      "agent-settings": async () => SETTINGS_URL,
    });
    expect(r.text).toBe("auth fail");
    expect(r.ctaUrl).toBeNull();
  });
});
