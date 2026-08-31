import { AgentErrorCode } from "@lobu/core";
import { describe, expect, test } from "bun:test";
import {
  automationToolIsPreApproved,
  isPermanentAutomationAgentError,
  preflightAutomationRun,
} from "../automation-run-preflight.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";

function catalog(options?: { credentials?: boolean; provider?: boolean }) {
  const provider = {
    providerId: "openai",
    hasSystemKey: () => false,
    hasCredentials: async () => options?.credentials ?? true,
    getProxyBaseUrlMappings: () => ({ openai: "https://proxy.test" }),
  };
  return {
    resolveDispatchModel: async () => ({
      model: "openai/gpt-5",
      replaced: false,
      modules: [],
      allowedRefs: null,
    }),
    findProviderForModel: async () =>
      options?.provider === false ? undefined : provider,
  } as unknown as ProviderCatalogService;
}

const base = {
  agentId: "agent-1",
  organizationId: "org-1",
  userId: "automation-1",
  requestedModel: "openai/gpt-5",
  preApprovedTools: ["/mcp/lobu-memory/tools/*"],
  proxyBaseUrl: "https://lobu.test/api/proxy",
};

describe("Automation run preflight", () => {
  test("classifies deterministic configuration walls but not transient quota", () => {
    expect(
      isPermanentAutomationAgentError(AgentErrorCode.NO_MODEL_CONFIGURED)
    ).toBe(true);
    expect(
      isPermanentAutomationAgentError(AgentErrorCode.PROVIDER_AUTH)
    ).toBe(true);
    expect(
      isPermanentAutomationAgentError(
        AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
      )
    ).toBe(false);
    expect(
      isPermanentAutomationAgentError(
        AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
        "Insufficient balance or no resource package",
      ),
    ).toBe(true);
    expect(
      isPermanentAutomationAgentError(
        AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
        "Quota exceeded; please retry in 25.137s",
      ),
    ).toBe(false);
    expect(
      isPermanentAutomationAgentError(AgentErrorCode.WORKER_DIED)
    ).toBe(false);
	expect(
	  isPermanentAutomationAgentError(
		undefined,
		"Headless Automation requires interactive approval",
	  ),
	).toBe(true);
  });

  test("accepts exact and wildcard standing tool approvals", () => {
    expect(
      automationToolIsPreApproved([
        "/mcp/lobu-memory/tools/run_sdk",
      ])
    ).toBe(true);
    expect(
      automationToolIsPreApproved(["/MCP/LOBU-MEMORY/TOOLS/*"])
    ).toBe(true);
    expect(automationToolIsPreApproved([])).toBe(false);
  });

  test("fails fast when no effective model exists", async () => {
    const result = await preflightAutomationRun({
      ...base,
      requestedModel: undefined,
      providerCatalog: catalog(),
    });
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: AgentErrorCode.NO_MODEL_CONFIGURED,
    });
  });

  test("fails fast when the effective model has no provider or credentials", async () => {
    const noProvider = await preflightAutomationRun({
      ...base,
      providerCatalog: catalog({ provider: false }),
    });
    expect(noProvider).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED,
    });

    const unauthorized = await preflightAutomationRun({
      ...base,
      providerCatalog: catalog({ credentials: false }),
    });
    expect(unauthorized).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: AgentErrorCode.PROVIDER_AUTH,
    });
	expect(unauthorized.ok ? "" : unauthorized.error).toContain(
	  "shared organization credential or API key"
	);
  });

  test("rejects a deterministic headless approval wall", async () => {
    const result = await preflightAutomationRun({
      ...base,
      preApprovedTools: [],
      providerCatalog: catalog(),
	  grantStore: {
		isExactDeniedStrict: async () => false,
	  },
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.error).toContain("interactive approval");
  });

  test("retries permission and catalog dependency failures", async () => {
    const noCatalog = await preflightAutomationRun(base);
    expect(noCatalog).toMatchObject({ ok: false, retryable: true });

    const grantOutage = await preflightAutomationRun({
      ...base,
      preApprovedTools: [],
      providerCatalog: catalog(),
      grantStore: {
		isExactDeniedStrict: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    expect(grantOutage).toMatchObject({ ok: false, retryable: true });
  });

  test("returns the resolved runnable model", async () => {
    const result = await preflightAutomationRun({
      ...base,
      providerCatalog: catalog(),
	  grantStore: {
		isExactDeniedStrict: async () => false,
	  },
    });
    expect(result).toEqual({ ok: true, model: "openai/gpt-5" });
  });

	test("does not require run_sdk approval for event turn execution", async () => {
		const result = await preflightAutomationRun({
			...base,
			completionRequired: false,
			preApprovedTools: [],
			providerCatalog: catalog(),
		});
		expect(result).toEqual({ ok: true, model: "openai/gpt-5" });
	});

	test("an exact durable deny overrides a configured wildcard", async () => {
	  const result = await preflightAutomationRun({
		...base,
		providerCatalog: catalog(),
		grantStore: {
		  isExactDeniedStrict: async () => true,
		},
	  });
	  expect(result).toMatchObject({ ok: false, retryable: false });
	  expect(result.ok ? "" : result.error).toContain("interactive approval");
	});
});
