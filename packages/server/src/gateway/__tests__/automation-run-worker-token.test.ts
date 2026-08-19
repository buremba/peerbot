import { describe, expect, test } from "bun:test";
import { verifyWorkerToken } from "@lobu/core";
import { buildAutomationRunWorkerAccess } from "../services/automation-run-worker-token.js";

describe("Automation run WorkerToken parity", () => {
  test("packs the canonical Automation conversation and tenant claims", () => {
    const access = buildAutomationRunWorkerAccess({
      agentId: "developer",
      automationId: 120,
      runId: 456,
      organizationId: "org-team",
    });
    expect(access.conversationId).toBe("developer_automation_120_run_456");
    const claims = verifyWorkerToken(access.token);
    expect(claims.agentId).toBe("developer");
    expect(claims.organizationId).toBe("org-team");
    expect(claims.conversationId).toBe(access.conversationId);
    expect(claims.channelId).toBe("api_automation_120");
    expect(claims.platform).toBe("api");
  });

  test("rejects a non-canonical conversation id", () => {
    expect(() =>
      buildAutomationRunWorkerAccess({
        agentId: "developer",
        automationId: 120,
        runId: 456,
        organizationId: "org-team",
        conversationId: "developer_other",
      })
    ).toThrow(/Automation conversation mismatch/);
  });
});
