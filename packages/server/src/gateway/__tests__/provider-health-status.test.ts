import { AgentErrorCode } from "@lobu/core";
import { describe, expect, test } from "bun:test";
import { classifyProviderHealthStatus } from "../proxy/provider-health-status.js";

describe("classifyProviderHealthStatus", () => {
  test("treats rate/quota rejection as quota exhaustion", () => {
    // 429 is what every vendor returns for "you are out of allowance", whatever
    // prose it wraps around it. Alibaba's token-plan wall and OpenAI's credit
    // wall both land here; neither matched the message patterns that preceded
    // this mapping.
    expect(classifyProviderHealthStatus(429)).toBe(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
    );
    // 402 Payment Required is the balance wall stated as a status.
    expect(classifyProviderHealthStatus(402)).toBe(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
    );
  });

  test("treats rejected credentials as an auth fault", () => {
    expect(classifyProviderHealthStatus(401)).toBe(AgentErrorCode.PROVIDER_AUTH);
    expect(classifyProviderHealthStatus(403)).toBe(AgentErrorCode.PROVIDER_AUTH);
  });

  test("reports no health signal for caller-fault statuses", () => {
    // The regression this guards: a malformed request or a typo'd model id must
    // never mark the provider unhealthy — the row is how the settings page
    // explains quiet Automations, and one bad caller must not label a healthy
    // provider broken.
    expect(classifyProviderHealthStatus(400)).toBeUndefined();
    expect(classifyProviderHealthStatus(404)).toBeUndefined();
    expect(classifyProviderHealthStatus(422)).toBeUndefined();
  });

  test("reports no health signal for upstream/server faults", () => {
    // A 500 or a gateway timeout is not evidence about the credential or the
    // account, and these are exactly the statuses that appear in transient
    // blips — marking on them would flap the row between error and active.
    expect(classifyProviderHealthStatus(500)).toBeUndefined();
    expect(classifyProviderHealthStatus(502)).toBeUndefined();
    expect(classifyProviderHealthStatus(503)).toBeUndefined();
  });

  test("reports no health signal for success statuses", () => {
    // Success is handled by the caller as an explicit clear, not by this map.
    expect(classifyProviderHealthStatus(200)).toBeUndefined();
    expect(classifyProviderHealthStatus(204)).toBeUndefined();
  });
});
