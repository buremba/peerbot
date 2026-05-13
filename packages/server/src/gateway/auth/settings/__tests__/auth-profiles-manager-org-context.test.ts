import { describe, expect, mock, test } from "bun:test";
import { orgContext, tryGetOrgId } from "../../../../lobu/stores/org-context.js";
import { AuthProfilesManager } from "../auth-profiles-manager.js";

const PROFILE = {
  id: "p1",
  provider: "z-ai",
  model: "*",
  authType: "api-key" as const,
  credentialRef: "secret://users/owner/agents/a1/auth-profiles/p1/credential",
  createdAt: 0,
};

function makeManager(opts: {
  ownerUserId?: string;
  organizationId?: string;
  ownerProfiles?: unknown[];
}) {
  const seenOrgs: Array<string | null> = [];
  const secretStore = {
    get: mock(async (_ref: string) => {
      seenOrgs.push(tryGetOrgId());
      return "resolved-secret-value";
    }),
    put: mock(async (name: string) => `secret://${name}`),
    delete: mock(async () => {}),
  };
  const manager = new AuthProfilesManager({
    ephemeralProfiles: { get: () => undefined } as never,
    declaredAgents: { get: () => undefined } as never,
    userAuthProfiles: {
      list: mock(async (uid: string) =>
        uid === opts.ownerUserId ? (opts.ownerProfiles ?? []) : []
      ),
    } as never,
    secretStore: secretStore as never,
    agentOwnerResolver: async () => opts.ownerUserId,
    agentOrgResolver: async () => opts.organizationId,
  });
  return { manager, secretStore, seenOrgs };
}

describe("AuthProfilesManager — org context for credential-ref reads", () => {
  test("wraps the secret read in the agent's org when no context is set (chat-webhook path)", async () => {
    expect(tryGetOrgId()).toBeNull(); // sanity: outside any org context
    const { manager, secretStore, seenOrgs } = makeManager({
      ownerUserId: "owner",
      organizationId: "org-A",
      ownerProfiles: [PROFILE],
    });

    const profiles = await manager.getProviderProfiles("a1", "z-ai", "run-user");

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.credential).toBe("resolved-secret-value");
    expect(secretStore.get).toHaveBeenCalledTimes(1);
    // the org-scoped credential is read inside the agent's org, not the global partition
    expect(seenOrgs).toEqual(["org-A"]);
  });

  test("honors an already-established org context (HTTP route / token-refresh job)", async () => {
    const { manager, seenOrgs } = makeManager({
      ownerUserId: "owner",
      organizationId: "org-A",
      ownerProfiles: [PROFILE],
    });

    await orgContext.run({ organizationId: "req-org" }, async () => {
      const profiles = await manager.getProviderProfiles(
        "a1",
        "z-ai",
        "run-user"
      );
      expect(profiles[0]?.credential).toBe("resolved-secret-value");
    });

    expect(seenOrgs).toEqual(["req-org"]); // caller's context wins, not overridden
  });

  test("falls through without org context when the agent's org can't be resolved", async () => {
    const { manager, seenOrgs } = makeManager({
      ownerUserId: "owner",
      organizationId: undefined, // resolver yields nothing
      ownerProfiles: [PROFILE],
    });

    const profiles = await manager.getProviderProfiles("a1", "z-ai", "run-user");

    expect(profiles[0]?.credential).toBe("resolved-secret-value");
    expect(seenOrgs).toEqual([null]);
  });
});
