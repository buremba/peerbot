import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import type { StoredConnection } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { WritableSecretStore } from "../../gateway/secrets/index.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
} from "../../gateway/secrets/index.js";
import type {
  AppInstallationRow,
  AppInstallationStatus,
  AppInstallationStore,
} from "./app-installation-store.js";
import { upsertChatConnectionProjection } from "./connections-projection.js";
import { orgContext } from "./org-context.js";

/**
 * Slack OAuth workspace installs ("Add to Slack"), projected onto the generic
 * `app_installations` primitive — NO bespoke table, NO bespoke store interface.
 *
 * These are pure functions over {@link AppInstallationStore} + the secret store.
 * They own the genuinely Slack-specific concerns that don't generalize:
 *   - the stable `slackinst-<uuid>` external id (it is the secret-store name
 *     prefix `installations/<id>/botToken` AND the chat-instance-manager memo /
 *     webhook routing key, so it must survive reinstalls — the bigint PK can't
 *     serve as it, and re-keying provisioned secrets would be destructive);
 *   - the Slack tenant tuple mapping (provider=slack, instance/app='cloud',
 *     external_tenant_id=team_id — Slack routing keys on team_id alone, the
 *     `/api/v1/app-webhooks/slack` endpoint carries no org context);
 *   - the bot token, persisted to the secret store by ref (never plaintext in
 *     the row); the ref is carried in `metadata.config.botToken`.
 *
 * Everything else (storage, ownership/transfer, multi-replica convergence) is
 * the generic store's: `upsert` serializes one-active-per-team on the partial
 * unique index `app_installations_active_tenant` + a Postgres advisory lock.
 */

const logger = createLogger("slack-installations");

/** Stable prefix recognizing a Slack install id (secret prefix + routing key). */
export const SLACK_INSTALLATION_ID_PREFIX = "slackinst-";

const SLACK_PROVIDER = "slack";
const SLACK_PROVIDER_INSTANCE = "cloud";
/**
 * The single hosted Lobu Slack app. A constant (not `SLACK_CLIENT_ID`) so the
 * tenant tuple is deployment-independent — Slack routing keys on team_id alone,
 * so a per-app discriminator buys nothing and an env-dependent one would desync
 * historical rows. The actual client id is recorded in metadata for audit.
 */
const SLACK_PROVIDER_APP_ID = "cloud";

/**
 * A per-workspace Slack app install as the Slack call sites consume it. A plain
 * DTO (not a store with its own table) — the storage of record is
 * `app_installations`. The bot token lives in the secret store; `config` carries
 * only the `secret://` ref.
 */
export interface SlackInstallationRow {
  /** The stable `slackinst-<uuid>` external id. */
  id: string;
  organizationId: string;
  teamId: string;
  teamName?: string;
  botUserId?: string;
  /** `{ platform: "slack", botToken: "secret://..." }` — token by ref. */
  config: Record<string, any>;
  status: "active" | "stopped" | "error";
  createdAt: number;
  updatedAt: number;
}

/** Generic app_installation status -> the Slack tri-state the call sites use. */
function toSlackStatus(status: string): SlackInstallationRow["status"] {
  if (status === "active") return "active";
  if (status === "error") return "error";
  // suspended/revoked/pending all read back as the Slack "stopped" off-state.
  return "stopped";
}

/** Project a Slack `app_installations` row to the Slack DTO, or null if it
 * lacks the stable external id (its secret prefix / routing key is unknown). */
function toSlackRow(row: AppInstallationRow): SlackInstallationRow | null {
  const externalId = row.metadata.external_id;
  if (typeof externalId !== "string" || !externalId) return null;
  return {
    id: externalId,
    organizationId: row.organizationId,
    teamId: row.externalTenantId,
    teamName: row.metadata.team_name ?? undefined,
    botUserId: row.metadata.bot_user_id ?? undefined,
    config: row.metadata.config ?? {},
    status: toSlackStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upsert a per-workspace OAuth install (token + tenant data), keyed on
 * (org, team). Idempotent per (org, team): a reinstall reuses the SAME
 * `slackinst-<uuid>` external id (so the secret prefix, chat-instance-manager
 * memo, and any channel bindings stay stable) and refreshes the token + tenant
 * metadata. A fresh install from another org TRANSFERS ownership (the generic
 * store demotes the prior active row), so `getByTeam` stays unambiguous.
 *
 * One active install per Slack workspace AND one stable external id per (org,
 * team) are both enforced by the generic store's active-tenant advisory lock.
 * The external id is claimed ATOMICALLY inside that lock (step 1 below) before
 * any secret is written, so two concurrent installs of the same workspace
 * converge on a SINGLE external id + a single bot-token secret — no duplicate
 * id, no orphaned secret. Converges across replicas with no in-memory
 * coordination: both racers re-read the winner's external id under the lock
 * (the generic upsert preserves `external_id` on its in-place update path).
 */
export async function upsertSlackInstallByTeam(
  store: AppInstallationStore,
  secretStore: WritableSecretStore,
  organizationId: string,
  teamId: string,
  data: { teamName?: string; botUserId?: string; botToken: string }
): Promise<SlackInstallationRow> {
  // Bind the org for the secret-store put + the row write so they land in the
  // same tenant bucket regardless of ambient context.
  return orgContext.run({ organizationId }, async () => {
    const candidateId = `${SLACK_INSTALLATION_ID_PREFIX}${randomUUID().replace(
      /-/g,
      ""
    )}`;

    // Determine the CANONICAL external id WITHOUT mutating any row yet: reuse the
    // (org, team) row's id if one exists (reinstall keeps the stable secret prefix
    // + routing key), else mint the candidate. This read carries no side effect,
    // so a token-persist failure below cannot leave a half-activated row. (Two
    // concurrent FIRST installs of the same workspace may each mint a candidate;
    // the activation upsert's `preserveMetadataKeysOnUpdate: ['external_id']` makes
    // them converge on one id under the lock, and the token is persisted under the
    // RETURNED canonical id afterwards — see below — so no secret is orphaned.)
    const existing = await store.getByTenantAndOrg(
      {
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
      },
      organizationId
    );
    const plannedId =
      (existing?.metadata.external_id as string | undefined) ?? candidateId;

    // TOKEN FIRST — persist the bot token BEFORE any row is created/activated, so
    // the invariant "no active Slack install without a resolvable botToken" holds
    // even if this throws: on failure we simply never wrote/flipped a row. A
    // transfer's prior active owner is also untouched until we're committed to
    // activating (the demote happens inside the activation upsert below).
    let tokenRef = await persistSecretValue(
      secretStore,
      `installations/${plannedId}/botToken`,
      data.botToken
    );

    // Activate — create/reactivate the (org, team) row with the token ref already
    // in config, demoting any different-org prior owner, all inside the store's
    // advisory-locked transaction. `preserveMetadataKeysOnUpdate: ['external_id']`
    // converges concurrent first-installs on a single id.
    const buildMetadata = (extId: string): Record<string, any> => {
      const config = {
        platform: SLACK_PROVIDER,
        ...(tokenRef ? { botToken: tokenRef } : {}),
      };
      const metadata: Record<string, any> = { external_id: extId, config };
      if (data.teamName) metadata.team_name = data.teamName;
      if (data.botUserId) metadata.bot_user_id = data.botUserId;
      if (process.env.SLACK_CLIENT_ID) {
        metadata.slack_client_id = process.env.SLACK_CLIENT_ID;
      }
      return metadata;
    };

    const row = await store.upsert({
      organizationId,
      provider: SLACK_PROVIDER,
      providerInstance: SLACK_PROVIDER_INSTANCE,
      providerAppId: SLACK_PROVIDER_APP_ID,
      externalTenantId: teamId,
      authProfileId: null,
      status: "active",
      metadata: buildMetadata(plannedId),
      preserveMetadataKeysOnUpdate: ["external_id"],
    });
    const canonicalId = row.metadata.external_id as string;

    // Concurrency reconciliation: if a racing first-install won the id (the store
    // preserved a DIFFERENT external_id than the one we planned), our token sits
    // under the wrong prefix and config.botToken points at it. Re-persist the
    // token under the canonical id and rewrite config so the row's botToken
    // resolves and the secret prefix matches external_id (delete/cleanup keys on
    // it). Then drop our orphaned candidate secret. This only runs on the rare
    // concurrent-first-install race; the common path skips it.
    let finalRow = row;
    if (canonicalId !== plannedId) {
      tokenRef = await persistSecretValue(
        secretStore,
        `installations/${canonicalId}/botToken`,
        data.botToken
      );
      finalRow = await store.upsert({
        organizationId,
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
        authProfileId: null,
        status: "active",
        metadata: buildMetadata(canonicalId),
        preserveMetadataKeysOnUpdate: ["external_id"],
      });
      await deleteSecretsByPrefix(
        secretStore,
        `installations/${plannedId}/`
      ).catch((error) => {
        // Best-effort cleanup of the losing candidate's secret; a leftover is
        // harmless (no row references it) and the next reinstall is unaffected.
        logger.warn(
          { plannedId, canonicalId, teamId, error: String(error) },
          "Failed to purge orphaned Slack token secret after id reconciliation"
        );
      });
    }

    const slackRow = toSlackRow(finalRow);
    if (!slackRow) {
      // Should never happen — we just wrote external_id. Defensive log.
      logger.error(
        { teamId, organizationId },
        "Slack install upsert returned a row without external_id"
      );
      throw new Error("Slack install upsert lost its external id");
    }

    // Dual-write-through (connections-unify Stage 2a): mirror the managed install
    // into the `connections` projection (by slug = the slackinst- external id),
    // so the chat runtime — which reads `connections` — sees the install. Its
    // own advisory lock (keyed on the chat tenant tuple) keeps one active row per
    // (org, slack, team) on the partial-unique `connections_active_chat_tenant`
    // index. Separate transaction from the app_installations upsert above; a
    // crash between them is covered by the runtime's read-fallback to
    // `getSlackInstallById`, so a missing projection only costs one fallback.
    const projection: StoredConnection = {
      id: slackRow.id,
      platform: SLACK_PROVIDER,
      organizationId,
      config: slackRow.config,
      settings: { allowGroups: true },
      metadata: {
        teamId,
        ...(slackRow.teamName ? { teamName: slackRow.teamName } : {}),
        ...(slackRow.botUserId ? { botUserId: slackRow.botUserId } : {}),
      },
      status: "active",
      createdAt: slackRow.createdAt,
      updatedAt: slackRow.updatedAt,
    };
    const db = getDb();
    await db.begin(async (tx: typeof db) => {
      await upsertChatConnectionProjection(
        tx,
        (v) => db.json(v),
        projection,
        organizationId,
        "managed"
      );
    });

    return slackRow;
  });
}

/** Resolve a Slack install by its stable `slackinst-<uuid>` external id. */
export async function getSlackInstallById(
  store: AppInstallationStore,
  id: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveByExternalId(SLACK_PROVIDER, id);
  return row ? toSlackRow(row) : null;
}

/**
 * Resolve the ACTIVE install for a team across orgs — the public `/api/v1/app-webhooks/slack`
 * route carries no org context, so routing keys on team_id alone. Returns null
 * when no active install owns the team (a stopped/transferred workspace), which
 * is exactly what the coordinator wants: it then falls through to the OAuth /
 * preview default rather than routing to an off workspace.
 */
export async function getSlackInstallByTeamId(
  store: AppInstallationStore,
  teamId: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveActiveByTenant({
    provider: SLACK_PROVIDER,
    providerInstance: SLACK_PROVIDER_INSTANCE,
    providerAppId: SLACK_PROVIDER_APP_ID,
    externalTenantId: teamId,
  });
  return row ? toSlackRow(row) : null;
}

/** All Slack installs for an org. */
export async function listSlackInstalls(
  store: AppInstallationStore,
  organizationId: string
): Promise<SlackInstallationRow[]> {
  const rows = await store.listByProviderAndOrg(SLACK_PROVIDER, organizationId);
  return rows
    .map(toSlackRow)
    .filter((r): r is SlackInstallationRow => r !== null);
}

/** Mark a Slack install stopped (off, but kept for audit/rollback). */
export async function markSlackInstallStopped(
  store: AppInstallationStore,
  id: string
): Promise<void> {
  await store.setStatusByExternalId(
    SLACK_PROVIDER,
    id,
    "suspended" satisfies AppInstallationStatus
  );
  // Keep the connections projection coherent — the chat runtime reads it, so a
  // still-active projection would route to a stopped install. The slackinst-
  // external id is globally unique, so the slug-scoped update needs no org.
  await getDb()`
    UPDATE connections SET status = 'paused', updated_at = now()
    WHERE slug = ${id} AND deleted_at IS NULL AND credential_mode = 'managed'
  `;
}

/** Delete a Slack install and purge its bot-token secret. */
export async function deleteSlackInstall(
  store: AppInstallationStore,
  secretStore: WritableSecretStore,
  id: string
): Promise<void> {
  // Resolve the org first: the token was stored under the install org's bucket,
  // so the prefix delete must run under that org context.
  const row = await store.resolveByExternalId(SLACK_PROVIDER, id);
  const orgId = row?.organizationId;
  await store.deleteByExternalId(SLACK_PROVIDER, id);
  // Soft-delete the connections projection so the runtime stops reading it (a
  // connections HIT would otherwise shadow the now-deleted install — the
  // read-fallback only covers a MISS). Slug-scoped: slackinst- ids are unique.
  await getDb()`
    UPDATE connections SET deleted_at = now(), updated_at = now()
    WHERE slug = ${id} AND deleted_at IS NULL AND credential_mode = 'managed'
  `;
  const purge = () =>
    deleteSecretsByPrefix(secretStore, `installations/${id}/`);
  if (orgId) {
    await orgContext.run({ organizationId: orgId }, purge);
  } else {
    await purge();
  }
}
