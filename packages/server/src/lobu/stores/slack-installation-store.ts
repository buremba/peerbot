import { randomUUID } from "node:crypto";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
} from "../../gateway/secrets/index.js";
import type { WritableSecretStore } from "../../gateway/secrets/index.js";
import { getDb } from "../../db/client.js";
import { orgContext } from "./org-context.js";

/**
 * A per-workspace Slack app install (the "Add to Slack" OAuth path).
 *
 * This is an org/workspace-INSTALLATION resource, not an agent connection: one
 * installed workspace routes to many agents via `/lobu link` channel bindings,
 * so it has no owning agent. The bot token lives in the secret store; `config`
 * carries only the `secret://` ref (mirrors `agent_connections.config`).
 */
export interface SlackInstallationRow {
  id: string;
  organizationId: string;
  teamId: string;
  teamName?: string;
  botUserId?: string;
  /** `{ platform: "slack", botToken: "secret://..." }` — token by ref, never plaintext. */
  config: Record<string, any>;
  status: "active" | "stopped" | "error";
  createdAt: number;
  updatedAt: number;
}

export interface SlackInstallationStore {
  /**
   * Idempotent per (org, team): a re-install refreshes the token + tenant
   * metadata on the SAME row id (so the instance memo and secret prefix stay
   * stable). The plaintext `botToken` is persisted to the secret store; only
   * its ref is written to the row.
   */
  upsertByTeam(
    organizationId: string,
    teamId: string,
    data: { teamName?: string; botUserId?: string; botToken: string }
  ): Promise<SlackInstallationRow>;
  getById(id: string): Promise<SlackInstallationRow | null>;
  /**
   * Resolve by team_id across orgs — the public `/slack/events` route carries
   * no org context, so routing keys on team_id alone (same semantics as the
   * legacy `agent_connections` team lookup). Prefers an `active` row.
   */
  getByTeamId(teamId: string): Promise<SlackInstallationRow | null>;
  list(organizationId: string): Promise<SlackInstallationRow[]>;
  markStopped(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Stable prefix so the connection manager can recognize an installation id.
 * Hyphen (not underscore) on purpose: the id appears inside the secret-store
 * name prefix `installations/<id>/`, and `_`/`%` are LIKE wildcards that the
 * secret store's prefix scan does not reliably escape — a hyphen keeps the
 * cascade delete working.
 */
export const SLACK_INSTALLATION_ID_PREFIX = "slackinst-";

function rowToInstallation(row: Record<string, any>): SlackInstallationRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    teamId: row.team_id,
    teamName: row.team_name ?? undefined,
    botUserId: row.bot_user_id ?? undefined,
    config: row.config ?? {},
    status: row.status,
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

export function createPostgresSlackInstallationStore(
  secretStore: WritableSecretStore
): SlackInstallationStore {
  return {
    async upsertByTeam(organizationId, teamId, data) {
      // Bind the org for both the secret-store put and the row write so they
      // land in the same tenant bucket regardless of ambient context.
      return orgContext.run({ organizationId }, async () => {
        const sql = getDb();
        const candidateId = `${SLACK_INSTALLATION_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
        const now = new Date();

        // Step 1: claim the (org, team) row and learn its CANONICAL id. Under a
        // concurrent first-install, the loser's INSERT conflicts and DO UPDATE
        // returns the winner's id — so we never persist a token under an id the
        // surviving row doesn't reference. config is left untouched here.
        const claimed = await sql`
          INSERT INTO slack_installations
            (id, organization_id, team_id, team_name, bot_user_id, config, status, created_at, updated_at)
          VALUES (
            ${candidateId}, ${organizationId}, ${teamId}, ${data.teamName ?? null},
            ${data.botUserId ?? null}, '{}'::jsonb, 'active', ${now}, ${now}
          )
          ON CONFLICT (organization_id, team_id) DO UPDATE SET
            team_name = EXCLUDED.team_name,
            bot_user_id = EXCLUDED.bot_user_id,
            status = 'active',
            updated_at = ${now}
          RETURNING id
        `;
        const id = claimed[0]!.id as string;

        // Step 2: persist the token under the canonical id, then point the row's
        // config at the ref.
        const tokenRef = await persistSecretValue(
          secretStore,
          `installations/${id}/botToken`,
          data.botToken
        );
        const config = {
          platform: "slack",
          ...(tokenRef ? { botToken: tokenRef } : {}),
        };
        const rows = await sql`
          UPDATE slack_installations
          SET config = ${sql.json(config)}, updated_at = ${new Date()}
          WHERE id = ${id}
          RETURNING *
        `;

        // One active install per Slack workspace. team_id is global and the
        // public /slack/events route has no org context, so a fresh install
        // from another org must supersede prior ones (Slack itself rotates the
        // old org's bot token on re-install — latest wins). Stopping the others
        // keeps getByTeamId unambiguous instead of relying on recency ordering.
        await sql`
          UPDATE slack_installations
          SET status = 'stopped', updated_at = now()
          WHERE team_id = ${teamId} AND id <> ${id} AND status <> 'stopped'
        `;

        return rowToInstallation(rows[0]);
      });
    },

    async getById(id) {
      const sql = getDb();
      const rows = await sql`SELECT * FROM slack_installations WHERE id = ${id} LIMIT 1`;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },

    async getByTeamId(teamId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM slack_installations
        WHERE team_id = ${teamId}
        ORDER BY (status = 'active') DESC, updated_at DESC
        LIMIT 1
      `;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },

    async list(organizationId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM slack_installations
        WHERE organization_id = ${organizationId}
        ORDER BY created_at DESC
      `;
      return rows.map(rowToInstallation);
    },

    async markStopped(id) {
      const sql = getDb();
      await sql`
        UPDATE slack_installations
        SET status = 'stopped', updated_at = now()
        WHERE id = ${id}
      `;
    },

    async delete(id) {
      const sql = getDb();
      // Resolve the org first: the token was stored under the install org's
      // secret bucket, so the prefix delete must run under that org context
      // (PostgresSecretStore scopes list/delete by AsyncLocalStorage org).
      const rows = await sql`
        SELECT organization_id FROM slack_installations WHERE id = ${id} LIMIT 1
      `;
      const orgId = rows[0]?.organization_id as string | undefined;
      await sql`DELETE FROM slack_installations WHERE id = ${id}`;
      const purge = () =>
        deleteSecretsByPrefix(secretStore, `installations/${id}/`);
      if (orgId) {
        await orgContext.run({ organizationId: orgId }, purge);
      } else {
        await purge();
      }
    },
  };
}
