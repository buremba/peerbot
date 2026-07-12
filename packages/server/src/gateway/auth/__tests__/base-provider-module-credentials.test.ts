import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { encrypt } from "@lobu/core";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

// Controls what the mocked org context and db return per-test.
let mockOrgId: string | null = null;
let orgSharedSecretRows: Array<{ ciphertext: string }> = [];
let inferenceProviderRows: Array<{
  block: { base_url?: string; model?: string } | null;
  ciphertext: string | null;
}> = [];
// Rows returned for the row-unique `<slug>-<id>` secret lookup that
// `readOrgSharedProviderApiKey` performs against the org's live
// inference_providers row (the post-cutover write shape, issue #1868).
let rowKeyedSecretRows: Array<{ ciphertext: string }> = [];

// Mock the org-context AsyncLocalStorage lookup so we can simulate a worker
// request that does (or doesn't) carry an org.
mock.module("../../../lobu/stores/org-context.js", () => ({
  tryGetOrgId: () => mockOrgId,
  resolveOrgId: (explicit?: string | null) => explicit ?? mockOrgId,
  getOrgId: () => {
    if (!mockOrgId) throw new Error("no org");
    return mockOrgId;
  },
}));

// Mock the db client. `readOrgSharedProviderKey` uses the postgres tagged
// template (`sql\`SELECT ...\``); a tagged-template call invokes the function
// with (strings, ...values), so returning the rows array satisfies it.
mock.module("../../../db/client.js", () => ({
  PROD_PG_VALUE_OPTIONS: {},
  closeDbSingleton: async () => undefined,
  getDb: () => (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    // `resolveInferenceProviderConfig` selects `capabilities -> $mod AS block`;
    // the row-keyed secret read joins on api_key_ref without an AS block.
    if (query.includes("AS block")) return Promise.resolve(inferenceProviderRows);
    if (query.includes("FROM inference_providers"))
      return Promise.resolve(rowKeyedSecretRows);
    return Promise.resolve(orgSharedSecretRows);
  },
}));

// Import AFTER mocks so the module graph picks them up.
const { ApiKeyProviderModule } = await import("../api-key-provider-module.js");

function makeModule(hasProfile: boolean) {
  return new ApiKeyProviderModule({
    providerId: "z-ai",
    providerDisplayName: "z.ai",
    providerIconUrl: "https://example.com/z.png",
    envVarName: "Z_AI_API_KEY",
    apiKeyInstructions: "Get a key",
    apiKeyPlaceholder: "zai-...",
    sdkCompat: "openai",
    authProfilesManager: {
      hasProviderProfiles: async () => hasProfile,
      getBestProfile: async () => null,
    } as any,
  });
}

describe("BaseProviderModule.hasCredentials org-shared key fallback", () => {
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousZKey = process.env.Z_AI_API_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    // Ensure no system key influences the result — we test the org-shared path.
    delete process.env.Z_AI_API_KEY;
    mockOrgId = null;
    orgSharedSecretRows = [];
    inferenceProviderRows = [];
    rowKeyedSecretRows = [];
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (previousZKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = previousZKey;
  });

  test("returns true when a per-user auth profile exists", async () => {
    const mod = makeModule(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns true when only an org-shared API key exists (lobu apply path)", async () => {
    // No auth profile, but `lobu apply` wrote provider:z-ai:apiKey for the org.
    mockOrgId = "org-1";
    orgSharedSecretRows = [{ ciphertext: encrypt("zai-secret-value") }];

    const mod = makeModule(false);
    // Pass org explicitly (as the worker session-context path now does) and
    // also via the ALS fallback — both must resolve the org-shared key.
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns true when the org inference-provider row owns the custom upstream key", async () => {
    mockOrgId = "org-1";
    inferenceProviderRows = [
      {
        block: { base_url: "https://api.z.ai/api/paas/v4" },
        ciphertext: encrypt("zai-inference-provider-key"),
      },
    ];

    const mod = makeModule(false);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(true);
  });

  test("uses the org inference-provider key with the catalog upstream", async () => {
    mockOrgId = "org-1";
    inferenceProviderRows = [
      {
        block: { model: "glm-5.2" },
        ciphertext: encrypt("zai-inference-provider-key"),
      },
    ];

    const mod = makeModule(false);
    const context = { organizationId: "org-1" };
    expect(await mod.hasCredentials("agent-1", context)).toBe(true);
    expect(await mod.buildEnvVars("agent-1", {}, context)).toEqual({
      Z_AI_API_KEY: "zai-inference-provider-key",
    });
  });

  test("resolves the org key from a cutover-shape inference-provider row (no text block, row-unique secret)", async () => {
    // Post-cutover write shape (issue #1868): `lobu apply` creates an
    // inference_providers row with EMPTY capabilities plus a row-unique
    // `<slug>-<id>` secret — and no legacy provider:<id>:apiKey row at all.
    // `resolveInferenceProviderConfig` returns null for such a row (no text
    // block), so tier 2 (`readOrgSharedProviderApiKey`) must find the
    // row-keyed secret or apply-pushed keys silently stop working.
    mockOrgId = "org-1";
    inferenceProviderRows = []; // no text block ⇒ invariant: no-custom-upstream
    rowKeyedSecretRows = [{ ciphertext: encrypt("zai-row-unique-key") }];
    orgSharedSecretRows = []; // legacy name absent — nothing wrote it

    const mod = makeModule(false);
    const context = { organizationId: "org-1" };
    expect(await mod.hasCredentials("agent-1", context)).toBe(true);
    expect(await mod.buildEnvVars("agent-1", {}, context)).toEqual({
      Z_AI_API_KEY: "zai-row-unique-key",
    });
  });

  test("row-unique secret outranks a stale legacy provider:<id>:apiKey row", async () => {
    // Backfilled org: both names exist. Rotation only rewrites the row-unique
    // secret, so the read must prefer it over the stale legacy copy.
    mockOrgId = "org-1";
    rowKeyedSecretRows = [{ ciphertext: encrypt("fresh-rotated-key") }];
    orgSharedSecretRows = [{ ciphertext: encrypt("stale-legacy-key") }];

    const mod = makeModule(false);
    expect(await mod.buildEnvVars("agent-1", {}, { organizationId: "org-1" })).toEqual({
      Z_AI_API_KEY: "fresh-rotated-key",
    });
  });

  test("returns false when a custom upstream has no usable org key, even with a profile", async () => {
    inferenceProviderRows = [
      {
        block: { base_url: "https://custom.example.com/v1" },
        ciphertext: null,
      },
    ];

    const mod = makeModule(true);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(false);
  });

  test("credential placeholder uses signed worker token when available", async () => {
    const mod = makeModule(false);

    expect(
      await Promise.resolve(
        mod.buildCredentialPlaceholder("agent-1", { workerToken: "worker-jwt" })
      )
    ).toBe("worker-jwt");
    expect(await Promise.resolve(mod.buildCredentialPlaceholder("agent-1"))).toBe(
      "lobu-proxy"
    );
  });

  test("proxy base URL carries org scope when credential context has organizationId", () => {
    const mod = makeModule(false);

    const mappings = mod.getProxyBaseUrlMappings(
      "http://proxy.internal/api/proxy",
      "agent-1",
      { organizationId: "org-1", userId: "user-1" }
    );

    expect(mappings.Z_AI_API_BASE_URL).toBe(
      "http://proxy.internal/api/proxy/z-ai/a/agent-1/o/org-1/u/user-1"
    );
  });

  test("proxy base URL carries org scope without user segment when userId is absent", () => {
    const mod = makeModule(false);

    const mappings = mod.getProxyBaseUrlMappings(
      "http://proxy.internal/api/proxy",
      "agent-1",
      { organizationId: "org-1" }
    );

    expect(mappings.Z_AI_API_BASE_URL).toBe(
      "http://proxy.internal/api/proxy/z-ai/a/agent-1/o/org-1"
    );
  });

  test("returns false when neither profile nor org-shared key exists", async () => {
    mockOrgId = "org-1";
    orgSharedSecretRows = [];
    const mod = makeModule(false);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(false);
  });

  test("returns false when there is no org context and no profile", async () => {
    // No org id anywhere → org-shared lookup short-circuits, no db hit.
    mockOrgId = null;
    orgSharedSecretRows = [{ ciphertext: encrypt("should-not-be-read") }];
    const mod = makeModule(false);
    expect(await mod.hasCredentials("agent-1")).toBe(false);
  });
});
