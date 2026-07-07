/**
 * renderAgentError is THE renderer every surface (Slack/Telegram bridge,
 * browser SSE) shares. These tests pin the code → (text, CTA) contract so the
 * same agent error reads identically everywhere — the thing that was NOT true
 * while four layers each formatted errors independently.
 */

import { describe, expect, test } from "bun:test";
import { AgentErrorCode } from "@lobu/core";
import { renderAgentError } from "../url-builder";

const SETTINGS_URL = "https://app.lobu.ai/acme/agents/agent-1";
const resolveSettings = async () => SETTINGS_URL;
const resolveNothing = async () => null;

describe("renderAgentError", () => {
  test("provider quota renders the reset time + a settings CTA", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      { provider: "z-ai", resetAt: "2026-07-10 04:32 UTC" },
      resolveSettings
    );
    expect(r.text).toContain("z-ai");
    expect(r.text).toContain("used up");
    expect(r.text).toContain("2026-07-10 04:32 UTC");
    expect(r.ctaUrl).toBe(SETTINGS_URL);
    expect(r.ctaLabel).toBe("Manage provider");
    expect(r.silent).toBe(false);
  });

  test("quota without context is still a coherent generic message", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      undefined,
      resolveSettings
    );
    expect(r.text).toContain("Your AI provider");
    expect(r.text).not.toContain("undefined");
    expect(r.ctaUrl).toBe(SETTINGS_URL);
  });

  test("auth failure asks the user to reconnect with a CTA", async () => {
    const r = await renderAgentError(
      AgentErrorCode.PROVIDER_AUTH,
      { provider: "openai" },
      resolveSettings
    );
    expect(r.text.toLowerCase()).toContain("reconnect");
    expect(r.ctaUrl).toBe(SETTINGS_URL);
    expect(r.ctaLabel).toBe("Reconnect provider");
  });

  test("WORKER_UNRESPONSIVE has a message but NO CTA (resolver never called)", async () => {
    let called = false;
    const r = await renderAgentError(
      AgentErrorCode.WORKER_UNRESPONSIVE,
      undefined,
      async () => {
        called = true;
        return SETTINGS_URL;
      }
    );
    expect(r.text.toLowerCase()).toContain("try again");
    expect(r.ctaUrl).toBeNull();
    expect(called).toBe(false);
  });

  test("SESSION_TIMEOUT is silent", async () => {
    const r = await renderAgentError(
      AgentErrorCode.SESSION_TIMEOUT,
      undefined,
      resolveSettings
    );
    expect(r.silent).toBe(true);
  });

  test("a CTA code with an unresolvable URL degrades to text-only", async () => {
    const r = await renderAgentError(
      AgentErrorCode.NO_MODEL_CONFIGURED,
      undefined,
      resolveNothing
    );
    expect(r.text).toContain("No model");
    expect(r.ctaUrl).toBeNull();
  });
});
