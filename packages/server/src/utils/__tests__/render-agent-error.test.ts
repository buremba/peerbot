/**
 * renderAgentError is THE renderer every surface (Slack/Telegram bridge,
 * browser SSE) shares. These tests pin the code → (text, CTA) contract so the
 * same agent error reads identically everywhere — the thing that was NOT true
 * while four layers each formatted errors independently.
 */

import { describe, expect, it } from "vitest";
import { AgentErrorCode } from "@lobu/core";
import { renderAgentError } from "../url-builder";

const SETTINGS_URL = "https://app.lobu.ai/acme/agents/agent-1";
const resolveSettings = async () => SETTINGS_URL;
const resolveNothing = async () => null;

describe("renderAgentError", () => {
  it("provider quota RELAYS the provider's own message verbatim + a settings CTA", async () => {
    // The provider's message already says when the quota resets — we relay it
    // unchanged (no reset-time parsing, no reword) and only add the CTA link.
    const raw =
      "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      raw,
      resolveSettings
    );
    expect(r.text).toBe(raw);
    expect(r.ctaUrl).toBe(SETTINGS_URL);
    expect(r.ctaLabel).toBe("Manage provider");
    expect(r.silent).toBe(false);
  });

  it("provider error with no relayed message renders empty text but keeps the CTA", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      undefined,
      resolveSettings
    );
    expect(r.text).toBe("");
    expect(r.ctaUrl).toBe(SETTINGS_URL);
  });

  it("auth failure relays the provider message + a reconnect CTA", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_AUTH,
      'Authentication failed for "openai"',
      resolveSettings
    );
    expect(r.text).toBe('Authentication failed for "openai"');
    expect(r.ctaUrl).toBe(SETTINGS_URL);
    expect(r.ctaLabel).toBe("Reconnect provider");
  });

  it("WORKER_UNRESPONSIVE uses OUR catalog text (no provider message) and NO CTA", async () => {
    let called = false;
    const r = await renderAgentError(
      AgentErrorCode.WORKER_UNRESPONSIVE,
      // Even if a stray message is passed, a synthesized error prefers its own
      // catalog text.
      "some raw string",
      async () => {
        called = true;
        return SETTINGS_URL;
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
      resolveSettings
    );
    expect(r.silent).toBe(true);
  });

  it("a synthesized CTA code with an unresolvable URL degrades to text-only", async () => {
    const r = await renderAgentError(
      AgentErrorCode.NO_MODEL_CONFIGURED,
      undefined,
      resolveNothing
    );
    expect(r.text).toContain("No model");
    expect(r.ctaUrl).toBeNull();
  });
});
