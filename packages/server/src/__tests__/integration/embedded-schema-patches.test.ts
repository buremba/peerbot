/**
 * Regression test for the `scheduled-jobs` embedded schema patch.
 *
 * Issue lobu#787: on a real PGlite restart, the patch tries to re-add the
 * single-column FK `scheduled_jobs_agent_fkey → agents(id)` even though the
 * earlier `agents-per-org-pk-phase-c` patch has already swapped `agents` PK
 * to the composite `(organization_id, id)` and replaced this FK with
 * `scheduled_jobs_org_agent_fkey`. The second boot crashes with 42830
 * ("there is no unique constraint matching given keys for referenced table").
 *
 * This test mirrors the boot sequence: migrations run (via the global setup),
 * then EMBEDDED_SCHEMA_PATCHES run twice in a row against the same DB. The
 * second pass must be a no-op — no crash, no constraint drift.
 */

import { describe, expect, it } from 'vitest';
import { EMBEDDED_SCHEMA_PATCHES } from '../../db/embedded-schema-patches';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';

describe('embedded schema patches', () => {
  it('are idempotent across two consecutive boots (regression: lobu#787)', async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    // Migrations have already run via global-setup. The dbmate runner mirrors
    // the patch DDL, so the constraint landscape post-migration matches what
    // a long-lived embedded DB looks like after the first boot.

    // Sanity: after migrations, agents PK is composite (org, id) and
    // scheduled_jobs has the composite FK, not the single-column one.
    const constraintsBefore = (await sql.unsafe(`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('scheduled_jobs_agent_fkey', 'scheduled_jobs_org_agent_fkey')
    `)) as Array<{ conname: string }>;
    const namesBefore = new Set(constraintsBefore.map((r) => r.conname));
    expect(namesBefore.has('scheduled_jobs_org_agent_fkey')).toBe(true);
    expect(namesBefore.has('scheduled_jobs_agent_fkey')).toBe(false);

    // First post-migration run of embedded patches. With the fix, the
    // scheduled-jobs patch detects the composite FK is already installed and
    // skips re-adding the single-column FK.
    for (const patch of EMBEDDED_SCHEMA_PATCHES) {
      await patch.apply(sql as unknown as { unsafe: (...a: unknown[]) => Promise<unknown> });
    }

    // Second run — simulates a server restart against the same DB. This is
    // the path that crashes before the fix.
    for (const patch of EMBEDDED_SCHEMA_PATCHES) {
      await patch.apply(sql as unknown as { unsafe: (...a: unknown[]) => Promise<unknown> });
    }

    // Post-condition: composite FK still in place, single-column FK absent,
    // and agents PK is still the composite.
    const constraintsAfter = (await sql.unsafe(`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('scheduled_jobs_agent_fkey', 'scheduled_jobs_org_agent_fkey')
    `)) as Array<{ conname: string }>;
    const namesAfter = new Set(constraintsAfter.map((r) => r.conname));
    expect(namesAfter.has('scheduled_jobs_org_agent_fkey')).toBe(true);
    expect(namesAfter.has('scheduled_jobs_agent_fkey')).toBe(false);

    const pkDef = (await sql.unsafe(`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'agents'
        AND c.contype = 'p'
      LIMIT 1
    `)) as Array<{ def: string }>;
    expect(pkDef[0]?.def ?? '').toMatch(/organization_id/);
    expect(pkDef[0]?.def ?? '').toMatch(/\bid\b/);
  });
});
