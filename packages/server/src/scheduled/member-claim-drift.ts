/**
 * $member projection-drift alerter.
 *
 * The authz channel-visibility gate resolves a signed-in user to their `$member`
 * entity via an `entity_identities` row: namespace `auth_user_id`, source
 * `auth:signup`, on an entity of type `$member`. When a better-auth `member` row
 * exists WITHOUT that claim, the gate resolves the user to nothing and hides
 * every enforced channel from them — silently. That is exactly how a batch of
 * orgs drifted before the claim write landed: the provisioning hooks swallow
 * their errors, so a single failed write leaves permanent, invisible drift.
 *
 * This job is the smoke detector, NOT the repair. It scans for two failure
 * shapes and logs an error (which rides the pino→Sentry path) on the transition
 * into a non-zero count, so a regression in any provisioning path surfaces
 * within a tick instead of the next time a human notices a missing DM:
 *
 *   1. `missing_claim` — a `member` row with no matching `$member` + `auth:signup`
 *      claim in that org. The historical drift.
 *
 *   2. `poison_claim` — an `auth_user_id`/`auth:signup` identifier that DOES
 *      exist for the user's org but is owned by a non-`$member` entity (or was
 *      written under a different source). In that state `ensureMemberEntity`'s
 *      `ON CONFLICT DO NOTHING` no-ops forever while the gate still resolves
 *      null — the forward path can never self-heal, so it must be alerted
 *      distinctly from a plain missing claim.
 *
 * Read-only. Single-claimant per tick via the runs-queue (registered in
 * scheduled/jobs.ts), so multi-replica safe with no extra coordination.
 */

import { getDb } from "../db/client";
import logger from "../utils/logger";

export interface MemberClaimDriftResult {
	/**
	 * better-auth member rows with no resolvable `$member` + `auth:signup` claim
	 * in their org. Counts BOTH the drifted rows (no claim at all) AND the
	 * poisoned ones (claim exists but on a non-$member) — the gate resolves
	 * neither. `poisonClaim` isolates the poisoned subset.
	 */
	missingClaim: number;
	/**
	 * The self-heal-proof subset: an `auth_user_id`/`auth:signup` claim whose
	 * identifier matches a member row but which is owned by a non-$member entity,
	 * so `ensureMemberEntity`'s ON CONFLICT DO NOTHING can never replace it.
	 */
	poisonClaim: number;
}

export async function runMemberClaimDriftCheck(): Promise<MemberClaimDriftResult> {
	const sql = getDb();

	const missingRows = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM "member" m
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
  `;

	// A claim whose identifier matches a real (member, org) pair but which is NOT
	// a live $member + auth:signup row. This is the self-heal-proof state: the
	// unique index means the forward path's INSERT ... DO NOTHING can never
	// replace it, yet the gate won't resolve it.
	const poisonRows = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM entity_identities ei
    JOIN "member" m
      ON m."organizationId" = ei.organization_id
     AND m."userId" = ei.identifier
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
    WHERE ei.namespace = 'auth_user_id'
      AND ei.deleted_at IS NULL
      AND (et.slug <> '$member' OR ei.source_connector <> 'auth:signup')
      -- Only count it as poison when the correct claim does NOT also exist:
      -- a stray connector-owned row alongside a valid $member claim is benign
      -- (the gate finds the $member one).
      AND NOT EXISTS (
        SELECT 1
        FROM entity_identities good
        JOIN entities ge
          ON ge.id = good.entity_id
         AND ge.organization_id = good.organization_id
         AND ge.deleted_at IS NULL
        JOIN entity_types get
          ON get.id = ge.entity_type_id
         AND get.organization_id = ge.organization_id
         AND get.slug = '$member'
        WHERE good.organization_id = ei.organization_id
          AND good.namespace = 'auth_user_id'
          AND good.identifier = ei.identifier
          AND good.source_connector = 'auth:signup'
          AND good.deleted_at IS NULL
      )
  `;

	const result: MemberClaimDriftResult = {
		missingClaim: missingRows[0]?.n ?? 0,
		poisonClaim: poisonRows[0]?.n ?? 0,
	};

	if (result.missingClaim > 0 || result.poisonClaim > 0) {
		logger.error(
			{ ...result },
			"[task] member-claim-drift: better-auth members without a resolvable $member claim — enforced channels hidden from them",
		);
	}

	return result;
}
