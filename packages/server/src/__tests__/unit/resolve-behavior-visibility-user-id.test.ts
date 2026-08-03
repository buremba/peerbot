import { describe, expect, it } from "bun:test";
import { BEHAVIOR_RUN_SOURCE } from "../../gateway/behavior-run-session";
import { resolveBehaviorVisibilityUserId } from "../../tools/get_content/handler";
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

describe("resolveBehaviorVisibilityUserId", () => {
  it("returns the caller for interactive reads", () => {
    expect(resolveBehaviorVisibilityUserId(ctx({}), 71)).toBe("user_caller");
  });

  it("returns null for a matching signed Behavior run", () => {
    expect(
      resolveBehaviorVisibilityUserId(
        ctx({
          actingBehaviorId: 71,
          sourceContext: {
            source: BEHAVIOR_RUN_SOURCE,
            conversationId: "personal-agent_behavior_71_run_9",
          },
        }),
        71
      )
    ).toBeNull();
  });

  it("rejects a Behavior run that requests another behavior_id", () => {
    expect(() =>
      resolveBehaviorVisibilityUserId(
        ctx({
          actingBehaviorId: 71,
          sourceContext: {
            source: BEHAVIOR_RUN_SOURCE,
            conversationId: "personal-agent_behavior_71_run_9",
          },
        }),
        99
      )
    ).toThrow(/own behavior_id/);
  });

  it("rejects a Behavior-run marker without verified identity", () => {
    expect(() =>
      resolveBehaviorVisibilityUserId(
        ctx({ sourceContext: { source: BEHAVIOR_RUN_SOURCE } }),
        71
      )
    ).toThrow(/own behavior_id/);
  });
});
