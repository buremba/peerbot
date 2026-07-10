/**
 * R7 BLOCK #1 layer (b): SlackInstructionProvider must NOT leak another tenant's
 * Slack identity. Its `listConnections` read is agent-scoped and — without an
 * ambient org — would return ANOTHER org's newest Slack connection for a shared
 * agent id (foreign botUsername/botUserId). So:
 *   - orgless context ⇒ "" (no identity without an org);
 *   - org-present ⇒ the read runs INSIDE the token org (orgContext.run).
 */

import { describe, expect, test } from "bun:test";
import type { InstructionContext } from "@lobu/core";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { SlackInstructionProvider } from "../slack-instruction-provider.js";

function ctx(overrides: Partial<InstructionContext>): InstructionContext {
  return {
    userId: "u1",
    agentId: "lobu-builder",
    sessionKey: "u1",
    workingDirectory: "/workspace",
    availableProjects: [],
    ...overrides,
  };
}

describe("SlackInstructionProvider — cross-tenant guard", () => {
  test("orgless context: returns '' (no Slack identity leaked) and does NOT read connections", async () => {
    let listCalled = false;
    const manager = {
      listConnections: async () => {
        listCalled = true;
        return [
          { metadata: { botUsername: "foreign-bot", botUserId: "UFOREIGN" } },
        ];
      },
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: undefined })
    );

    expect(result).toBe("");
    // No connection read happened at all — nothing to leak.
    expect(listCalled).toBe(false);
  });

  test("org-present: reads connections INSIDE the token org and returns the identity", async () => {
    let seenOrg: string | undefined;
    const manager = {
      listConnections: async (_filter: unknown) => {
        // Capture the AMBIENT org the read runs under (must be the token org).
        seenOrg = orgContext.getStore()?.organizationId;
        return [
          { metadata: { botUsername: "acme-bot", botUserId: "UACME" } },
        ];
      },
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme-org" })
    );

    expect(seenOrg).toBe("acme-org");
    expect(result).toContain("@acme-bot");
    expect(result).toContain("UACME");
    expect(result).not.toContain("foreign");
  });
});
