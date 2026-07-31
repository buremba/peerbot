/**
 * R7 BLOCK #1 layer (b): SlackInstructionProvider must NOT leak another tenant's
 * Slack identity. Identity now resolves from the signed `connectionId` rather
 * than an agent-scoped connection listing, so:
 *   - orgless/connection-less context ⇒ participation framing only, and no
 *     connection read at all (nothing to leak);
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
    connectionId: "conn-1",
    sessionKey: "u1",
    workingDirectory: "/workspace",
    availableProjects: [],
    ...overrides,
  };
}

describe("SlackInstructionProvider — cross-tenant guard", () => {
  test("orgless context: leaks no Slack identity and does NOT read connections", async () => {
    let getCalled = false;
    const manager = {
      getConnection: async () => {
        getCalled = true;
        return {
          metadata: { botUsername: "foreign-bot", botUserId: "UFOREIGN" },
        };
      },
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: undefined, connectionId: undefined })
    );

    // No connection read happened at all — nothing to leak.
    expect(getCalled).toBe(false);
    expect(result).not.toContain("foreign");
    // The participation framing is unconditional; only the handle is gated.
    expect(result).toContain("participant in this conversation");
  });

  test("org-present: reads connections INSIDE the token org and returns the identity", async () => {
    let seenOrg: string | undefined;
    const manager = {
      getConnection: async (_connectionId: string) => {
        // Capture the AMBIENT org the read runs under (must be the token org).
        seenOrg = orgContext.getStore()?.organizationId;
        return { metadata: { botUsername: "acme-bot", botUserId: "UACME" } };
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
