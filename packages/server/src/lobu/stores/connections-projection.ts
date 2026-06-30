/**
 * The chat ⇄ `connections` mapping + writer. `connections` is the SOLE source of
 * truth for chat connections: the legacy `agent_connections` table is gone, so
 * the chat runtime reads and writes `connections` exclusively. A BYO chat
 * connection is keyed by `slug` (`agentconn-<id>`); a managed Slack install keeps
 * its `slackinst-<id>` external id AS the slug. Adapter config + `settings` +
 * `chatMetadata` fold into the `config` jsonb; the provider tenant lifts into the
 * first-class `external_tenant_id` column.
 *
 * This module owns the bidirectional id⇄slug mapping + the projection writer. It
 * does NOT import from `slack-installations.ts` (that file imports the writer
 * here), so the managed-install wire prefix is mirrored locally to keep the
 * dependency one-directional.
 */

import type { StoredConnection } from "@lobu/core";
import { createLogger } from "@lobu/core";
import { tsTime } from "../../db/client";

const logger = createLogger("connections-projection");

/**
 * Slug namespace for a BYO chat connection (`agent_connections.id`). Managed
 * Slack installs keep their stable `slackinst-<uuid>` external id AS the slug
 * verbatim (so the secret prefix / memo / bindings stay byte-identical to the
 * legacy runtime id). Mirror of `SLACK_INSTALLATION_ID_PREFIX` in
 * `slack-installations.ts` — duplicated here to keep this module free of a
 * circular import (that file depends on this one).
 */
const BYO_SLUG_PREFIX = "agentconn-";
const SLACK_INSTALLATION_ID_PREFIX = "slackinst-";

/** Whether `credential_mode` is set ('byo' | 'managed') — the row is a chat
 *  connection (data connectors leave it NULL). */
export type ChatCredentialMode = "byo" | "managed";

/**
 * Runtime connection id → `connections.slug`. BYO ids gain the `agentconn-`
 * namespace; managed Slack ids (`slackinst-…`) ARE the slug. Inverse of
 * {@link slugToLegacyId}.
 */
export function legacyIdToSlug(id: string): string {
  return id.startsWith(SLACK_INSTALLATION_ID_PREFIX)
    ? id
    : `${BYO_SLUG_PREFIX}${id}`;
}

/** `connections.slug` → the runtime connection id (strips the BYO namespace;
 *  managed slugs pass through). Inverse of {@link legacyIdToSlug}. */
export function slugToLegacyId(slug: string): string {
  return slug.startsWith(BYO_SLUG_PREFIX)
    ? slug.slice(BYO_SLUG_PREFIX.length)
    : slug;
}

/**
 * Legacy `StoredConnection.status` (active | stopped | error) →
 * `connections.status`. The unified table has no `stopped`; the Stage-1
 * backfill mapped stopped→paused, so the write-through must too.
 */
export function legacyStatusToConnections(
  status: StoredConnection["status"],
): string {
  if (status === "active") return "active";
  if (status === "error") return "error";
  return "paused"; // stopped → paused (off, kept for audit)
}

/**
 * `connections.status` (active | paused | error | revoked | pending_auth) →
 * legacy tri-state. paused / revoked / pending_auth are all the chat "off"
 * state (`stopped`); `revoked` is an intentional off-state, NOT the transient
 * `error` the health sweep retries.
 */
export function connectionsStatusToLegacy(
  status: string,
): StoredConnection["status"] {
  if (status === "active") return "active";
  if (status === "error") return "error";
  return "stopped"; // paused | revoked | pending_auth → stopped
}

/**
 * Map a `connections` chat row (decrypted config) → `StoredConnection`. Un-folds
 * the Stage-1 `config.{settings,chatMetadata}` back into the legacy shape, and
 * preserves the runtime id (`slugToLegacyId`) so secret prefixes, the instance
 * memo key, `connection_claims.connection_id`, and the webhook URL all stay
 * identical to the legacy runtime.
 */
export function connectionsRowToStored(
  row: Record<string, any>,
): StoredConnection {
  const cfg = (row.config ?? {}) as Record<string, any>;
  const { settings, chatMetadata, ...adapterConfig } = cfg;
  const metadata = { ...((chatMetadata as Record<string, any>) ?? {}) };
  // Managed installs fold the app_installation metadata (no teamId) — backfill
  // the routing tenant from the first-class column so mention-strip / routing
  // still find it.
  if (metadata.teamId == null && row.external_tenant_id != null) {
    metadata.teamId = row.external_tenant_id;
  }
  const out: StoredConnection = {
    id: slugToLegacyId(row.slug),
    platform: row.connector_key,
    config: adapterConfig,
    settings: (settings as StoredConnection["settings"]) ?? {},
    metadata,
    status: connectionsStatusToLegacy(row.status),
    createdAt: tsTime(row.created_at),
    updatedAt: tsTime(row.updated_at),
  };
  if (row.agent_id) out.agentId = row.agent_id;
  if (row.organization_id) out.organizationId = row.organization_id;
  if (row.error_message) out.errorMessage = row.error_message;
  return out;
}

/**
 * Write-through: upsert the `connections` projection of a chat connection by
 * (org, slug), INSIDE the caller's transaction so a crash can never diverge the
 * two sources. The folded `config` carries the adapter config (with `secret://`
 * refs) plus `settings` + `chatMetadata`; the tenant id is lifted into the
 * first-class `external_tenant_id` column.
 *
 * One-active-per-(org, platform, tenant): for a tenant-bound activation we take
 * a transaction-scoped advisory lock on the tenant tuple (mirrors
 * `app-installation-store`'s active-tenant pattern — the lock lives in Postgres,
 * so it serializes across replicas) and demote any OTHER active sibling, so the
 * partial-unique `connections_active_chat_tenant` index is never contended.
 * Tenantless chat (Telegram, `external_tenant_id IS NULL`) is keyed per
 * connection and skips the lock/demote.
 *
 * `sql` is the transaction handle; `jsonOf` builds a json-bound param from the
 * outer sql instance (postgres.js `sql.json`).
 */
export async function upsertChatConnectionProjection(
  sql: any,
  jsonOf: (value: unknown) => unknown,
  conn: StoredConnection,
  orgId: string,
  credentialMode: ChatCredentialMode,
): Promise<void> {
  const slug = legacyIdToSlug(conn.id);
  const status = legacyStatusToConnections(conn.status);
  const rawTeamId = conn.metadata?.teamId;
  const externalTenantId =
    typeof rawTeamId === "string" && rawTeamId.length > 0 ? rawTeamId : null;
  const displayName =
    (typeof conn.metadata?.teamName === "string" && conn.metadata.teamName) ||
    conn.platform;
  const foldedConfig = {
    ...((conn.config as Record<string, any>) ?? {}),
    settings: conn.settings ?? {},
    chatMetadata: conn.metadata ?? {},
  };

  if (status === "active" && externalTenantId) {
    await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `chatconn:${orgId}:${conn.platform}:${externalTenantId}`,
    ]);
    const demoted = await sql`
      UPDATE connections SET status = 'paused', updated_at = now()
      WHERE organization_id = ${orgId}
        AND connector_key = ${conn.platform}
        AND external_tenant_id = ${externalTenantId}
        AND status = 'active'
        AND deleted_at IS NULL
        AND credential_mode IS NOT NULL
        AND slug <> ${slug}
      RETURNING slug
    `;
    if (demoted.length > 0) {
      logger.info(
        {
          orgId,
          platform: conn.platform,
          teamId: externalTenantId,
          activated: slug,
          demoted: demoted.map((r: { slug: string }) => r.slug),
        },
        "Demoted sibling active chat connection (one-active-per-tenant)",
      );
    }

    // A MANAGED install binds a provider workspace (Slack team) to exactly ONE
    // org — the OAuth install moves with the workspace. On a reinstall/transfer
    // of the same team into a different org, the old org's managed projection
    // would otherwise stay 'active', leaving a stale routing/ACL row for a team
    // this org no longer owns. Demote any OTHER org's active managed projection
    // for this team (global tenant lock so it serializes cross-replica). BYO
    // connections can legitimately coexist cross-org, so this is managed-only.
    if (credentialMode === "managed") {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `chatconn:managed:${conn.platform}:${externalTenantId}`,
      ]);
      const transferred = await sql`
        UPDATE connections SET status = 'paused', updated_at = now()
        WHERE connector_key = ${conn.platform}
          AND external_tenant_id = ${externalTenantId}
          AND credential_mode = 'managed'
          AND status = 'active'
          AND deleted_at IS NULL
          AND organization_id <> ${orgId}
        RETURNING slug, organization_id
      `;
      if (transferred.length > 0) {
        logger.info(
          {
            orgId,
            platform: conn.platform,
            teamId: externalTenantId,
            activated: slug,
            demoted: transferred.map(
              (r: { slug: string; organization_id: string }) =>
                `${r.organization_id}:${r.slug}`,
            ),
          },
          "Demoted stale managed install in another org (workspace transfer)",
        );
      }
    }
  }

  await sql`
    INSERT INTO connections (
      organization_id, connector_key, external_tenant_id, agent_id,
      display_name, status, config, credential_mode, slug, visibility,
      error_message, created_at, updated_at
    ) VALUES (
      ${orgId}, ${conn.platform}, ${externalTenantId}, ${conn.agentId ?? null},
      ${displayName}, ${status}, ${jsonOf(foldedConfig)}, ${credentialMode},
      ${slug}, 'org', ${conn.errorMessage ?? null}, now(), now()
    )
    ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO UPDATE SET
      connector_key = EXCLUDED.connector_key,
      external_tenant_id = EXCLUDED.external_tenant_id,
      agent_id = EXCLUDED.agent_id,
      display_name = EXCLUDED.display_name,
      status = EXCLUDED.status,
      config = EXCLUDED.config,
      credential_mode = EXCLUDED.credential_mode,
      error_message = EXCLUDED.error_message,
      updated_at = now()
  `;
}

/** Soft-delete the `connections` projection for a chat connection (by slug),
 *  inside the caller's transaction. Mirrors the legacy hard delete. */
export async function softDeleteChatConnectionProjection(
  sql: any,
  orgId: string | null | undefined,
  connectionId: string,
): Promise<void> {
  const slug = legacyIdToSlug(connectionId);
  if (orgId) {
    await sql`
      UPDATE connections SET deleted_at = now(), updated_at = now()
      WHERE organization_id = ${orgId} AND slug = ${slug} AND deleted_at IS NULL
    `;
  } else {
    await sql`
      UPDATE connections SET deleted_at = now(), updated_at = now()
      WHERE slug = ${slug} AND deleted_at IS NULL
    `;
  }
}
