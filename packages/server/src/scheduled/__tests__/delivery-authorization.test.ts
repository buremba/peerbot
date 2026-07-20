import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestBehaviorSubscription } from "../../__tests__/setup/behavior-subscriptions";
import { getDb } from "../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection";
import { validateDeliveryAuthorization } from "../scheduled-jobs-service";

const ORG = "org-delivery-authz";
const AGENT = "agent-delivery-authz";
const USER = "user-delivery-authz";
const CONN = "slackinst-delivery-authz";
const CHANNEL = "C-delivery-authz";

async function seedAgentlessSlackConnection(externalTenantId: string | null) {
  const sql = getDb();
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, external_tenant_id, agent_id,
      display_name, status, config, credential_mode, slug, visibility
    ) VALUES (
      ${ORG}, 'slack', ${externalTenantId}, NULL,
      'Agentless slack', 'active', ${sql.json({})}, 'byo',
      ${runtimeConnectionIdToSlug(CONN)}, 'org'
    )
  `;
}

function delivery(overrides?: {
  teamId?: string | null;
  channelId?: string;
}) {
  return {
    platform: "slack",
    connectionId: CONN,
    channelId: overrides?.channelId ?? CHANNEL,
    conversationId: `slack:${overrides?.channelId ?? CHANNEL}:123`,
    teamId: overrides?.teamId,
    userId: USER,
  };
}

describe("validateDeliveryAuthorization team predicate", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT, { organizationId: ORG, ownerUserId: USER });
    await getDb()`
      INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
      VALUES (${USER}, 'delivery-authz@example.test', 'Authz User', 'delivery-authz', true, NOW(), NOW())
    `;
  }, 60_000);

  test("authorizes delivery with no teamId when trigger has no team but connection has external_tenant_id", async () => {
    // Regression: behavior_message_subscriptions.team_id is
    // COALESCE(trigger match, connections.external_tenant_id, config teamId).
    // A legacy binding with no trigger team constraint used to match via
    // team_id IS NULL; after the COALESCE fallback the same row has a non-null
    // team_id and must still authorize deliveries that carry no teamId.
    await seedAgentlessSlackConnection("T-workspace");
    await createTestBehaviorSubscription({
      organizationId: ORG,
      agentId: AGENT,
      connectionSlug: runtimeConnectionIdToSlug(CONN),
      platform: "slack",
      channelId: CHANNEL,
      // no teamId → trigger_team_id NULL; view team_id falls back to T-workspace
      configuredBy: USER,
    });

    const viewRows = await getDb()`
      SELECT team_id, trigger_team_id
      FROM behavior_message_subscriptions
      WHERE organization_id = ${ORG}
        AND platform = 'slack'
        AND native_channel_id = ${CHANNEL}
      LIMIT 1
    `;
    expect(viewRows[0].trigger_team_id).toBeNull();
    expect(viewRows[0].team_id).toBe("T-workspace");

    const result = await validateDeliveryAuthorization({
      organizationId: ORG,
      agentId: AGENT,
      delivery: delivery({ teamId: undefined }),
    });
    expect(result).toEqual({ authorized: true });
  });

  test("denies delivery when teamId does not match trigger or resolved team", async () => {
    await seedAgentlessSlackConnection("T-workspace");
    await createTestBehaviorSubscription({
      organizationId: ORG,
      agentId: AGENT,
      connectionSlug: runtimeConnectionIdToSlug(CONN),
      platform: "slack",
      channelId: CHANNEL,
      teamId: "T-workspace",
      configuredBy: USER,
    });

    const result = await validateDeliveryAuthorization({
      organizationId: ORG,
      agentId: AGENT,
      delivery: delivery({ teamId: "T-other" }),
    });
    expect(result).toEqual({
      authorized: false,
      reason: "channel-unbound",
    });
  });

  test("authorizes team-scoped delivery when delivery teamId matches resolved team_id", async () => {
    await seedAgentlessSlackConnection("T-workspace");
    await createTestBehaviorSubscription({
      organizationId: ORG,
      agentId: AGENT,
      connectionSlug: runtimeConnectionIdToSlug(CONN),
      platform: "slack",
      channelId: CHANNEL,
      teamId: "T-workspace",
      configuredBy: USER,
    });

    const result = await validateDeliveryAuthorization({
      organizationId: ORG,
      agentId: AGENT,
      delivery: delivery({ teamId: "T-workspace" }),
    });
    expect(result).toEqual({ authorized: true });
  });
});
