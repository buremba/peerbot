import { createLogger } from "@lobu/core";
import type { DbClient } from "../../db/client.js";

/**
 * Workspace-identity aliasing for chat connections (issue #2148).
 *
 * A Slack Grid workspace can be recorded under EITHER tenant key — the
 * enterprise id (`E…`, an org-wide install) or the workspace id (`T…`, a
 * per-workspace install). Those are two distinct `connections` rows, and both
 * may legitimately stay active at once (an org-wide install serves every
 * sibling workspace, so it is never retired just because one workspace also
 * installed directly). Anything anchored to a raw connection id — channel
 * Behaviors, `/lobu link` bindings — therefore fragments across the pair:
 * a binding written while the `E…` row was routing stops matching once the
 * `T…` row takes routing precedence, and vice versa.
 *
 * This module is the ONE place that answers "which connection rows are the
 * same workspace?". Resolution stays identity-FIRST with connection-id
 * fallback: the alias set always contains the anchor row itself, so rows
 * anchored by plain connection id keep resolving unchanged (no migration of
 * existing triggers, safe during a rolling deploy against older pods).
 *
 * Slack-only semantics, deliberately narrow:
 *  - same org, same connector, not soft-deleted (status does NOT matter — a
 *    binding anchored on a paused sibling must still match while its workspace
 *    routes through the other row);
 *  - same `external_tenant_id` (a managed install and a BYO row for the same
 *    workspace), OR
 *  - same Grid enterprise where at least ONE side is the org-wide install.
 *    Two independent per-workspace siblings (T_A vs T_B) of one enterprise are
 *    genuinely different workspaces and are NOT aliased.
 *
 * The enterprise id is read from `app_installations.metadata->>'enterprise_id'`
 * (populated at install/claim time); the projection's
 * `config->'chatMetadata'->>'enterpriseId'` is empty on pre-existing rows and
 * is only a fallback via the `E…` tenant-key shape. Routing precedence
 * (exact-team → org-wide → sole-active) is untouched — aliasing only widens
 * which stored bindings a routed message may match.
 */

const logger = createLogger("chat-workspace-identity");

/** A Slack Grid ENTERPRISE id (`E…`), as opposed to a workspace id (`T…`). */
const SLACK_ENTERPRISE_ID_SQL_PATTERN = "^E[A-Z0-9]+$";

export interface ChatWorkspaceAliasSet {
	/** Numeric `connections.id` of every same-workspace row (anchor included). */
	connectionIds: number[];
	/** `connections.slug` of every same-workspace row (anchor included). */
	connectionSlugs: string[];
	/**
	 * Stable identity string for this workspace — the Grid enterprise id when
	 * known, else the tenant key, else the anchor's own id. Used to key
	 * cross-replica advisory locks so two writers reach the same lock whichever
	 * sibling connection they arrived through.
	 */
	workspaceKey: string;
	/** The anchor row itself. */
	anchorId: number;
	anchorSlug: string;
	anchorConnectorKey: string;
}

interface AliasRow {
	id: number | string;
	slug: string;
	is_anchor: boolean;
	anchor_connector_key: string;
	anchor_tenant: string | null;
	anchor_enterprise: string | null;
}

/**
 * Resolve the workspace alias set for a chat connection, anchored by slug or by
 * numeric id, scoped to one org. Returns null when the anchor row does not
 * exist in that org (callers fall back to their historical exact-connection
 * behavior — e.g. the cross-org hosted-preview connection).
 *
 * Non-Slack connectors return the anchor alone: no other platform records one
 * workspace under two tenant keys, and widening a binding's reach is
 * privilege-adjacent, so the expansion stays opt-in per platform.
 */
export async function resolveChatWorkspaceAliases(
	sql: DbClient,
	organizationId: string,
	anchor: { slug: string } | { connectionId: number },
): Promise<ChatWorkspaceAliasSet | null> {
	const anchorFilter =
		"slug" in anchor
			? sql`c.slug = ${anchor.slug}`
			: sql`c.id = ${anchor.connectionId}`;
	// One round trip: resolve the anchor's identity, then every same-workspace
	// sibling. `enterprise_of` prefers the populated app_installations metadata
	// and falls back to an `E…`-shaped tenant key (an org-wide install's
	// external_tenant_id IS the enterprise id). The enterprise arm requires an
	// org-wide side so two per-workspace Grid siblings never alias each other.
	const rows = await sql<AliasRow>`
		WITH anchor AS (
			SELECT
				c.id,
				c.slug,
				c.connector_key,
				c.external_tenant_id,
				COALESCE(
					ai.metadata->>'enterprise_id',
					CASE WHEN c.external_tenant_id ~ ${SLACK_ENTERPRISE_ID_SQL_PATTERN}
						THEN c.external_tenant_id END
				) AS enterprise_id,
				(
					COALESCE(ai.metadata->'is_enterprise_install' = 'true'::jsonb, false)
					OR c.external_tenant_id ~ ${SLACK_ENTERPRISE_ID_SQL_PATTERN}
				) AS org_wide
			FROM connections c
			LEFT JOIN app_installations ai
				ON ai.provider = 'slack'
				AND ai.metadata->>'external_id' = c.slug
			WHERE c.organization_id = ${organizationId}
				AND ${anchorFilter}
				AND c.deleted_at IS NULL
			LIMIT 1
		)
		SELECT
			c.id,
			c.slug,
			(c.id = a.id) AS is_anchor,
			a.connector_key AS anchor_connector_key,
			a.external_tenant_id AS anchor_tenant,
			a.enterprise_id AS anchor_enterprise
		FROM anchor a
		JOIN connections c
			ON c.organization_id = ${organizationId}
			AND c.connector_key = a.connector_key
			AND c.deleted_at IS NULL
		LEFT JOIN app_installations ai
			ON ai.provider = 'slack'
			AND ai.metadata->>'external_id' = c.slug
		WHERE
			c.id = a.id
			OR (
				a.connector_key = 'slack'
				AND (
					(
						c.external_tenant_id IS NOT NULL
						AND c.external_tenant_id = a.external_tenant_id
					)
					OR (
						a.enterprise_id IS NOT NULL
						AND COALESCE(
							ai.metadata->>'enterprise_id',
							CASE WHEN c.external_tenant_id ~ ${SLACK_ENTERPRISE_ID_SQL_PATTERN}
								THEN c.external_tenant_id END
						) = a.enterprise_id
						AND (
							a.org_wide
							OR COALESCE(ai.metadata->'is_enterprise_install' = 'true'::jsonb, false)
							OR c.external_tenant_id ~ ${SLACK_ENTERPRISE_ID_SQL_PATTERN}
						)
					)
				)
			)
		ORDER BY (c.id = a.id) DESC, c.id ASC
	`;
	if (rows.length === 0) return null;
	const anchorRow = rows.find((row) => row.is_anchor === true) ?? rows[0]!;
	const connectionIds = rows.map((row) => Number(row.id));
	const connectionSlugs = rows.map((row) => row.slug);
	const workspaceKey =
		anchorRow.anchor_enterprise ??
		anchorRow.anchor_tenant ??
		String(Number(anchorRow.id));
	if (connectionIds.length > 1) {
		logger.debug(
			{
				organizationId,
				anchorSlug: anchorRow.slug,
				workspaceKey,
				aliases: connectionSlugs,
			},
			"Chat connection resolves to a multi-row workspace alias set",
		);
	}
	return {
		connectionIds,
		connectionSlugs,
		workspaceKey,
		anchorId: Number(anchorRow.id),
		anchorSlug: anchorRow.slug,
		anchorConnectorKey: anchorRow.anchor_connector_key,
	};
}

/**
 * The Grid enterprise id backing a chat connection's ACTIVE install, or null.
 * Read from `app_installations.metadata->>'enterprise_id'` — the populated
 * source — scoped to the org and to a live install row, because callers use it
 * as an ADDITIONAL identity-lookup key on a privilege path (Builder admin
 * grant): a stale or foreign install must never widen that lookup.
 */
export async function resolveSlackConnectionEnterpriseId(
	sql: DbClient,
	organizationId: string,
	connectionSlug: string,
): Promise<string | null> {
	const rows = await sql<{ enterprise_id: string | null }>`
		SELECT ai.metadata->>'enterprise_id' AS enterprise_id
		FROM app_installations ai
		WHERE ai.provider = 'slack'
			AND ai.organization_id = ${organizationId}
			AND ai.status = 'active'
			AND ai.metadata->>'external_id' = ${connectionSlug}
		LIMIT 1
	`;
	return rows[0]?.enterprise_id ?? null;
}

/** Convenience: alias slugs for a runtime connection, anchor-only fallback. */
export async function resolveWorkspaceAliasSlugs(
	sql: DbClient,
	organizationId: string,
	anchorSlug: string,
): Promise<string[]> {
	const aliases = await resolveChatWorkspaceAliases(sql, organizationId, {
		slug: anchorSlug,
	});
	return aliases ? aliases.connectionSlugs : [anchorSlug];
}
