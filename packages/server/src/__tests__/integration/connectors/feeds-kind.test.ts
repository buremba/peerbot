/**
 * feeds.kind — the 3-value kind that generalizes the `virtual` boolean
 * (collected | streaming | virtual). Pins: new feeds default to `collected`,
 * the migration backfills `virtual=true` → `kind='virtual'`, and the CHECK
 * rejects values outside the enum. The two-phase invariant (writers keep
 * `virtual` consistent until the readers move to `kind`) is enforced by the
 * creation paths in the streaming-feeds phase, not here.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("feeds.kind", () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const ws = await TestWorkspace.create({ name: "Feeds Kind Org" });
    orgId = ws.org.id;
  });

  it("new feeds default to collected", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "github",
    });
    const sql = getDb();
    const rows = await sql`
      SELECT kind FROM feeds WHERE connection_id = ${conn.id} LIMIT 1
    `;
    expect(rows[0]?.kind).toBe("collected");
  });

  it("backfills virtual=true to kind=virtual (migration's UPDATE)", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "github",
    });
    const sql = getDb();
    // Simulate a pre-existing virtual feed, then run the migration's backfill.
    await sql`UPDATE feeds SET virtual = TRUE WHERE connection_id = ${conn.id}`;
    await sql`UPDATE feeds SET kind = 'virtual' WHERE virtual IS TRUE AND kind <> 'virtual'`;
    const rows = await sql`
      SELECT virtual, kind FROM feeds WHERE connection_id = ${conn.id} LIMIT 1
    `;
    expect(rows[0]?.virtual).toBe(true);
    expect(rows[0]?.kind).toBe("virtual");
  });

  it("the CHECK rejects values outside the enum", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "github",
    });
    const sql = getDb();
    await expect(
      sql`UPDATE feeds SET kind = 'bogus' WHERE connection_id = ${conn.id}`
    ).rejects.toThrow(/feeds_kind_check/);
  });
});
