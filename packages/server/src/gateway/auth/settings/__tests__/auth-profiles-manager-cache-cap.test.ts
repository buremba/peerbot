import { describe, expect, mock, test } from "bun:test";
import { AuthProfilesManager } from "../auth-profiles-manager.js";

/** Probes the bounded-cache invariant: even when the gateway sees many
 *  distinct one-shot agents, the agentOwner/agentOrg caches must not grow
 *  unbounded. Without the cap they would accumulate one entry per distinct
 *  agentId for the pod's lifetime (the existing TTL only refreshes values,
 *  not map size). Cap is 1024 — exercised at 2048 lookups. */
describe("AuthProfilesManager: bounded auth-resolver caches", () => {
  test("agentOwner cache stays bounded under many distinct one-shot lookups", async () => {
    const manager = new AuthProfilesManager({
      ephemeralProfiles: { get: () => undefined } as never,
      declaredAgents: { get: () => undefined } as never,
      userAuthProfiles: { list: mock(async () => []) } as never,
      secretStore: { get: mock(async () => undefined) } as never,
      agentOwnerResolver: async (id) => `owner-${id}`,
      agentOrgResolver: async (id) => `org-${id}`,
    });

    // 2048 distinct agentIds — twice the cap.
    for (let i = 0; i < 2048; i++) {
      // @ts-expect-error — exercising private resolver path via friend access
      await manager["resolveAgentOwnerUserId"](`agent-${i}`);
      // @ts-expect-error
      await manager["resolveAgentOrgId"](`agent-${i}`);
    }
    // @ts-expect-error
    expect(manager["agentOwnerCache"].size).toBeLessThanOrEqual(1024);
    // @ts-expect-error
    expect(manager["agentOrgCache"].size).toBeLessThanOrEqual(1024);
  });
});
