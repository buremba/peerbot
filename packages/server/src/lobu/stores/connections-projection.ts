/**
 * The chat ⇄ `connections` mapping + writer. `connections` is the SOLE source of
 * truth for chat connections: chat runtime reads and writes `connections`
 * exclusively. A BYO chat connection is keyed by `slug` (`agentconn-<id>`); a
 * managed Slack install keeps its `slackinst-<id>` external id AS the slug.
 * Adapter config + `settings` + `chatMetadata` fold into the `config` jsonb; the
 * provider tenant lifts into the first-class `external_tenant_id` column.
 *
 * This module owns the bidirectional runtime-id⇄slug mapping + the projection
 * writer. It does NOT import from `slack-installations.ts` (that file imports
 * the writer here), so the managed-install wire prefix is mirrored locally to
 * keep the dependency one-directional.
 */

import type { StoredConnection } from "@lobu/core";
import { createLogger } from "@lobu/core";
import { type DbClient, tsTime } from "../../db/client";

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
 * {@link slugToRuntimeConnectionId}.
 */
export function runtimeConnectionIdToSlug(id: string): string {
  return id.startsWith(SLACK_INSTALLATION_ID_PREFIX)
    ? id
    : `${BYO_SLUG_PREFIX}${id}`;
}

/** `connections.slug` → the runtime connection id (strips the BYO namespace;
 *  managed slugs pass through). Inverse of {@link runtimeConnectionIdToSlug}. */
export function slugToRuntimeConnectionId(slug: string): string {
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
 * preserves the runtime id (`slugToRuntimeConnectionId`) so secret prefixes, the instance
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
    id: slugToRuntimeConnectionId(row.slug),
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
 * Advisory-lock key for a chat connection's tenant tuple — the FIRST lock in
 * the universal order for chat-connection writes: org-tenant advisory →
 * managed-workspace advisory (`managedTenantAdvisoryLockKey`) → only then any
 * `connections` row lock. Returns null when the write is not an active
 * tenant-bound activation (paused / tenantless), which takes no advisory lock
 * anywhere. Every writer that row-locks a chat connection row (saveConnection's
 * `FOR UPDATE`, this module's upsert/demotes) must derive its guard AND key
 * from these helpers so they can never drift — row-locking before finishing
 * the advisories inverts the order and deadlocks against a concurrent
 * reinstall.
 */
export function chatTenantAdvisoryLockKey(
  conn: StoredConnection,
  orgId: string,
): string | null {
  const rawTeamId = conn.metadata?.teamId;
  const externalTenantId =
    typeof rawTeamId === "string" && rawTeamId.length > 0 ? rawTeamId : null;
  return legacyStatusToConnections(conn.status) === "active" &&
    externalTenantId
    ? `chatconn:${orgId}:${conn.platform}:${externalTenantId}`
    : null;
}

/**
 * Advisory-lock key for the GLOBAL managed-workspace tuple — the SECOND lock
 * in the order (see `chatTenantAdvisoryLockKey`), serializing the cross-org
 * transfer/demote of a workspace across ALL orgs (hence org-independent). The
 * key is MODE-INDEPENDENT — it names the (platform, tenant) workspace, not a
 * credential mode — and is returned for EVERY active tenant-bound write, not
 * just managed ones: only managed writes demote anyone, but a BYO write must
 * already hold this lock before it row-locks anything or the advisory↔row
 * cycle reopens. Over-acquiring on BYO merely serializes it against managed
 * writes on the same tenant; under-acquiring is the only unsafe outcome.
 */
export function managedTenantAdvisoryLockKey(
  conn: StoredConnection,
): string | null {
  const rawTeamId = conn.metadata?.teamId;
  const externalTenantId =
    typeof rawTeamId === "string" && rawTeamId.length > 0 ? rawTeamId : null;
  return legacyStatusToConnections(conn.status) === "active" && externalTenantId
    ? `chatconn:managed:${conn.platform}:${externalTenantId}`
    : null;
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
 *
 * `opts.preserveAgentId`: the fallback `agent_id` is ROUTING state set by an
 * admin (`manage_connections update`), not connection state the caller owns —
 * a managed reinstall re-persists tokens/config but carries NO agent-routing
 * intent, and `StoredConnection.agentId === undefined` cannot distinguish
 * "no intent" from an explicit clear (the manager deletes the key on clear).
 * So the caller declares intent: with `preserveAgentId` the conflict UPDATE
 * keeps the existing row's `agent_id` (a fresh insert still starts NULL);
 * without it, `agent_id` is written from `conn.agentId` (set or clear).
 */
export async function upsertChatConnectionProjection(
  sql: any,
  jsonOf: (value: unknown) => unknown,
  conn: StoredConnection,
  orgId: string,
  credentialMode: ChatCredentialMode,
  opts?: { preserveAgentId?: boolean },
): Promise<void> {
  const slug = runtimeConnectionIdToSlug(conn.id);
  const status = legacyStatusToConnections(conn.status);
  const rawTeamId = conn.metadata?.teamId;
  const externalTenantId =
    typeof rawTeamId === "string" && rawTeamId.length > 0 ? rawTeamId : null;
  // Grid identity lets a T… projection find the stale E…-keyed generation even
  // though their tenant keys differ.
  const rawEnterpriseId = conn.metadata?.enterpriseId;
  const enterpriseId =
    typeof rawEnterpriseId === "string" && rawEnterpriseId.length > 0
      ? rawEnterpriseId
      : null;
  const tenantLockKey = chatTenantAdvisoryLockKey(conn, orgId);
  const managedLockKey = managedTenantAdvisoryLockKey(conn);
  const displayName =
    (typeof conn.metadata?.teamName === "string" && conn.metadata.teamName) ||
    conn.platform;
  const foldedConfig = {
    ...((conn.config as Record<string, any>) ?? {}),
    settings: conn.settings ?? {},
    chatMetadata: conn.metadata ?? {},
  };
  /** Fallback routing adopted from an enterprise generation retired below. */
  let inheritedAgentId: string | null = null;

  if (status === "active" && externalTenantId) {
    // Universal order (see chatTenantAdvisoryLockKey): tenant advisories up
    // front, before ANY row lock — in particular the same-org demote below is
    // a row lock and must follow the managed-advisory, or a concurrent
    // cross-org write (managed-advisory, then row-locks THIS org's sibling)
    // inverts against it. Locks are reentrant, so a caller (saveConnection)
    // that already holds them is a no-op here.
    await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
      tenantLockKey,
    ]);
    if (managedLockKey) {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
        managedLockKey,
      ]);
    }
    if (credentialMode === "managed" && enterpriseId) {
      // E… and T… installs take different tenant locks. This shared lock orders
      // the E… projection write against a T… activation tombstoning that row.
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `chatconn:${orgId}:${conn.platform}:enterprise:${enterpriseId}`,
      ]);
    }

    // Same-org one-active-per-(org, platform, tenant): demote any OTHER active
    // sibling in THIS org so the partial-unique `connections_active_chat_tenant`
    // index is never contended.
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

    // A T… activation retires an orphaned E…-keyed generation. An E… row with an
    // active backing install remains valid: Slack allows an org-wide install to
    // coexist with separately installed Grid workspaces.
    if (
      credentialMode === "managed" &&
      enterpriseId &&
      enterpriseId !== externalTenantId
    ) {
      const supersededEnterprise = await sql`
        UPDATE connections SET deleted_at = now(), status = 'paused', updated_at = now()
        WHERE organization_id = ${orgId}
          AND connector_key = ${conn.platform}
          AND external_tenant_id = ${enterpriseId}
          AND credential_mode = 'managed'
          AND status = 'active'
          AND deleted_at IS NULL
          AND slug <> ${slug}
          AND NOT EXISTS (
            SELECT 1 FROM app_installations ai
            WHERE ai.organization_id = ${orgId}
              AND ai.provider = ${conn.platform}
              AND ai.metadata->>'external_id' = connections.slug
              AND ai.status = 'active'
          )
        RETURNING slug, agent_id
      `;
      if (supersededEnterprise.length > 0) {
        // The retired generation's fallback `agent_id` is admin-configured
        // ROUTING state, not connection state. The successor is a NEW slug, so
        // it takes the INSERT path below and starts NULL — inherit the binding
        // or the workspace comes up ownerless (no connection owner to fall back
        // to, so inbound messages hit the unclaimed-workspace responder and any
        // channel bound only by that fallback goes dark).
        inheritedAgentId =
          supersededEnterprise
            .map((r: { agent_id: string | null }) => r.agent_id)
            .find((id: string | null) => id != null) ?? null;
        logger.info(
          {
            orgId,
            platform: conn.platform,
            teamId: externalTenantId,
            enterpriseId,
            activated: slug,
            superseded: supersededEnterprise.map((r: { slug: string }) => r.slug),
            inheritedAgentId,
          },
          "Retired stale enterprise-keyed Slack Grid connection projection",
        );
      }
    }

    // Cross-org managed transfer/demote — managed writes ONLY. A MANAGED
    // install binds a provider workspace (Slack team) to exactly ONE org: the
    // OAuth install moves with the workspace, and without this the old org
    // would keep a stale active routing/ACL row for a team it no longer owns.
    // BYO connections legitimately coexist cross-org, so they demote no one
    // (they hold the managed-advisory purely for lock-order uniformity).
    if (managedLockKey && credentialMode === "managed") {
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
      ${orgId}, ${conn.platform}, ${externalTenantId},
      ${conn.agentId ?? inheritedAgentId},
      ${displayName}, ${status}, ${jsonOf(foldedConfig)}, ${credentialMode},
      ${slug}, 'org', ${conn.errorMessage ?? null}, now(), now()
    )
    ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO UPDATE SET
      connector_key = EXCLUDED.connector_key,
      external_tenant_id = EXCLUDED.external_tenant_id,
      -- COALESCE, not overwrite: inheritance fills a GAP left by a retired
      -- enterprise generation. An existing binding on this row always wins, so
      -- a stale E… agent can never displace live routing.
      agent_id = COALESCE(${
        opts?.preserveAgentId
          ? sql`connections.agent_id`
          : sql`EXCLUDED.agent_id`
      }, ${inheritedAgentId}),
      display_name = EXCLUDED.display_name,
      status = EXCLUDED.status,
      config = EXCLUDED.config,
      credential_mode = EXCLUDED.credential_mode,
      error_message = EXCLUDED.error_message,
      updated_at = now()
  `;
}

/**
 * The provider tenant id (`external_tenant_id`) of a LIVE chat connection, or
 * null when there is no such active row.
 *
 * Scoped by (org, runtime connection id, connector) and restricted to active
 * chat rows. Callers use the result as a second exact identity key, so a wrong
 * or stale row here would widen a privilege lookup.
 */
export async function resolveActiveChatConnectionTenant(
  sql: DbClient,
  orgId: string,
  connectionId: string,
  connectorKey: string,
): Promise<string | null> {
  const slug = runtimeConnectionIdToSlug(connectionId);
  const rows = await sql<{ external_tenant_id: string | null }>`
    SELECT external_tenant_id FROM connections
    WHERE organization_id = ${orgId}
      AND slug = ${slug}
      AND connector_key = ${connectorKey}
      AND credential_mode IS NOT NULL
      AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0]?.external_tenant_id ?? null;
}

/** Soft-delete the `connections` projection for a chat connection (by slug),
 *  inside the caller's transaction. Mirrors the legacy hard delete. */
export async function softDeleteChatConnectionProjection(
  sql: any,
  orgId: string | null | undefined,
  connectionId: string,
): Promise<void> {
  const slug = runtimeConnectionIdToSlug(connectionId);
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
