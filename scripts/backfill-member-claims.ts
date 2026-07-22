#!/usr/bin/env bun

/**
 * One-time backfill of missing `$member` + `auth:signup` claims.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The authz channel-visibility gate resolves a signed-in user to their `$member`
 * entity via an `entity_identities` row (namespace `auth_user_id`, source
 * `auth:signup`, on a `$member` entity). The provisioning hooks that write that
 * claim only started doing so on 2026-06-28 (the ACL gate PR). Every better-auth
 * `member` row created before then has NO such claim, so the gate resolves those
 * users to nothing and hides every enforced channel from them.
 *
 * The forward path is now correct — this fills in the historical rows so those
 * users resolve, exactly as a fresh sign-up would. It is NOT a migration
 * (docs/MIGRATIONS.md: no scan inside the blocking Helm hook), and it is
 * cosmetic-safe to run post-deploy alongside live traffic.
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * For each `(user, org)` member row lacking the claim, it calls the SAME
 * `provisionMemberAndCoreIdentities` a real sign-up uses — which mints the
 * `$member` (by email) and writes `auth_user_id` + `email` claims, and now also
 * enforces the runtime invariant that `userId` must own `email`. No bespoke SQL
 * that could drift from the production write path.
 *
 * ─── The retarget hazard (why this is gated, read before running) ────────────
 * Backfilling a claim makes a previously-invisible org eligible for
 * `resolveTenantMember` (which drives WHERE a user's personal identity facts —
 * Google profile/contacts — get written). Before the personal-org-tag fix in
 * this same PR, `resolveTenantMember` picked the OLDEST private org with a
 * claim, so backfilling a claim into a SHARED org older than a user's personal
 * one would silently redirect their personal facts into that shared org.
 *
 * This script therefore skips any row where the target org is NOT the user's
 * tagged personal org AND is private (a shared-org backfill can only change
 * targeting, never fix a personal-org symptom). Run it only on a build that
 * includes the `personal_org_for_user_id`-first `resolveTenantMember`; the
 * `--include-shared` flag lifts the skip once you've confirmed that.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass `--execute` to actually write.
 *   - Idempotent: provisionMemberAndCoreIdentities is ON CONFLICT DO NOTHING, so
 *     a second run backfills 0 rows.
 *   - Per-row: a failure logs and continues (never aborts the whole batch).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   bun run scripts/backfill-member-claims.ts                  # dry-run
 *   bun run scripts/backfill-member-claims.ts --execute        # write
 *   bun run scripts/backfill-member-claims.ts --org <id>       # one org
 *   bun run scripts/backfill-member-claims.ts --include-shared # also shared orgs
 *
 * DATABASE_URL must point at the target database.
 */

import { provisionMemberAndCoreIdentities } from "../packages/server/src/auth/subject-identities";
import { getDb } from "../packages/server/src/db/client";

interface DriftRow {
  userId: string;
  organizationId: string;
  orgSlug: string;
  visibility: string;
  email: string | null;
  name: string | null;
  /** True when this org is explicitly tagged as the user's personal org. */
  isPersonal: boolean;
}

interface BackfillOptions {
  execute: boolean;
  org?: string;
  includeShared: boolean;
}

function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = { execute: false, includeShared: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") opts.execute = true;
    else if (a === "--include-shared") opts.includeShared = true;
    else if (a === "--org") opts.org = argv[++i];
  }
  return opts;
}

async function findDrift(org?: string): Promise<DriftRow[]> {
  const sql = getDb();
  const rows = await sql<{
    userId: string;
    organizationId: string;
    orgSlug: string;
    visibility: string;
    email: string | null;
    name: string | null;
    isPersonal: boolean;
  }>`
    SELECT
      m."userId"          AS "userId",
      m."organizationId"  AS "organizationId",
      o.slug              AS "orgSlug",
      o.visibility        AS visibility,
      u.email             AS email,
      u.name              AS name,
      (o.metadata::jsonb->>'personal_org_for_user_id' = m."userId") AS "isPersonal"
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    JOIN "user" u ON u.id = m."userId"
    WHERE NOT EXISTS (
      SELECT 1
      FROM entity_identities ei
      JOIN entities e
        ON e.id = ei.entity_id
       AND e.organization_id = ei.organization_id
       AND e.deleted_at IS NULL
      JOIN entity_types et
        ON et.id = e.entity_type_id
       AND et.organization_id = e.organization_id
       AND et.slug = '$member'
      WHERE ei.organization_id = m."organizationId"
        AND ei.namespace = 'auth_user_id'
        AND ei.identifier = m."userId"
        AND ei.source_connector = 'auth:signup'
        AND ei.deleted_at IS NULL
    )
    ${org ? sql`AND m."organizationId" = ${org}` : sql``}
    ORDER BY o."createdAt" ASC
  `;
  return rows;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("set DATABASE_URL");
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(2));
  const drift = await findDrift(opts.org);

  console.log(
    `Found ${drift.length} member row(s) without an auth:signup claim ` +
      `(${opts.execute ? "EXECUTE" : "DRY-RUN"}${opts.includeShared ? ", include-shared" : ""}).`
  );

  let backfilled = 0;
  let skippedShared = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  for (const row of drift) {
    // Retarget guard: writing a claim into a private, NON-personal (shared) org
    // can only change resolveTenantMember targeting, never fix a personal-org
    // symptom. Skip unless explicitly opted in on a targeting-safe build.
    if (
      !row.isPersonal &&
      row.visibility === "private" &&
      !opts.includeShared
    ) {
      skippedShared++;
      console.log(
        `  skip (shared private org) user=${row.userId} org=${row.orgSlug}`
      );
      continue;
    }
    if (!row.email) {
      skippedNoEmail++;
      console.log(`  skip (no email) user=${row.userId} org=${row.orgSlug}`);
      continue;
    }

    if (!opts.execute) {
      console.log(
        `  would backfill user=${row.userId} org=${row.orgSlug} email=${row.email}`
      );
      backfilled++;
      continue;
    }

    try {
      await provisionMemberAndCoreIdentities(row.organizationId, {
        userId: row.userId,
        email: row.email,
        name: row.name,
      });
      backfilled++;
      console.log(`  backfilled user=${row.userId} org=${row.orgSlug}`);
    } catch (err) {
      failed++;
      console.error(
        `  FAILED user=${row.userId} org=${row.orgSlug}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  console.log(
    `\nDone. ${opts.execute ? "backfilled" : "would backfill"}=${backfilled}` +
      ` skipped-shared=${skippedShared} skipped-no-email=${skippedNoEmail} failed=${failed}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

void main();
