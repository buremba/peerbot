import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";
import { ChannelBindingService } from "../binding-service.js";

describe("ChannelBindingService connection-scoped routing", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";
  const CHANNEL = "slack:C123";
  let connectionA: number;
  let connectionA2: number;
  let previewConnection: number;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-a", { organizationId: ORG_A });
    await seedAgentRow("agent-a2", { organizationId: ORG_A });
    await seedAgentRow("agent-b", { organizationId: ORG_B });
    const sql = getDb();
    const rows = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, config
      ) VALUES
        (${ORG_A}, 'slack', 'agentconn-a', 'Slack A', 'active', 'byo', '{}'),
        (${ORG_A}, 'slack', 'agentconn-a2', 'Slack A2', 'active', 'byo', '{}'),
        (${ORG_B}, 'slack', 'agentconn-preview', 'Preview', 'active', 'managed', '{}')
      RETURNING id, slug
    `;
    connectionA = Number(rows.find((row) => row.slug === "agentconn-a")?.id);
    connectionA2 = Number(rows.find((row) => row.slug === "agentconn-a2")?.id);
    previewConnection = Number(
      rows.find((row) => row.slug === "agentconn-preview")?.id
    );
  });

  afterAll(async () => {
    await resetTestDatabase();
  });

  test("two bot connections in one workspace can bind the same channel independently", async () => {
    const svc = new ChannelBindingService();
    await svc.createBinding("agent-a", "slack", CHANNEL, "T1", {
      organizationId: ORG_A,
      connectionId: String(connectionA),
    });
    await svc.createBinding("agent-a2", "slack", CHANNEL, "T1", {
      organizationId: ORG_A,
      connectionId: String(connectionA2),
    });

    expect(
      (await svc.getBindingForConnection("a", CHANNEL, ORG_A))?.agentId
    ).toBe("agent-a");
    expect(
      (await svc.getBindingForConnection("a2", CHANNEL, ORG_A))?.agentId
    ).toBe("agent-a2");

    const rows = await getDb()`
      SELECT connection_id FROM agent_channel_bindings
      WHERE organization_id = ${ORG_A} AND channel_id = ${CHANNEL}
    `;
    expect(rows).toHaveLength(2);
  });

  test("re-linking one connection updates only that connection's agent", async () => {
    const svc = new ChannelBindingService();
    await svc.createBinding("agent-a", "slack", CHANNEL, "T1", {
      organizationId: ORG_A,
      connectionId: String(connectionA),
    });
    await svc.createBinding("agent-a2", "slack", CHANNEL, "T1", {
      organizationId: ORG_A,
      connectionId: String(connectionA),
    });

    expect(
      (await svc.getBindingForConnection("a", CHANNEL, ORG_A))?.agentId
    ).toBe("agent-a2");
    const rows = await getDb()`
      SELECT 1 FROM agent_channel_bindings
      WHERE organization_id = ${ORG_A}
        AND connection_id = ${connectionA}
        AND channel_id = ${CHANNEL}
    `;
    expect(rows).toHaveLength(1);
  });

  test("preview routing can resolve a binding owned by another org", async () => {
    const svc = new ChannelBindingService();
    await svc.createBinding("agent-a", "slack", CHANNEL, "T1", {
      organizationId: ORG_A,
      connectionId: String(previewConnection),
    });

    expect(
      await svc.getBindingForConnection("preview", CHANNEL, ORG_B)
    ).toBeNull();
    const binding = await svc.getBindingForConnection(
      "preview",
      CHANNEL,
      ORG_B,
      true
    );
    expect(binding?.agentId).toBe("agent-a");
    expect(binding?.organizationId).toBe(ORG_A);
  });
});
