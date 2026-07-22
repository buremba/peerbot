#!/usr/bin/env bun

/**
 * One-time backfill of missing `$member` + `auth:signup` claims.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The authz channel-visibility gate resolves a signed-in user to their `$member`
 * entity via an `entity_identities` row (namespace `auth_user_id`, source
 * `auth:signup`, on a `$member` entity). The provisioning hooks that write that
 * claim only started doing so on 2026-06-28 (the ACL gate PR). Older member rows
 * that have not passed through provisioning again can therefore lack the claim,
 * making every enforced channel invisible to those users.
 *
 * The forward path is now correct — this fills in the historical rows so those
 * users resolve, exactly as a fresh sign-up would. It is NOT a migration
 * (docs/MIGRATIONS.md: no scan inside the blocking Helm hook).
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
 *   - Idempotent for healable rows: a second run finds no repaired rows.
 *   - Refuses rows where another live auth_user_id claim blocks the repair.
 *   - Per-row: a failure logs and continues (never aborts the whole batch).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   bun run scripts/backfill-member-claims.ts                  # dry-run
 *   bun run scripts/backfill-member-claims.ts --execute        # write
 *   bun run scripts/backfill-member-claims.ts --org <id>       # one org
 *   bun run scripts/backfill-member-claims.ts --include-shared # include private shared orgs
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { provisionMemberAndCoreIdentities } from "../packages/server/src/auth/subject-identities";
import { getDb } from "../packages/server/src/db/client";

interface DriftRow {
  userId: string;
  organizationId: string;
  orgSlug: string;
  visibility: string;
  email: string | null;
  name: string | null;
  /** The member row's actual better-auth role, so a drifted non-owner is not
   * minted as an owner when its $member entity is created fresh. */
  role: string;
  /** True when this org is explicitly tagged as the user's personal org. */
  isPersonal: boolean;
  /** A live auth_user_id row that prevents the correct claim from being inserted. */
  hasBlockingClaim: boolean;
}

interface BackfillOptions {
  execute: boolean;
  org?: string;
  includeShared: boolean;
}

function parseArgs(argv: string[]): BackfillOptions {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      execute: { type: "boolean" },
      org: { type: "string" },
      "include-shared": { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    execute: values.execute ?? false,
    includeShared: values["include-shared"] ?? false,
    ...(values.org ? { org: values.org } : {}),
  };
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
    role: string;
    isPersonal: boolean;
    hasBlockingClaim: boolean;
  }>`
    SELECT
      m."userId"          AS "userId",
      m."organizationId"  AS "organizationId",
      o.slug              AS "orgSlug",
      o.visibility        AS visibility,
      u.email             AS email,
      u.name              AS name,
      m.role              AS role,
      COALESCE(
        o.metadata::jsonb->>'personal_org_for_user_id' = m."userId",
        false
      ) AS "isPersonal",
      EXISTS (
        SELECT 1
        FROM entity_identities blocker
        WHERE blocker.organization_id = m."organizationId"
          AND blocker.namespace = 'auth_user_id'
          AND blocker.identifier = m."userId"
          AND blocker.deleted_at IS NULL
      ) AS "hasBlockingClaim"
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

async function hasResolvableClaim(
  organizationId: string,
  userId: string
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ found: boolean }>`
    SELECT EXISTS (
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
      WHERE ei.organization_id = ${organizationId}
        AND ei.namespace = 'auth_user_id'
        AND ei.identifier = ${userId}
        AND ei.source_connector = 'auth:signup'
        AND ei.deleted_at IS NULL
    ) AS found
  `;
  return rows[0]?.found ?? false;
}

async function main(): Promise<void> {
  let opts: BackfillOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("set DATABASE_URL");
    process.exit(1);
  }
  const drift = await findDrift(opts.org);

  console.log(
    `Found ${drift.length} member row(s) without an auth:signup claim ` +
      `(${opts.execute ? "EXECUTE" : "DRY-RUN"}${opts.includeShared ? ", include-shared" : ""}).`
  );

  let backfilled = 0;
  let skippedBlocked = 0;
  let skippedShared = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  for (const row of drift) {
    if (row.hasBlockingClaim) {
      skippedBlocked++;
      console.error(
        `  skip (blocking auth_user_id claim) user=${row.userId} org=${row.orgSlug}`
      );
      continue;
    }

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
        role: row.role,
      });
      if (!(await hasResolvableClaim(row.organizationId, row.userId))) {
        throw new Error("provisioning returned without a resolvable claim");
      }
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
      ` skipped-blocked=${skippedBlocked} skipped-shared=${skippedShared}` +
      ` skipped-no-email=${skippedNoEmail} failed=${failed}`
  );
  process.exit(failed > 0 || skippedBlocked > 0 ? 1 : 0);
}

void main();
