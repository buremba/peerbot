/**
 * ACL observability — the three surfaces a failing ACL sync is surfaced on:
 *  1. the failure REASON persisted on the existing `connections.error_message`
 *     column (the ACL sync previously wrote only the `'failed'` freshness state,
 *     which is why a connection could fail every tick for months unseen);
 *  2. the connector-health alert (the alerter reads the `'failed'` ACL state as
 *     one more unhealthy reason);
 *  3. orphan cleanup — `authz_source_acl_state` rows are deleted when their
 *     connection is deleted, instead of lingering forever as `full`/`failed`.
 *
 * Everything here reuses EXISTING columns/rows. No new tables, no API/SDK
 * surface.
 *
 * ## `connections.error_message` ownership (the collision rule)
 *
 * The column is shared, single-text, and NOT ACL-owned. Today it carries
 * device-pin tombstones (`Device was removed` / `Device was moved to another
 * workspace`), feed-sync connection errors, and the chat projection writer's
 * copy of the same value. An ACL writer must therefore NEVER clobber a value it
 * did not write:
 *
 *   - **Write**: the reason is stored as `${ACL_ERROR_MESSAGE_PREFIX}${reason}`
 *     (`acl: …`), and the UPDATE's WHERE guard only matches rows whose current
 *     `error_message` is NULL or already `acl: `-prefixed. A value owned by any
 *     other subsystem (feed-sync error, device-pin tombstone) is left untouched
 *     — the ACL failure still surfaces on `authz_source_acl_state` and in the
 *     alert, and the operator still sees the OTHER subsystem's message.
 *   - **Clear**: on a successful re-sync the reason is cleared, but only when it
 *     is `acl: `-prefixed. The ACL writer never removes another subsystem's text.
 *
 * This is deliberately asymmetric: it guarantees the ACL writer cannot silently
 * overwrite feed text (the failure the brief guards against). The INVERSE — a
 * non-ACL writer (e.g. the chat projection upsert) overwriting an `acl:` value —
 * is out of scope here; `acl:`-prefixed text is at least greppable and clearly
 * attributed when it does happen.
 */

import {
  type DbClient,
  getDb,
  pgTextArray,
} from "../db/client.js";

export const ACL_ERROR_MESSAGE_PREFIX = "acl: ";

/** Failure reasons are truncated to this length before persisting. */
export const ACL_ERROR_MESSAGE_MAX_LENGTH = 500;

export function isAclErrorMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(ACL_ERROR_MESSAGE_PREFIX);
}

export function formatAclErrorMessage(reason: string): string {
  const body =
    reason.length > ACL_ERROR_MESSAGE_MAX_LENGTH
      ? `${reason.slice(0, ACL_ERROR_MESSAGE_MAX_LENGTH)}…`
      : reason;
  return `${ACL_ERROR_MESSAGE_PREFIX}${body}`;
}

/*
 * Slug⇄runtime-id mapping, MIRRORED here so this module stays free of a
 * circular import with `lobu/stores/connections-projection.ts` (that file
 * imports nothing here, but `softDeleteChatConnectionProjection` will call
 * `deleteConnectionAclRows`). Kept byte-identical to `runtimeConnectionIdToSlug`
 * / `slugToRuntimeConnectionId` in that file — change both if the prefixes move.
 */
const BYO_SLUG_PREFIX = "agentconn-";
const SLACK_INSTALLATION_ID_PREFIX = "slackinst-";

/** Runtime connection id → `connections.slug`. Mirror of connections-projection. */
function runtimeConnectionIdToSlug(id: string): string {
  return id.startsWith(SLACK_INSTALLATION_ID_PREFIX)
    ? id
    : `${BYO_SLUG_PREFIX}${id}`;
}

/** `connections.slug` → the runtime connection id. Mirror of connections-projection. */
function slugToRuntimeConnectionId(slug: string): string {
  return slug.startsWith(BYO_SLUG_PREFIX) ? slug.slice(BYO_SLUG_PREFIX.length) : slug;
}

/**
 * The runtime connection ids that may key a row in `authz_source_acl_state` for
 * the given `connections` row: a managed Slack install is keyed by its
 * `slackinst-…` slug verbatim, a BYO Slack connection by its `agentconn-`-stripped
 * runtime id, and a data connector (GitHub) by its numeric `id::text`.
 */
function aclConnectionIdCandidates(params: {
  slug: string;
  connectionId: string | number;
}): string[] {
  return [
    params.slug,
    slugToRuntimeConnectionId(params.slug),
    String(params.connectionId),
  ];
}

/**
 * Downgrade an EXISTING ACL row to `failed` (the gate fails closed) and persist
 * WHY on `connections.error_message` under the `acl: ` prefix. A no-op when the
 * connection was never graphed (no `authz_source_acl_state` row) — it stays on
 * the legacy fence rather than flipping to drop-everything on its first failure.
 *
 * Both writes commit in one transaction so the persisted reason cannot be lost
 * between the state flip and the column write.
 */
export async function markConnectionAclFailed(
  organizationId: string,
  connectionId: string,
  reason: string,
  sql: DbClient = getDb(),
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE authz_source_acl_state
      SET freshness_state = 'failed', updated_at = current_timestamp
      WHERE organization_id = ${organizationId}
        AND connection_id = ${connectionId}
    `;
    // See the file header for the collision rule: only NULL-or-`acl:`-owned
    // text may be overwritten, so a feed-sync message is never clobbered.
    await tx`
      UPDATE connections
      SET error_message = ${formatAclErrorMessage(reason)}, updated_at = current_timestamp
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND (slug = ${runtimeConnectionIdToSlug(connectionId)} OR id::text = ${connectionId})
        AND (error_message IS NULL OR error_message LIKE ${ACL_ERROR_MESSAGE_PREFIX + "%"})
    `;
  });
}

/**
 * Clear the persisted ACL failure reason once a sync succeeds. ONLY clears
 * `acl:`-owned text (see the collision rule in the file header) — another
 * subsystem's message is never removed.
 */
export async function clearConnectionAclError(
  organizationId: string,
  connectionId: string,
  sql: DbClient = getDb(),
): Promise<void> {
  await sql`
    UPDATE connections
    SET error_message = NULL, updated_at = current_timestamp
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND error_message LIKE ${ACL_ERROR_MESSAGE_PREFIX + "%"}
      AND (slug = ${runtimeConnectionIdToSlug(connectionId)} OR id::text = ${connectionId})
  `;
}

/**
 * Delete a connection's ACL-enforcement row when its connection is deleted.
 * `authz_source_acl_state` is a pure materialization (rebuildable by the next
 * sync) and nothing references it, so removing it on deletion is safe — and
 * without this it lingers forever as `full`/`failed`, inflating any "failed
 * connections" count.
 *
 * `connectionId` is the numeric `connections.id` where known; the delete matches
 * every runtime-id shape the sync may have stamped.
 */
export async function deleteConnectionAclRows(
  sql: DbClient,
  params: {
    organizationId: string;
    slug: string;
    connectionId: string | number;
  },
): Promise<void> {
  const candidates = aclConnectionIdCandidates(params);
  await sql`
    DELETE FROM authz_source_acl_state
    WHERE organization_id = ${params.organizationId}
      AND connection_id = ANY(${pgTextArray([...new Set(candidates)])}::text[])
  `;
}

/**
 * SQL predicate for "this ACL row's connection still exists as a LIVE
 * `connections` row". Shared between the connector-health scan (which flags
 * `freshness_state='failed'` rows) and the orphan-cleanup migration, so the
 * runtime-id matching cannot drift between them. Expects the aliases `a`
 * (authz_source_acl_state) and `c` (connections).
 */
export const ACL_ROW_CONNECTION_ALIVE_SQL = `(
  a.connection_id = c.slug
  OR a.connection_id = c.id::text
  OR a.connection_id = CASE
        WHEN c.slug LIKE 'agentconn-%' THEN substr(c.slug, length('agentconn-') + 1)
        ELSE c.slug
      END
)`;
