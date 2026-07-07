/**
 * Regression: the output-guardrail scan must read agent settings scoped to the
 * caller's org. A shared agent id (e.g. "lobu-builder") exists in multiple orgs
 * and this runs on the worker path without ambient orgContext, so an unscoped
 * read could resolve another org's guardrails — enforcing (or skipping) the
 * wrong tenant's policy on a reply.
 */

import { describe, expect, test } from "bun:test";
import { GuardrailRegistry } from "@lobu/core";
import { OutputGuardrailScanner, runOutputGuardrailScan } from "../output-scan.js";
import type { AgentSettingsStore } from "../../auth/settings/agent-settings-store.js";

describe("runOutputGuardrailScan org scoping", () => {
  test("passes the caller's org into getSettings", async () => {
    const seen: Array<{ agentId: string; organizationId?: string }> = [];
    const settingsStore = {
      getSettings: async (
        agentId: string,
        context?: { organizationId?: string },
      ) => {
        seen.push({ agentId, organizationId: context?.organizationId });
        return { guardrails: [] } as any;
      },
    } as unknown as AgentSettingsStore;

    await runOutputGuardrailScan(
      new GuardrailRegistry(),
      settingsStore,
      "some reply text",
      {
        agentId: "lobu-builder",
        organizationId: "org-b",
        userId: "U1",
        platform: "slack",
      },
    );

    expect(seen).toEqual([
      { agentId: "lobu-builder", organizationId: "org-b" },
    ]);
  });

  test("hasOutputGuardrails passes the caller's org into getSettings", async () => {
    const seen: Array<{ agentId: string; organizationId?: string }> = [];
    const settingsStore = {
      getSettings: async (
        agentId: string,
        context?: { organizationId?: string },
      ) => {
        seen.push({ agentId, organizationId: context?.organizationId });
        return { guardrails: [] } as any;
      },
    } as unknown as AgentSettingsStore;

    const scanner = new OutputGuardrailScanner();
    scanner.setGuardrails(new GuardrailRegistry(), settingsStore);

    await scanner.hasOutputGuardrails("lobu-builder", "org-b");

    expect(seen).toEqual([
      { agentId: "lobu-builder", organizationId: "org-b" },
    ]);
  });
});
