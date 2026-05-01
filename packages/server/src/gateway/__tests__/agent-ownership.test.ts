import { describe, expect, test } from "bun:test";
import type { SettingsTokenPayload } from "../auth/settings/token-service.js";
import { verifyOwnedAgentAccess } from "../routes/shared/agent-ownership.js";

const makeSession = (
  overrides: Partial<SettingsTokenPayload> = {}
): SettingsTokenPayload => ({
  userId: "user-owner",
  oauthUserId: "user-owner",
  platform: "telegram",
  exp: Date.now() + 60_000,
  ...overrides,
});

const stubUserAgentsStore = (owner: {
  platform: string;
  userId: string;
  agentId: string;
}) => ({
  async ownsAgent(platform: string, userId: string, agentId: string) {
    return (
      platform === owner.platform &&
      userId === owner.userId &&
      agentId === owner.agentId
    );
  },
  async addAgent() {
    // no-op: only used for best-effort reconciliation in verifyOwnedAgentAccess
  },
});

const stubAgentMetadataStore = (
  owner: { platform: string; userId: string } | null
) => ({
  async getMetadata(_agentId: string) {
    return owner
      ? { owner: { platform: owner.platform, userId: owner.userId } }
      : null;
  },
});

describe("verifyOwnedAgentAccess (cross-tenant ownership)", () => {
  test("owner sees their own agent", async () => {
    const session = makeSession();
    const result = await verifyOwnedAgentAccess(session, "agent-1", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore({
        platform: "telegram",
        userId: "user-owner",
      }) as any,
    });
    expect(result.authorized).toBe(true);
  });

  test("cross-tenant user on same platform is rejected", async () => {
    const session = makeSession({
      userId: "user-attacker",
      oauthUserId: "user-attacker",
    });
    const result = await verifyOwnedAgentAccess(session, "agent-1", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore({
        platform: "telegram",
        userId: "user-owner",
      }) as any,
    });
    expect(result.authorized).toBe(false);
  });

  test("cross-platform user with the same userId is rejected", async () => {
    const session = makeSession({ platform: "slack" });
    const result = await verifyOwnedAgentAccess(session, "agent-1", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore({
        platform: "telegram",
        userId: "user-owner",
      }) as any,
    });
    expect(result.authorized).toBe(false);
  });

  test("agent-scoped session cannot access a different agent", async () => {
    const session = makeSession({ agentId: "agent-1" });
    const result = await verifyOwnedAgentAccess(session, "agent-2", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-2",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore({
        platform: "telegram",
        userId: "user-owner",
      }) as any,
    });
    expect(result.authorized).toBe(false);
  });

  test("admin session bypasses ownership", async () => {
    const session = makeSession({ isAdmin: true, userId: "any" });
    const result = await verifyOwnedAgentAccess(session, "agent-1", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore(null) as any,
    });
    expect(result.authorized).toBe(true);
  });

  test("unknown agent (no metadata) is rejected for non-admin", async () => {
    const session = makeSession({
      userId: "user-attacker",
      oauthUserId: "user-attacker",
    });
    const result = await verifyOwnedAgentAccess(session, "agent-unknown", {
      userAgentsStore: stubUserAgentsStore({
        platform: "telegram",
        userId: "user-owner",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore(null) as any,
    });
    expect(result.authorized).toBe(false);
  });

  test("external session with mismatched oauthUserId is rejected", async () => {
    const session = makeSession({
      platform: "external",
      userId: "u1",
      oauthUserId: "attacker-oauth",
    });
    const result = await verifyOwnedAgentAccess(session, "agent-1", {
      userAgentsStore: stubUserAgentsStore({
        platform: "external",
        userId: "owner-oauth",
        agentId: "agent-1",
      }) as any,
      agentMetadataStore: stubAgentMetadataStore({
        platform: "telegram",
        userId: "owner-oauth",
      }) as any,
    });
    expect(result.authorized).toBe(false);
  });
});
