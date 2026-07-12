/**
 * R7 BLOCK #1 layer (c): the class-root footgun. `listConnections` org-scopes
 * ONLY via ambient `tryGetOrgId()` and DROPS the org filter when there's no
 * ambient org. An AGENT-scoped list with no ambient org would return ANOTHER
 * tenant's rows for a shared agent id. The guard: an `agentId`-filtered call
 * with NO ambient org returns [] (never all-tenant rows). Unfiltered
 * (all-tenant) callers — reconcile loops, admin/list — pass no `agentId` and
 * are unaffected.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { createPostgresAgentConnectionStore } from "../../lobu/stores/postgres-stores.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_A = "org-a-listconn";
const ORG_B = "org-b-listconn";
const SHARED_AGENT = "lobu-builder";

let nextConnId = 5000;
async function seedChatConnection(org: string, agentId: string, slug: string) {
  const sql = getDb();
  // `id` is bigint; runtime metadata folds into `config.chatMetadata`;
  // `credential_mode IS NOT NULL` marks it a chat row (what listConnections filters on).
  await sql`
    INSERT INTO connections (
      id, organization_id, agent_id, connector_key, slug,
      credential_mode, config, status, created_at, updated_at
    ) VALUES (
      ${nextConnId++}, ${org}, ${agentId}, 'slack', ${slug},
      'managed', ${sql.json({ chatMetadata: { botUsername: `${org}-bot` } })},
      'active', now(), now()
    )
  `;
}

describe("listConnections — agent-scoped cross-tenant guard", () => {
  const store = createPostgresAgentConnectionStore();

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await orgContext.run({ organizationId: ORG_A }, async () => {
      await seedAgentRow(SHARED_AGENT, { organizationId: ORG_A });
    });
    await orgContext.run({ organizationId: ORG_B }, async () => {
      await seedAgentRow(SHARED_AGENT, { organizationId: ORG_B });
    });
    await seedChatConnection(ORG_A, SHARED_AGENT, "conn-a");
    await seedChatConnection(ORG_B, SHARED_AGENT, "conn-b");
  }, 60_000);

  test("agent-scoped list with NO ambient org returns [] (no cross-tenant rows)", async () => {
    // No orgContext.run — the orgless case a shared-id worker token produces.
    const rows = await store.listConnections({
      platform: "slack",
      agentId: SHARED_AGENT,
    });
    expect(rows).toEqual([]);
  });

  test("agent-scoped list INSIDE an org returns ONLY that org's rows", async () => {
    const rowsA = await orgContext.run({ organizationId: ORG_A }, () =>
      store.listConnections({ platform: "slack", agentId: SHARED_AGENT })
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.metadata?.botUsername).toBe(`${ORG_A}-bot`);

    const rowsB = await orgContext.run({ organizationId: ORG_B }, () =>
      store.listConnections({ platform: "slack", agentId: SHARED_AGENT })
    );
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.metadata?.botUsername).toBe(`${ORG_B}-bot`);
  });

  test("UNFILTERED (no agentId) list is unaffected — still returns all rows (reconcile/admin path)", async () => {
    // The reconcile loops / admin list legitimately read all tenants unscoped.
    const rows = await store.listConnections();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
