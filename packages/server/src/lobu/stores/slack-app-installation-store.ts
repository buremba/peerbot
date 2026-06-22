import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  type WritableSecretStore,
} from "../../gateway/secrets/index.js";
import type {
  AppInstallationStatus,
  AppInstallationStore,
} from "./app-installation-store.js";
import { createPostgresAppInstallationStore } from "./app-installation-store.js";
import { orgContext } from "./org-context.js";
import {
  createPostgresSlackInstallationStore,
  SLACK_INSTALLATION_ID_PREFIX,
  type SlackInstallationRow,
  type SlackInstallationStore,
} from "./slack-installation-store.js";

/**
 * Slack consolidation onto the generic `app_installations` primitive.
 *
 * The Slack "Add to Slack" OAuth install used to live in the bespoke
 * `slack_installations` table. This adapter keeps the SAME
 * {@link SlackInstallationStore} interface (so every call site —
 * chat-instance-manager's `slackinst-` hydration, the slack-connection-
 * coordinator's upsert/lookup — stays unchanged) while moving the storage of
 * record onto `app_installations`:
 *
 *  - DUAL-WRITE: every mutation writes BOTH `slack_installations` (legacy, kept
 *    intact for rollback + read fallback) AND the equivalent `app_installations`
 *    row. The legacy store remains the id authority — its `upsertByTeam` claims
 *    the canonical `slackinst-<uuid>` id and persists the bot token to the secret
 *    store — so the secret prefix and the chat-instance-manager memo/webhook key
 *    are byte-for-byte unchanged.
 *  - DUAL-READ: reads prefer `app_installations` and fall back to
 *    `slack_installations`, so a row that predates the backfill (or a replica
 *    mid-deploy) still resolves.
 *
 * DEPLOY-WINDOW SAFETY (degrade when the legacy table is gone): the contract
 * release drops `slack_installations` via a pre-upgrade migration hook that runs
 * while THESE (expand) pods may still be serving installs. So every legacy
 * `slack_installations` read AND write is wrapped to tolerate the table being
 * absent: on `undefined_table` (42P01) it logs a warn and DEGRADES to
 * app_installations-only — minting the `slackinst-<uuid>` id + persisting the bot
 * token itself, which is safe because app_installations is already the source of
 * truth and fully backfilled. Only the missing-table case is swallowed; any other
 * DB error still surfaces. This shim is transient — the contract PR deletes this
 * whole file — so it is not permanent debt.
 *
 * Mapping onto the generic tuple (kept identical to the backfill migration so
 * reads converge no matter which path wrote the row):
 *   provider           = 'slack'
 *   provider_instance  = 'cloud'
 *   provider_app_id    = 'cloud'  (the single hosted Lobu Slack app)
 *   external_tenant_id = team_id  (Slack routing key; /slack/events has no org)
 *   status             = active|stopped|error -> active|suspended|error
 *   auth_profile_id    = null     (token is a secret:// ref in metadata.config)
 *   metadata           = { external_id, team_name?, bot_user_id?, config }
 *
 * The `slackinst-<uuid>` id is NOT the `app_installations` bigint PK: it lives in
 * `metadata.external_id` and remains the public Slack install id (secret
 * prefix + memo/routing key). `getById` resolves by it.
 *
 * Multi-replica: every read/write is Postgres-mediated. The generic store's
 * `upsert` serializes ownership on a Postgres advisory lock + the partial unique
 * index `app_installations_active_tenant`, so concurrent installs across replicas
 * converge to a single active owner per team with no in-memory coordination —
 * matching the legacy store's "one active install per workspace" rule.
 *
 * Deferred (follow-up PR, after live verification): drop `slack_installations`,
 * delete `slack-installation-store.ts`, and remove the read fallback below.
 */

const logger = createLogger("slack-app-installation-store");

/** Postgres error code: undefined_table (the legacy table was dropped). */
const PG_UNDEFINED_TABLE = "42P01";

/** True iff `error` is Postgres "relation does not exist" (table dropped). */
function isMissingTableError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PG_UNDEFINED_TABLE;
}

const SLACK_PROVIDER = "slack";
const SLACK_PROVIDER_INSTANCE = "cloud";
/**
 * The single hosted Lobu Slack app. A constant (not `SLACK_CLIENT_ID`) so the
 * dual-write, the backfill migration, and every read agree on the tuple
 * regardless of deployment env — Slack routing has always keyed on team_id
 * alone, so a per-app discriminator buys nothing and an env-dependent one would
 * desync the backfill from runtime. The actual client id is recorded in
 * `metadata.slack_client_id` for audit when present.
 */
const SLACK_PROVIDER_APP_ID = "cloud";

/** Slack status (active|stopped|error) -> generic app_installation status. */
function toAppStatus(status: SlackInstallationRow["status"]): AppInstallationStatus {
  if (status === "active") return "active";
  if (status === "stopped") return "suspended";
  return "error";
}

/** Generic app_installation status -> Slack status (the inverse mapping). */
function toSlackStatus(status: string): SlackInstallationRow["status"] {
  if (status === "active") return "active";
  if (status === "error") return "error";
  // suspended/revoked/pending all read back as the Slack "stopped" off-state.
  return "stopped";
}

/** Project an `app_installations` Slack row back to a `SlackInstallationRow`. */
function appRowToSlackRow(row: Record<string, any>): SlackInstallationRow | null {
  const metadata: Record<string, any> = row.metadata ?? {};
  const id = metadata.external_id;
  // A Slack app_installations row without the stable slack id can't be served
  // through this interface (its secret prefix / memo key is unknown). Treat it
  // as a miss so the legacy fallback can resolve the canonical row.
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    organizationId: row.organization_id,
    teamId: row.external_tenant_id,
    teamName: metadata.team_name ?? undefined,
    botUserId: metadata.bot_user_id ?? undefined,
    config: metadata.config ?? {},
    status: toSlackStatus(row.status),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : (row.created_at ?? Date.now()),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : (row.updated_at ?? Date.now()),
  };
}

/**
 * Build the dual-write/dual-read Slack installation store backed by
 * `app_installations`, wrapping the legacy `slack_installations` store (kept as
 * the id authority, secret-token persistence, and read fallback).
 */
export function createSlackAppInstallationStore(
  secretStore: WritableSecretStore,
  options?: { appInstallationStore?: AppInstallationStore }
): SlackInstallationStore {
  const legacy = createPostgresSlackInstallationStore(secretStore);
  const appStore =
    options?.appInstallationStore ?? createPostgresAppInstallationStore();

  /** Write/refresh the app_installations mirror for a legacy Slack row. */
  async function mirrorToApp(row: SlackInstallationRow): Promise<void> {
    const metadata: Record<string, any> = {
      external_id: row.id,
      config: row.config ?? {},
    };
    if (row.teamName) metadata.team_name = row.teamName;
    if (row.botUserId) metadata.bot_user_id = row.botUserId;
    if (process.env.SLACK_CLIENT_ID) {
      metadata.slack_client_id = process.env.SLACK_CLIENT_ID;
    }
    // upsert enforces one active install per team via the active-tenant index +
    // advisory lock (reject/transfer), mirroring the legacy store's "stop older
    // rows for this team". A non-active install is just recorded for the tuple.
    await appStore.upsert({
      organizationId: row.organizationId,
      provider: SLACK_PROVIDER,
      providerInstance: SLACK_PROVIDER_INSTANCE,
      providerAppId: SLACK_PROVIDER_APP_ID,
      externalTenantId: row.teamId,
      authProfileId: null,
      status: toAppStatus(row.status),
      metadata,
    });
  }

  /** Resolve the app_installations Slack row carrying `slackInstallationId`. */
  async function appRowByInstallId(
    slackInstallationId: string
  ): Promise<Record<string, any> | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM app_installations
      WHERE provider = ${SLACK_PROVIDER}
        AND metadata ->> 'external_id' = ${slackInstallationId}
      ORDER BY (status = 'active') DESC, updated_at DESC
      LIMIT 1
    `;
    return rows.length ? rows[0] : null;
  }

  /** Flip the app_installations mirror's status for a slackinst id. */
  async function setAppStatusByInstallId(
    slackInstallationId: string,
    status: AppInstallationStatus
  ): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE app_installations
      SET status = ${status}, updated_at = now()
      WHERE provider = ${SLACK_PROVIDER}
        AND metadata ->> 'external_id' = ${slackInstallationId}
    `;
  }

  /**
   * DEGRADED install path used only when `slack_installations` is gone (the
   * contract drop hook ran). Does what the legacy store did — mint/reuse the
   * `slackinst-<uuid>` id, persist the bot token to the secret store, write the
   * row — but ONLY into app_installations. Reusing the existing app row's
   * `external_id` keeps the id (and its secret prefix) stable across reinstalls;
   * the generic `upsert` serializes one-active-per-team on its advisory lock.
   */
  async function upsertAppOnly(
    organizationId: string,
    teamId: string,
    data: { teamName?: string; botUserId?: string; botToken: string }
  ): Promise<SlackInstallationRow> {
    return orgContext.run({ organizationId }, async () => {
      const existing = await appRowByTeam(organizationId, teamId);
      const externalId =
        (existing?.metadata?.external_id as string | undefined) ??
        `${SLACK_INSTALLATION_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
      const tokenRef = await persistSecretValue(
        secretStore,
        `installations/${externalId}/botToken`,
        data.botToken
      );
      const config = {
        platform: SLACK_PROVIDER,
        ...(tokenRef ? { botToken: tokenRef } : {}),
      };
      const metadata: Record<string, any> = { external_id: externalId, config };
      if (data.teamName) metadata.team_name = data.teamName;
      if (data.botUserId) metadata.bot_user_id = data.botUserId;
      if (process.env.SLACK_CLIENT_ID) {
        metadata.slack_client_id = process.env.SLACK_CLIENT_ID;
      }
      const row = await appStore.upsert({
        organizationId,
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
        authProfileId: null,
        status: "active",
        metadata,
      });
      const mapped = appRowToSlackRow({
        id: row.id,
        organization_id: row.organizationId,
        external_tenant_id: row.externalTenantId,
        status: row.status,
        metadata: row.metadata,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });
      if (!mapped) throw new Error("Slack install upsert lost its external id");
      return mapped;
    });
  }

  /** The app_installations Slack row for an (org, team), if any. */
  async function appRowByTeam(
    organizationId: string,
    teamId: string
  ): Promise<Record<string, any> | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM app_installations
      WHERE provider = ${SLACK_PROVIDER}
        AND organization_id = ${organizationId}
        AND external_tenant_id = ${teamId}
      ORDER BY (status = 'active') DESC, updated_at DESC
      LIMIT 1
    `;
    return rows.length ? rows[0] : null;
  }

  return {
    async upsertByTeam(organizationId, teamId, data) {
      // Legacy first: it claims the canonical slackinst-<uuid> id, persists the
      // bot token to the secret store, and returns the row with the secret ref
      // in config — that ref is what we mirror (never the plaintext token).
      let row: SlackInstallationRow;
      try {
        row = await legacy.upsertByTeam(organizationId, teamId, data);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
        // The contract drop removed slack_installations while this pod is still
        // serving. Degrade to app_installations-only — it is the source of truth
        // and fully backfilled, so this is safe (not a band-aid: it's exactly
        // the contract behavior, just reached one release early).
        logger.warn(
          { teamId, organizationId },
          "slack_installations is gone (contract drop) — installing via app_installations only"
        );
        return upsertAppOnly(organizationId, teamId, data);
      }
      // The mirror write must NOT be swallowed: reads PREFER app_installations,
      // so a failed mirror would leave it stale (e.g. still on the old org after
      // a transfer) while getByTeamId keeps returning that stale row. Asymmetric
      // tolerance: only the legacy `slack_installations` missing-table case (42P01,
      // handled above) is the phase-out path we degrade through — a failure on the
      // preferred-read MIRROR is a hard error. Rethrow after logging so the caller
      // errors/retries (OAuth install retries) rather than routing stale. The
      // legacy row is already written, so a retry is idempotent per (org, team).
      try {
        await mirrorToApp(row);
      } catch (error) {
        logger.error(
          { id: row.id, teamId, error: String(error) },
          "Failed to mirror Slack install into app_installations — refusing to route on a stale mirror"
        );
        throw error;
      }
      return row;
    },

    async getById(id) {
      const appRow = await appRowByInstallId(id);
      const mapped = appRow ? appRowToSlackRow(appRow) : null;
      if (mapped) return mapped;
      // Fallback: a row not yet backfilled / mirrored still resolves from legacy.
      // Tolerate the table being gone (contract drop) — degrade to the
      // app_installations miss above (return null).
      try {
        return await legacy.getById(id);
      } catch (error) {
        if (isMissingTableError(error)) return null;
        throw error;
      }
    },

    async getByTeamId(teamId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${SLACK_PROVIDER}
          AND external_tenant_id = ${teamId}
        ORDER BY (status = 'active') DESC, updated_at DESC
        LIMIT 1
      `;
      const mapped = rows.length ? appRowToSlackRow(rows[0]) : null;
      if (mapped) return mapped;
      try {
        return await legacy.getByTeamId(teamId);
      } catch (error) {
        if (isMissingTableError(error)) return null;
        throw error;
      }
    },

    async list(organizationId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${SLACK_PROVIDER}
          AND organization_id = ${organizationId}
        ORDER BY created_at DESC, id DESC
      `;
      const mapped = rows
        .map(appRowToSlackRow)
        .filter((r): r is SlackInstallationRow => r !== null);
      if (mapped.length > 0) return mapped;
      // No mirror rows yet (pre-backfill) — fall back to the legacy listing.
      try {
        return await legacy.list(organizationId);
      } catch (error) {
        if (isMissingTableError(error)) return [];
        throw error;
      }
    },

    async markStopped(id) {
      try {
        await legacy.markStopped(id);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
      }
      await setAppStatusByInstallId(id, "suspended");
    },

    async delete(id) {
      // Legacy delete also purges the secret-store token under installations/<id>/.
      try {
        await legacy.delete(id);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
        // Table gone — purge the secret ourselves so it isn't orphaned, then
        // drop the app_installations row below.
        await deleteSlackInstallSecret(id);
      }
      const sql = getDb();
      await sql`
        DELETE FROM app_installations
        WHERE provider = ${SLACK_PROVIDER}
          AND metadata ->> 'external_id' = ${id}
      `;
    },
  };

  /** Purge the bot-token secret under the install org's bucket (degraded delete). */
  async function deleteSlackInstallSecret(id: string): Promise<void> {
    const appRow = await appRowByInstallId(id);
    const orgId = appRow?.organization_id as string | undefined;
    const purge = () =>
      deleteSecretsByPrefix(secretStore, `installations/${id}/`);
    if (orgId) {
      await orgContext.run({ organizationId: orgId }, purge);
    } else {
      await purge();
    }
  }
}
