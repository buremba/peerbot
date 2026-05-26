/**
 * Cross-org isolation for Slack connection resolution in the gateway.
 *
 * The public `POST /slack/events` webhook (and `/api/v1/webhooks/:id`) carry
 * NO org context — `tryGetOrgId()` returns undefined there, so the
 * Postgres-backed `AgentConnectionStore.listConnections({platform:"slack"})`
 * returns EVERY org's Slack rows, not just the caller's. These tests pin that
 * an inbound event for org A's workspace resolves org A's connection (by
 * team_id) and that the no-team-match fallback never picks a foreign
 * tenant's (team-scoped) connection — which would let one tenant's bot act on
 * another tenant's Slack traffic with its own bot token (finding #4).
 *
 * Uses the embedded Postgres gateway test harness; no network.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Generous timeout: the first call cold-starts an embedded Postgres (initdb +
// start), which can exceed the 5s default on a loaded machine / in CI.
beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildManager() {
  const { ChatInstanceManager } = await import(
    "../chat-instance-manager.js"
  );
  const { createPostgresAgentConnectionStore } = await import(
    "../../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");
  const { orgContext } = await import("../../../lobu/stores/org-context.js");

  const connectionStore = createPostgresAgentConnectionStore();
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });

  const services = {
    getPublicGatewayUrl: () => "",
    getSecretStore: () => secretStore,
    getConnectionStore: () => connectionStore,
    getChannelBindingService: () => ({ getBinding: async () => null }),
    getCommandRegistry: () => undefined,
  } as any;

  const manager = new ChatInstanceManager() as any;
  // Wire the manager's collaborators directly (no full initialize() — we are
  // exercising the connection-resolution helpers, not adapter boot).
  manager.services = services;
  manager.publicGatewayUrl = "";
  manager.connectionStore = connectionStore;
  manager.slackCoordinator = manager.buildSlackCoordinator();

  return { manager, connectionStore, orgContext };
}

/** Seed a team-scoped Slack connection (an OAuth-installed workspace) in `orgId`. */
async function seedSlackConnection(
  connectionStore: any,
  orgContext: any,
  args: {
    orgId: string;
    agentId: string;
    connectionId: string;
    teamId: string;
    botToken: string;
  }
): Promise<void> {
  await seedAgentRow(args.agentId, { organizationId: args.orgId });
  await orgContext.run({ organizationId: args.orgId }, async () => {
    await connectionStore.saveConnection({
      id: args.connectionId,
      platform: "slack",
      agentId: args.agentId,
      organizationId: args.orgId,
      config: {
        platform: "slack",
        // Per-workspace tenant data only (post-#1065). The bot token is the
        // tenant secret that must never be borrowed across orgs.
        botToken: args.botToken,
      },
      settings: { allowGroups: true },
      metadata: { teamId: args.teamId },
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("multi-tenant gateway/connections — Slack routing isolation", () => {
  test("an inbound event for org A's team resolves org A's connection, not org B's", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    await seedSlackConnection(connectionStore, orgContext, {
      orgId: "org-A",
      agentId: "agent-A",
      connectionId: "conn-A",
      teamId: "TAAAA",
      botToken: "xoxb-org-A-token",
    });
    await seedSlackConnection(connectionStore, orgContext, {
      orgId: "org-B",
      agentId: "agent-B",
      connectionId: "conn-B",
      teamId: "TBBBB",
      botToken: "xoxb-org-B-token",
    });

    // No orgContext.run() — mirrors the public /slack/events webhook, which
    // has no ALS org id. The store therefore returns BOTH orgs' connections;
    // findConnectionByTeamId must still pick the right tenant by team_id.
    const resolvedForA = await manager.findSlackConnectionByTeamId("TAAAA");
    const resolvedForB = await manager.findSlackConnectionByTeamId("TBBBB");

    expect(resolvedForA).not.toBeNull();
    expect(resolvedForA!.id).toBe("conn-A");
    expect(resolvedForA!.organizationId).toBe("org-A");

    expect(resolvedForB).not.toBeNull();
    expect(resolvedForB!.id).toBe("conn-B");
    // The single hardest cross-tenant guarantee: org A's inbound event must
    // never resolve org B's connection (or vice versa).
    expect(resolvedForB!.id).not.toBe(resolvedForA!.id);
    expect(resolvedForB!.organizationId).toBe("org-B");
  });

  test("the no-team-match fallback never picks a foreign tenant's team-scoped connection", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    // Exactly one Slack connection exists, and it is team-scoped (belongs to a
    // specific tenant). A webhook we can't route by team_id (e.g.
    // url_verification) must NOT fall back to it — that would let an unrelated
    // tenant's traffic be handled by org A's bot/token. Fail closed instead.
    await seedSlackConnection(connectionStore, orgContext, {
      orgId: "org-A",
      agentId: "agent-A",
      connectionId: "conn-A",
      teamId: "TAAAA",
      botToken: "xoxb-org-A-token",
    });

    // Unknown team → no team match.
    const unknownTeam = await manager.findSlackConnectionByTeamId("TZZZZ");
    expect(unknownTeam).toBeNull();

    // The fallback used by handleAppWebhook must refuse the team-scoped row.
    const fallback = await manager.getDefaultSlackConnection();
    expect(fallback).toBeNull();
  });

  test("the no-team-match fallback returns the shared (non-team-scoped) preview connection", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    await seedAgentRow("agent-preview", { organizationId: "org-shared" });
    await orgContext.run({ organizationId: "org-shared" }, async () => {
      await connectionStore.saveConnection({
        id: "conn-preview",
        platform: "slack",
        agentId: "agent-preview",
        organizationId: "org-shared",
        config: { platform: "slack", botToken: "xoxb-preview" },
        settings: { allowGroups: true, previewMode: true },
        // No teamId → the hosted shared-app / preview connection.
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // A team-scoped tenant row coexists; the fallback must still pick the
    // non-team-scoped preview row, not the tenant row.
    await seedSlackConnection(connectionStore, orgContext, {
      orgId: "org-A",
      agentId: "agent-A",
      connectionId: "conn-A",
      teamId: "TAAAA",
      botToken: "xoxb-org-A-token",
    });

    const fallback = await manager.getDefaultSlackConnection();
    expect(fallback).not.toBeNull();
    expect(fallback!.id).toBe("conn-preview");
  });

  test("the no-team-match fallback refuses a non-preview org row with empty metadata", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    // A BYO connection created without an OAuth install carries no
    // metadata.teamId, yet it is still that org's tenant row (its own bot
    // token). Absence of teamId alone must NOT make it the shared default —
    // only the explicit previewMode marker does. Fail closed.
    await seedAgentRow("agent-byo", { organizationId: "org-byo" });
    await orgContext.run({ organizationId: "org-byo" }, async () => {
      await connectionStore.saveConnection({
        id: "conn-byo",
        platform: "slack",
        agentId: "agent-byo",
        organizationId: "org-byo",
        config: {
          platform: "slack",
          botToken: "xoxb-byo-tenant",
          signingSecret: "byo-signing",
        },
        // Not previewMode; empty metadata (no teamId).
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const fallback = await manager.getDefaultSlackConnection();
    expect(fallback).toBeNull();
  });
});
