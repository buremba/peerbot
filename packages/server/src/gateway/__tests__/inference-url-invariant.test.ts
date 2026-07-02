import { beforeEach, describe, expect, mock, test } from "bun:test";

// The URL invariant is the security spine: when an org has a custom upstream,
// ONLY the org row's own key may be sent there — never a per-user profile or a
// deployment env key (credential exfiltration to a tenant-defined URL). This
// test mocks the store so it runs without a database and pins the three
// verdicts, especially the fail-closed one.

// The consolidated store resolver returns the text modality's config + key from
// one row read. resolveUrlInvariant applies the fail-closed policy on top.
let configResult: {
  baseUrl?: string;
  apiKey?: string;
  custom: boolean;
} | null = null;

mock.module("../../lobu/stores/provider-secrets.js", () => ({
  resolveInferenceProviderConfig: async () => configResult,
}));

const { resolveUrlInvariant } = await import("../auth/inference-invariant.js");

describe("resolveUrlInvariant", () => {
  beforeEach(() => {
    configResult = null;
  });

  test("no org context ⇒ no-custom-upstream (caller walks its normal chain)", async () => {
    const v = await resolveUrlInvariant("openai", undefined);
    expect(v.kind).toBe("no-custom-upstream");
  });

  test("no text block (static provider) ⇒ no-custom-upstream", async () => {
    configResult = null; // resolver returns null when no text block
    const v = await resolveUrlInvariant("openai", "org-1");
    expect(v.kind).toBe("no-custom-upstream");
  });

  test("text block without base_url ⇒ no-custom-upstream", async () => {
    configResult = { apiKey: "org-key", custom: false };
    const v = await resolveUrlInvariant("openai", "org-1");
    expect(v.kind).toBe("no-custom-upstream");
  });

  test("custom upstream + usable org key ⇒ org-only with key AND baseUrl from the same row", async () => {
    configResult = {
      baseUrl: "https://vllm.acme/v1",
      apiKey: "org-vllm-key",
      custom: true,
    };
    const v = await resolveUrlInvariant("openai-vllm", "org-1");
    expect(v.kind).toBe("org-only");
    if (v.kind === "org-only") {
      expect(v.credential).toBe("org-vllm-key");
      expect(v.baseUrl).toBe("https://vllm.acme/v1");
    }
  });

  test("custom upstream but MISSING org key ⇒ org-only-unavailable (fail CLOSED, no fallthrough)", async () => {
    configResult = {
      baseUrl: "https://vllm.acme/v1",
      apiKey: undefined, // key missing / undecryptable
      custom: true,
    };
    const v = await resolveUrlInvariant("openai-vllm", "org-1");
    // Critically NOT "no-custom-upstream": the caller must fail closed, never
    // fall through to a profile/env key bound for the tenant URL.
    expect(v.kind).toBe("org-only-unavailable");
  });
});
