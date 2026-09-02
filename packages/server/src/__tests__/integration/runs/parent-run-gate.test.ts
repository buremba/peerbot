/**
 * Semantics of the shared `parentRunGate` prelude.
 *
 * Six insert paths (agent ask, three admin manage_* tools, the connector queue,
 * and the entity-field approval writer) hang their child-run INSERT off this
 * one CTE. Their own suites cover the caller-level pre-checks that reject an
 * obviously dead parent with a message; this covers the layer underneath —
 * the `FOR SHARE` race guard that decides, at INSERT time, whether the row is
 * written at all. Nothing else asserts it, because from a caller's side a
 * refused insert looks like "zero rows returned" rather than a thrown error.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { parentRunGate } from "../../../runs/parent-run-gate";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("parentRunGate", () => {
  let orgId: string;
  let otherOrgId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const { a, b } = await TestWorkspace.pair();
    orgId = a.org.id;
    otherOrgId = b.org.id;
  });

  /** Insert a parent run of the given type/status and return its id. */
  async function seedParent(runType: string, status: string): Promise<number> {
    const [row] = await getTestDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, run_at)
      VALUES (${orgId}, ${runType}, ${status}, now())
      RETURNING id
    `;
    return Number(row.id);
  }

  /**
   * Run the gate exactly the way its callers do: an INSERT that selects
   * `FROM authorized_parent`, so a refused parent writes nothing at all.
   */
  async function insertChildUnderGate(
    parentRunId: number | null,
    options: { organizationId?: string; alsoEligibleForCompleted?: boolean } = {}
  ): Promise<number | null> {
    const sql = getDb();
    const organizationId = options.organizationId ?? orgId;
    const inserted = await sql<{ id: number }>`
      ${parentRunGate(sql, {
        parentRunId,
        organizationId,
        ...(options.alsoEligibleForCompleted
          ? { alsoEligible: sql`OR status = 'completed'` }
          : {}),
      })}
      INSERT INTO runs (organization_id, run_type, status, run_at, parent_run_id)
      SELECT ${organizationId}, 'internal', 'pending', now(), ${parentRunId}
      FROM authorized_parent
      LIMIT 1
      RETURNING id
    `;
    return inserted.length === 0 ? null : Number(inserted[0].id);
  }

  it("writes the child when no parent is declared", async () => {
    expect(await insertChildUnderGate(null)).not.toBeNull();
  });

  it("writes the child under a live Automation parent", async () => {
    for (const status of ["pending", "running", "claimed"]) {
      const parent = await seedParent("automation", status);
      expect(await insertChildUnderGate(parent)).not.toBeNull();
    }
  });

  it("refuses the child once its parent has terminalized", async () => {
    for (const status of ["completed", "failed", "cancelled", "timeout"]) {
      const parent = await seedParent("automation", status);
      expect(await insertChildUnderGate(parent)).toBeNull();
    }
  });

  it("refuses a parent that belongs to another org", async () => {
    const parent = await seedParent("automation", "running");
    // Same live parent row, read as the other tenant: the gate is what keeps a
    // cross-org parent_run_id from being adopted.
    expect(
      await insertChildUnderGate(parent, { organizationId: otherOrgId })
    ).toBeNull();
  });

  it("refuses a parent id that does not exist at all", async () => {
    expect(await insertChildUnderGate(2147483000)).toBeNull();
  });

  it("refuses a live parent whose run_type is not an Automation", async () => {
    const parent = await seedParent("chat_message", "running");
    expect(await insertChildUnderGate(parent)).toBeNull();
  });

  it("admits an otherwise-refused parent through alsoEligible", async () => {
    const parent = await seedParent("automation", "completed");
    expect(await insertChildUnderGate(parent)).toBeNull();
    expect(
      await insertChildUnderGate(parent, { alsoEligibleForCompleted: true })
    ).not.toBeNull();
  });
});
