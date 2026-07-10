/**
 * ChannelBindingService — per-org fence on agent-id-keyed reads/deletes.
 *
 * Lobu auto-provisions a per-org system agent whose id string is the SAME
 * across every org (`lobu-builder` exists as a row in ~20 orgs, disambiguated
 * only by `organization_id` — the agents PK is `(organization_id, id)`). So any
 * read/delete that keys on `agent_id` ALONE, without also fencing on org, would
 * smear one org's bindings into another org's view (a tenant-isolation bug).
 *
 * These pin the fence: `listBindings` / `deleteAllBindings` must be strictly
 * org-scoped, and must refuse to run org-less (the leaky fallback that returned
 * / deleted EVERY tenant's rows for a shared agent id is gone).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { ChannelBindingService } from "../../../gateway/channels/binding-service";
import { orgContext } from "../../../lobu/stores/org-context";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestOrganization } from "../../setup/test-fixtures";

const SHARED_AGENT_ID = "lobu-builder";

describe("ChannelBindingService org fence (agent_id shared across orgs)", () => {
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    const orgA = await createTestOrganization({ name: "Fence Org A" });
    const orgB = await createTestOrganization({ name: "Fence Org B" });
    orgAId = orgA.id;
    orgBId = orgB.id;

    // The SAME agent id in BOTH orgs — the real `lobu-builder` shape.
    await createTestAgent({ organizationId: orgAId, agentId: SHARED_AGENT_ID });
    await createTestAgent({ organizationId: orgBId, agentId: SHARED_AGENT_ID });

    // One binding per org, under that org's builder. connection_id is nullable;
    // we insert directly so the test doesn't need a full chat-connection graph.
    await sql`
      INSERT INTO agent_channel_bindings
        (organization_id, agent_id, platform, channel_id, team_id, created_at)
      VALUES
        (${orgAId}, ${SHARED_AGENT_ID}, 'slack', 'slack:CORGA', 'TA', now())
    `;
    await sql`
      INSERT INTO agent_channel_bindings
        (organization_id, agent_id, platform, channel_id, team_id, created_at)
      VALUES
        (${orgBId}, ${SHARED_AGENT_ID}, 'slack', 'slack:CORGB', 'TB', now())
    `;
  });

  afterAll(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM agent_channel_bindings WHERE organization_id IN (${orgAId}, ${orgBId})`;
  });

  it("listBindings returns ONLY the requested org's bindings, never a same-named agent's in another org", async () => {
    const svc = new ChannelBindingService();

    const aBindings = await svc.listBindings(SHARED_AGENT_ID, orgAId);
    expect(aBindings.map((b) => b.channelId).sort()).toEqual(["slack:CORGA"]);
    // The leak this pins: org B's channel must NOT appear in org A's listing.
    expect(aBindings.some((b) => b.channelId === "slack:CORGB")).toBe(false);

    const bBindings = await svc.listBindings(SHARED_AGENT_ID, orgBId);
    expect(bBindings.map((b) => b.channelId).sort()).toEqual(["slack:CORGB"]);
    expect(bBindings.some((b) => b.channelId === "slack:CORGA")).toBe(false);
  });

  it("deleteAllBindings only wipes the requested org's bindings — the other org's survive", async () => {
    const sql = getDb();
    const svc = new ChannelBindingService();

    const removed = await svc.deleteAllBindings(SHARED_AGENT_ID, orgAId);
    expect(removed).toBe(1);

    // Org B's binding is untouched.
    const surviving = await sql<{ channel_id: string }[]>`
      SELECT channel_id FROM agent_channel_bindings
      WHERE organization_id = ${orgBId} AND agent_id = ${SHARED_AGENT_ID}
    `;
    expect(surviving.map((r) => r.channel_id)).toEqual(["slack:CORGB"]);

    // Org A's is gone.
    const gone = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM agent_channel_bindings
      WHERE organization_id = ${orgAId} AND agent_id = ${SHARED_AGENT_ID}
    `;
    expect(Number(gone[0]?.n)).toBe(0);
  });

  it("refuses to run org-less: no explicit org AND no ambient org context throws (closes the cross-org leak)", async () => {
    const svc = new ChannelBindingService();
    // Outside any orgContext.run() and with no explicit org, the old code fell
    // back to a global `WHERE agent_id = …`. It must now throw instead.
    await expect(
      // @ts-expect-error — org is now REQUIRED; assert the runtime guard too.
      svc.listBindings(SHARED_AGENT_ID, undefined),
    ).rejects.toThrow(/requires organizationId/);
    await expect(
      // @ts-expect-error — org is now REQUIRED; assert the runtime guard too.
      svc.deleteAllBindings(SHARED_AGENT_ID, undefined),
    ).rejects.toThrow(/requires organizationId/);
  });

  it("ambient orgContext scopes the read when no explicit org is passed", async () => {
    const svc = new ChannelBindingService();
    // requireOrgId falls back to the AsyncLocalStorage org — so a request wrapped
    // in org B's context reading agent lobu-builder still only sees org B's rows.
    const bViaContext = await orgContext.run({ organizationId: orgBId }, () =>
      // @ts-expect-error — exercise the ambient-context path with org omitted.
      svc.listBindings(SHARED_AGENT_ID, undefined),
    );
    expect(bViaContext.map((b) => b.channelId)).toEqual(["slack:CORGB"]);
  });
});
