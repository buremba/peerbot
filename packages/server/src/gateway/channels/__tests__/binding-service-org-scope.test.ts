/**
 * Red→green reproducer: cross-tenant channel-binding takeover.
 *
 * Pre-fix the `agent_channel_bindings` uniqueness was GLOBAL —
 *   UNIQUE (platform, channel_id, team_id)
 *   + partial UNIQUE (platform, channel_id) WHERE team_id IS NULL
 * — with no `organization_id` in the key. `createBinding` then did
 * `ON CONFLICT (...) DO UPDATE SET agent_id = EXCLUDED.agent_id,
 * organization_id = EXCLUDED.organization_id`. So a second org binding the
 * SAME platform+channel collided with the first org's row and rewrote its
 * `organization_id` (and `agent_id`) to itself: a silent cross-tenant
 * takeover, and org A's binding vanished.
 *
 * Post-fix the constraint is org-scoped
 *   UNIQUE (organization_id, platform, channel_id, team_id)
 *   + partial UNIQUE (organization_id, platform, channel_id) WHERE team_id IS NULL
 * the ON CONFLICT targets include `organization_id`, and the SET list no
 * longer reassigns `organization_id`. Two orgs may now bind the same
 * platform+channel independently and neither can clobber the other.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";
import { resolveAgentId } from "../../services/platform-helpers.js";
import { ChannelBindingService } from "../binding-service.js";

describe("ChannelBindingService is org-scoped (no cross-tenant takeover)", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";
  const AGENT_A = "agent-a";
  const AGENT_B = "agent-b";
  const PLATFORM = "slack";
  const CHANNEL = "C123";

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT_A, { organizationId: ORG_A });
    await seedAgentRow(AGENT_B, { organizationId: ORG_B });
  });

  afterAll(async () => {
    await resetTestDatabase();
  });

  test("team_id IS NULL: org B binding the same channel cannot steal org A's binding", async () => {
    const svc = new ChannelBindingService();

    // Org A binds (slack, C123) to its agent.
    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_A,
    });
    // Org B binds the SAME (slack, C123) to ITS agent. Pre-fix this hit the
    // global partial-unique index and rewrote org A's row to org B.
    await svc.createBinding(AGENT_B, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_B,
    });

    // Org A's binding must survive untouched.
    const aBinding = await svc.getBinding(PLATFORM, CHANNEL, undefined, ORG_A);
    expect(aBinding?.agentId).toBe(AGENT_A);

    // Org B has its own, independent binding.
    const bBinding = await svc.getBinding(PLATFORM, CHANNEL, undefined, ORG_B);
    expect(bBinding?.agentId).toBe(AGENT_B);

    // Two distinct rows exist, each owned by its own org — no row was
    // reassigned across tenants.
    const sql = getDb();
    const rows = await sql`
      SELECT organization_id, agent_id FROM agent_channel_bindings
      WHERE platform = ${PLATFORM} AND channel_id = ${CHANNEL} AND team_id IS NULL
      ORDER BY organization_id
    `;
    expect(rows.length).toBe(2);
    expect(rows[0].organization_id).toBe(ORG_A);
    expect(rows[0].agent_id).toBe(AGENT_A);
    expect(rows[1].organization_id).toBe(ORG_B);
    expect(rows[1].agent_id).toBe(AGENT_B);
  });

  test("team_id set: org B binding the same channel/team cannot steal org A's binding", async () => {
    const svc = new ChannelBindingService();
    const TEAM = "T999";

    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_A,
    });
    await svc.createBinding(AGENT_B, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_B,
    });

    const aBinding = await svc.getBinding(PLATFORM, CHANNEL, TEAM, ORG_A);
    expect(aBinding?.agentId).toBe(AGENT_A);

    const bBinding = await svc.getBinding(PLATFORM, CHANNEL, TEAM, ORG_B);
    expect(bBinding?.agentId).toBe(AGENT_B);

    const sql = getDb();
    const rows = await sql`
      SELECT organization_id, agent_id FROM agent_channel_bindings
      WHERE platform = ${PLATFORM} AND channel_id = ${CHANNEL} AND team_id = ${TEAM}
      ORDER BY organization_id
    `;
    expect(rows.length).toBe(2);
    expect(rows[0].organization_id).toBe(ORG_A);
    expect(rows[1].organization_id).toBe(ORG_B);
  });

  test("same org re-binding the same channel still updates agent in place (upsert preserved)", async () => {
    const svc = new ChannelBindingService();
    const AGENT_A2 = "agent-a2";
    await seedAgentRow(AGENT_A2, { organizationId: ORG_A });

    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_A,
    });
    // Re-bind within the SAME org to a different agent — must overwrite, not
    // create a second row.
    await svc.createBinding(AGENT_A2, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_A,
    });

    const binding = await svc.getBinding(PLATFORM, CHANNEL, undefined, ORG_A);
    expect(binding?.agentId).toBe(AGENT_A2);

    const sql = getDb();
    const rows = await sql`
      SELECT 1 FROM agent_channel_bindings
      WHERE organization_id = ${ORG_A} AND platform = ${PLATFORM}
        AND channel_id = ${CHANNEL} AND team_id IS NULL
    `;
    expect(rows.length).toBe(1);
  });

  // Read-path regression: now that two orgs can bind the same channel, the
  // inbound router (resolveAgentId) MUST scope its getBinding by the inbound
  // connection's org. Without it the lookup is org-less and routes the message
  // to whichever tenant's row Postgres returns first — a cross-tenant misroute.
  test("resolveAgentId routes each org to its OWN agent for a shared channel", async () => {
    const svc = new ChannelBindingService();
    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_A,
    });
    await svc.createBinding(AGENT_B, PLATFORM, CHANNEL, undefined, {
      organizationId: ORG_B,
    });

    const a = await resolveAgentId({
      platform: PLATFORM,
      channelId: CHANNEL,
      organizationId: ORG_A,
      channelBindingService: svc,
    });
    const b = await resolveAgentId({
      platform: PLATFORM,
      channelId: CHANNEL,
      organizationId: ORG_B,
      channelBindingService: svc,
    });

    // Distinct, org-correct agents. Pre-fix (org-less read) both calls return
    // the same arbitrary row, so they cannot both match their distinct orgs.
    expect(a?.agentId).toBe(AGENT_A);
    expect(b?.agentId).toBe(AGENT_B);
  });

  // Preview exception: the hosted preview bot is ONE connection (in its own
  // org) that fans out to agents in OTHER orgs — `/lobu link <code>` binds
  // under the claim's org, not the connection's. The org-scoped read can never
  // find that binding, so a linked chat keeps getting "isn't linked". The fix:
  // previewMode resolves org-agnostically and routes by the binding's own org.
  test("getBindingAnyOrg finds a binding regardless of caller org, with its org", async () => {
    const svc = new ChannelBindingService();
    const TEAM = "T999";
    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_A,
    });

    // Org-scoped read from a DIFFERENT org (the preview connection's org) misses.
    expect(await svc.getBinding(PLATFORM, CHANNEL, TEAM, ORG_B)).toBeNull();

    // Org-agnostic read finds it AND surfaces the binding's owning org.
    const any = await svc.getBindingAnyOrg(PLATFORM, CHANNEL, TEAM);
    expect(any?.agentId).toBe(AGENT_A);
    expect(any?.organizationId).toBe(ORG_A);
  });

  test("resolveAgentId crossOrg routes a preview connection to the bound agent's org", async () => {
    const svc = new ChannelBindingService();
    const TEAM = "T999";
    // Agent A's chat is linked under ORG_A.
    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_A,
    });

    // A message arrives on a previewMode connection owned by ORG_B.
    // Without crossOrg the org-scoped read misses -> falls back to the
    // connection's owning agent (here none) -> drops/"isn't linked".
    const scoped = await resolveAgentId({
      platform: PLATFORM,
      channelId: CHANNEL,
      teamId: TEAM,
      organizationId: ORG_B,
      channelBindingService: svc,
    });
    expect(scoped).toBeNull();

    // With crossOrg it resolves to A's agent and returns A's org for routing.
    const cross = await resolveAgentId({
      platform: PLATFORM,
      channelId: CHANNEL,
      teamId: TEAM,
      organizationId: ORG_B,
      channelBindingService: svc,
      crossOrg: true,
    });
    expect(cross?.agentId).toBe(AGENT_A);
    expect(cross?.source).toBe("binding");
    expect(cross?.organizationId).toBe(ORG_A);
  });

  test("getBindingAnyOrg reflects the most recent re-link (created_at bumps on upsert)", async () => {
    const svc = new ChannelBindingService();
    const TEAM = "T999";
    const AGENT_A2 = "agent-a2";
    await seedAgentRow(AGENT_A2, { organizationId: ORG_A });

    // Org A binds, then org B binds the same physical channel (newer row),
    // then org A RE-LINKS to a different agent. getBindingAnyOrg orders by
    // created_at, so the re-link MUST bump created_at past org B's row —
    // otherwise the channel resolves to the stale (org B) binding.
    await svc.createBinding(AGENT_A, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_A,
    });
    await svc.createBinding(AGENT_B, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_B,
    });
    await svc.createBinding(AGENT_A2, PLATFORM, CHANNEL, TEAM, {
      organizationId: ORG_A,
    });

    const any = await svc.getBindingAnyOrg(PLATFORM, CHANNEL, TEAM);
    expect(any?.agentId).toBe(AGENT_A2);
    expect(any?.organizationId).toBe(ORG_A);

    const resolved = await resolveAgentId({
      platform: PLATFORM,
      channelId: CHANNEL,
      teamId: TEAM,
      organizationId: ORG_B,
      channelBindingService: svc,
      crossOrg: true,
    });
    expect(resolved?.agentId).toBe(AGENT_A2);
    expect(resolved?.organizationId).toBe(ORG_A);
  });
});
