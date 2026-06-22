import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
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
 *     `/slack/events` endpoint carries no org context);
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
 * One active install per Slack workspace is enforced by the generic store's
 * active-tenant unique index + advisory lock — converges across replicas with
 * no in-memory coordination.
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
    // Reuse the existing external id for this (org, team) so a reinstall keeps
    // the stable secret prefix + routing key; otherwise mint a fresh one. The
    // generic upsert below serializes activation on the tenant tuple, so a
    // same-org reinstall updates that row in place under the lock.
    const existing = await findSlackInstallRow(store, organizationId, teamId);
    const externalId =
      existing?.metadata.external_id ??
      `${SLACK_INSTALLATION_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;

    // Persist the token under the canonical external id, then reference it.
    const tokenRef = await persistSecretValue(
      secretStore,
      `installations/${externalId}/botToken`,
      data.botToken
    );
    const config = {
      platform: SLACK_PROVIDER,
      ...(tokenRef ? { botToken: tokenRef } : {}),
    };
    const metadata: Record<string, any> = {
      external_id: externalId,
      config,
    };
    if (data.teamName) metadata.team_name = data.teamName;
    if (data.botUserId) metadata.bot_user_id = data.botUserId;
    if (process.env.SLACK_CLIENT_ID) {
      metadata.slack_client_id = process.env.SLACK_CLIENT_ID;
    }

    const row = await store.upsert({
      organizationId,
      provider: SLACK_PROVIDER,
      providerInstance: SLACK_PROVIDER_INSTANCE,
      providerAppId: SLACK_PROVIDER_APP_ID,
      externalTenantId: teamId,
      authProfileId: null,
      status: "active",
      metadata,
    });

    const slackRow = toSlackRow(row);
    if (!slackRow) {
      // Should never happen — we just wrote external_id. Defensive log.
      logger.error(
        { teamId, organizationId },
        "Slack install upsert returned a row without external_id"
      );
      throw new Error("Slack install upsert lost its external id");
    }
    return slackRow;
  });
}

/** The Slack `app_installations` row for an (org, team), if any. */
async function findSlackInstallRow(
  store: AppInstallationStore,
  organizationId: string,
  teamId: string
): Promise<AppInstallationRow | null> {
  const rows = await store.listByProviderAndOrg(SLACK_PROVIDER, organizationId);
  return rows.find((r) => r.externalTenantId === teamId) ?? null;
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
 * Resolve the ACTIVE install for a team across orgs — the public `/slack/events`
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
  const purge = () =>
    deleteSecretsByPrefix(secretStore, `installations/${id}/`);
  if (orgId) {
    await orgContext.run({ organizationId: orgId }, purge);
  } else {
    await purge();
  }
}
