import { describe, expect, it } from "bun:test";
import { AUTOMATION_RUN_SOURCE } from "../../gateway/automation-run-session";
import { resolveAutomationVisibilityUserId } from "../../tools/get_content/handler";
import type { ToolContext } from "../../tools/registry";

function ctx(partial: Partial<ToolContext>): ToolContext {
  return {
    organizationId: "org",
    userId: "user_caller",
    memberRole: "owner",
    isAuthenticated: true,
    tokenType: "session",
    scopedToOrg: true,
    ...partial,
  };
}

describe("resolveAutomationVisibilityUserId", () => {
  it("returns the caller for interactive reads", () => {
    expect(resolveAutomationVisibilityUserId(ctx({}), 71)).toBe("user_caller");
  });

  it("returns null for a matching signed Automation run", () => {
    expect(
      resolveAutomationVisibilityUserId(
        ctx({
          actingAutomationId: 71,
          sourceContext: {
            source: AUTOMATION_RUN_SOURCE,
            conversationId: "personal-agent_automation_71_run_9",
          },
        }),
        71
      )
    ).toBeNull();
  });

  it("rejects an Automation run that requests another automation_id", () => {
    expect(() =>
      resolveAutomationVisibilityUserId(
        ctx({
          actingAutomationId: 71,
          sourceContext: {
            source: AUTOMATION_RUN_SOURCE,
            conversationId: "personal-agent_automation_71_run_9",
          },
        }),
        99
      )
    ).toThrow(/own automation_id/);
  });

  it("rejects an Automation-run marker without verified identity", () => {
    expect(() =>
      resolveAutomationVisibilityUserId(
        ctx({ sourceContext: { source: AUTOMATION_RUN_SOURCE } }),
        71
      )
    ).toThrow(/own automation_id/);
  });
});
