/**
 * Bridge between the BetterAuth account hooks and the identity engine.
 *
 * On every social-login `account.create.after` and `account.update.after`,
 * this resolves the user's tenant `$member` and ingests verified facts
 * from the appropriate connector emitter. Fire-and-forget — sign-in must
 * NEVER block on engine work.
 *
 * Provider routing is data: each `providerId` maps to a single emitter
 * here. New providers register a new branch; everything else (rules,
 * matching, derivations) stays generic.
 */

import { getDb } from "../db/client";
import logger from "../utils/logger";
import { connectorCapabilityRegistry } from "./capability-registry";
// Side-effect import: each connector module self-registers on load.
import "./connectors";
import { ingestFacts } from "./engine";

const log = logger.child({ module: "identity-auth-hook" });

interface AuthAccountSummary {
	id: string;
	userId: string;
	providerId: string;
	accessToken?: string | null;
	scope?: string | null;
}

// Connector access-token refreshes (e.g. hourly) fire `account.update.after`
// without a scope change; the userinfo response is keyed on scope, so we
// skip the work when nothing meaningful changed. Bounded by a short TTL so a
// stuck row can't suppress ingest forever, and by a hard size cap so the
// map can't grow without bound under load.
const INGEST_DEDUPE_TTL_MS = 15 * 60 * 1000;
const INGEST_DEDUPE_MAX_ENTRIES = 10_000;
const recentIngest = new Map<string, { scope: string; at: number }>();

function shouldSkipIngest(account: AuthAccountSummary): boolean {
	const prev = recentIngest.get(account.id);
	if (!prev) return false;
	if (Date.now() - prev.at > INGEST_DEDUPE_TTL_MS) {
		recentIngest.delete(account.id);
		return false;
	}
	return prev.scope === (account.scope ?? "");
}

function markIngested(account: AuthAccountSummary): void {
	if (recentIngest.size >= INGEST_DEDUPE_MAX_ENTRIES) {
		// Drop the oldest entry. Map iteration order is insertion order, so the
		// first key is the least-recently-marked account.
		const oldest = recentIngest.keys().next();
		if (!oldest.done) recentIngest.delete(oldest.value);
	}
	recentIngest.set(account.id, { scope: account.scope ?? "", at: Date.now() });
}

interface ResolvedTenantMember {
	tenantOrganizationId: string;
	memberEntityId: number;
}

/**
 * Find the user's personal org and `$member` entity id. Returns null when
 * personal-org provisioning hasn't yet completed for this user — ingest
 * will be retried on the next account refresh.
 */
async function resolveTenantMember(
	userId: string,
): Promise<ResolvedTenantMember | null> {
	const sql = getDb();
	// Restrict to identity rows written by the auth-server signup hook so a
	// user-supplied row can't hijack the lookup, and join on organization_id
	// at every level so a stale cross-org row can't redirect to another tenant.
	const rows = await sql<{ organization_id: string; entity_id: number }>`
    SELECT m."organizationId" AS organization_id, e.id AS entity_id
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    JOIN entity_identities ei
      ON ei.organization_id = m."organizationId"
     AND ei.namespace = 'auth_user_id'
     AND ei.identifier = ${userId}
     AND ei.deleted_at IS NULL
     AND ei.source_connector = 'auth:signup'
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
     AND et.slug = '$member'
    WHERE m."userId" = ${userId}
      AND o.visibility = 'private'
    ORDER BY o."createdAt" ASC
    LIMIT 1
  `;
	if (rows.length === 0) return null;
	return {
		tenantOrganizationId: String(rows[0].organization_id),
		memberEntityId: Number(rows[0].entity_id),
	};
}

/**
 * Schedule the identity-engine ingest for a freshly-created or refreshed
 * social-login account. Fire-and-forget. Errors are logged, not thrown.
 *
 * Provider routing is registry-based — there is no per-provider branch in
 * core code. Each connector self-registers in `connectors/<name>.ts` and
 * the registry maps `providerId` → emitter.
 */
export function scheduleIdentityIngest(account: AuthAccountSummary): void {
	void (async () => {
		try {
			if (!account.accessToken) return;
			if (shouldSkipIngest(account)) {
				log.debug(
					{ accountId: account.id, providerId: account.providerId },
					"identity-engine: scope unchanged within dedupe window; skipping refresh ingest",
				);
				return;
			}
			// BetterAuth can hand back capitalised providerIds depending on the
			// config; the registry stores lower-case keys.
			const providerKey = account.providerId.trim().toLowerCase();
			const emit = connectorCapabilityRegistry.emitter(providerKey);
			if (!emit) {
				log.warn(
					{
						providerId: account.providerId,
						providerKey,
						userId: account.userId,
					},
					"identity-engine: no connector registered for provider; skipping ingest",
				);
				return;
			}
			const emitted = await emit({
				accessToken: account.accessToken,
				sourceAccountId: account.id,
			});
			// emit returning null is the fetch-failure / ambiguous-read signal —
			// calling ingestFacts on null would tombstone every prior fact.
			if (!emitted) return;

			const resolved = await resolveTenantMember(account.userId);
			if (!resolved) {
				log.debug(
					{ userId: account.userId, providerId: account.providerId },
					"identity-engine: no tenant $member yet — skipping ingest",
				);
				return;
			}

			await ingestFacts({
				tenantOrganizationId: resolved.tenantOrganizationId,
				memberEntityId: resolved.memberEntityId,
				userId: account.userId,
				accountIdentity: {
					connectorKey: providerKey,
					providerStableId: emitted.providerStableId,
					sourceAccountId: account.id,
				},
				facts: emitted.facts,
			});
			markIngested(account);
		} catch (err) {
			log.error(
				{ err, userId: account.userId, providerId: account.providerId },
				"identity-engine: ingest failed",
			);
		}
	})();
}

/**
 * Disconnect-time tombstone. When a user unlinks an OAuth account, we have
 * an `account.id` (BetterAuth row id) but no live access token, so the
 * connector can't be queried. Instead we look up every providerStableId we
 * previously ingested under this `(connectorKey, sourceAccountId)` and call
 * `ingestFacts({ facts: [] })` for each, which the engine treats as
 * authoritative-empty and tombstones every prior fact + revokes derivations.
 *
 * Fire-and-forget. Errors are logged.
 */
export function scheduleIdentityTombstoneOnAccountDelete(
	account: AuthAccountSummary,
): void {
	void (async () => {
		try {
			recentIngest.delete(account.id);
			const providerKey = account.providerId.trim().toLowerCase();
			const sql = getDb();
			const rows = await sql<{ provider_stable_id: string }>`
        SELECT DISTINCT metadata->>'providerStableId' AS provider_stable_id
        FROM events
        WHERE semantic_type = 'identity_fact'
          AND connector_key = ${providerKey}
          AND metadata->>'sourceAccountId' = ${account.id}
          AND COALESCE(metadata->>'normalizedValue', '') <> ''
      `;
			if (rows.length === 0) return;

			const resolved = await resolveTenantMember(account.userId);
			if (!resolved) return;

			for (const row of rows) {
				if (!row.provider_stable_id) continue;
				await ingestFacts({
					tenantOrganizationId: resolved.tenantOrganizationId,
					memberEntityId: resolved.memberEntityId,
					userId: account.userId,
					accountIdentity: {
						connectorKey: providerKey,
						providerStableId: row.provider_stable_id,
						sourceAccountId: account.id,
					},
					facts: [],
				});
			}
		} catch (err) {
			log.error(
				{ err, userId: account.userId, providerId: account.providerId },
				"identity-engine: tombstone-on-delete failed",
			);
		}
	})();
}
