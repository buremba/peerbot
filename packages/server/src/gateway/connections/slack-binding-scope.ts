/**
 * Slack's binding-scope resolver — the ONE place that knows a Slack binding's
 * `team_id` must be the concrete WORKSPACE (`T…`), never a Grid ENTERPRISE id
 * (`E…`).
 *
 * The generic binding-write path calls `resolveBindingTeam` (see
 * `channels/binding-scope-resolver`); this module registers the Slack rule so no
 * connector-specific logic leaks into that path or into the read-side gate/ACL.
 *
 * Resolution order:
 *   1. A trusted workspace hint (a slash-command / deep-link `team_id`) that is
 *      NOT the connection's enterprise id — it's the real workspace, already
 *      verified by Slack. Preferred: no round-trip.
 *   2. `conversations.info.context_team_id` — the channel's workspace context.
 *      This is the only install-time signal on a Grid org-wide install, where
 *      the connection's `external_tenant_id` is the enterprise id.
 *   3. The connection's `external_tenant_id` ONLY when it is a workspace id
 *      (`T…`) — a normal (non-Grid, non-org-wide) install stores the workspace
 *      there and needs no round-trip.
 *   4. Otherwise `null` — unknown yet (e.g. a private channel the bot isn't in).
 *      The binding is written with a NULL team and heals from the first inbound
 *      message, which carries the real `T…`. We NEVER write the enterprise id.
 */

import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type {
  BindingScopeModule,
  BindingScopeResolveParams,
} from "../channels/binding-scope-resolver.js";
import { stripPlatformPrefix } from "../channels/bound-channels.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  resolveSecretValue,
  type SecretStore,
  SecretStoreRegistry,
} from "../secrets/index.js";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
import { createSlackWebApi, type SlackWebApi } from "./slack-web.js";

const logger = createLogger("slack-binding-scope");

/**
 * A Slack workspace id is `T…`; a Grid enterprise id is `E…`. This is the one
 * shape check the CONNECTOR is allowed to make about its own identity space —
 * it lives here, inside the Slack module, and never touches the generic
 * gate/ACL. Used only to reject the enterprise id from ever being stamped as a
 * workspace.
 */
function isSlackWorkspaceId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^T[A-Z0-9]+$/i.test(id.trim());
}

/** Load a connection's bot-token `secret://` ref (top-level or chatMetadata). */
async function loadBotTokenRef(
  connectionId: number,
  organizationId: string,
): Promise<string | null> {
  const sql = getDb();
  const [row] = await sql<{ bot_token_ref: string | null }>`
    SELECT COALESCE(config->>'botToken', config->'chatMetadata'->>'botToken') AS bot_token_ref
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND connector_key = 'slack'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return row?.bot_token_ref ?? null;
}

/** Injectable seam so tests drive the resolver with a stub Slack API + store. */
export interface SlackBindingScopeDeps {
  slackWeb: Pick<SlackWebApi, "conversationInfo">;
  secretStore: SecretStore;
}

export async function resolveSlackBindingTeam(
  deps: SlackBindingScopeDeps,
  params: BindingScopeResolveParams,
): Promise<string | null> {
  const { connection, channelId, workspaceHint } = params;
  const stored = connection.externalTenantId;

  // 1. A trusted, real-workspace (T…) hint wins with no round-trip. The
  //    workspace-shape check already excludes an enterprise `E…` hint, so a
  //    valid hint is always safe to use verbatim.
  if (isSlackWorkspaceId(workspaceHint)) return workspaceHint.trim();

  // 2/3. If the stored tenant is already a workspace id (normal install), use
  //      it directly — no need to hit Slack.
  if (isSlackWorkspaceId(stored)) return stored.trim();

  // The stored tenant is an enterprise id (or absent): ask Slack which
  // workspace this channel lives in via conversations.info.context_team_id.
  const tokenRef = await loadBotTokenRef(
    connection.connectionId,
    connection.organizationId,
  );
  if (!tokenRef) {
    logger.info(
      { connectionId: connection.connectionId, channelId },
      "Slack binding-scope: no bot token to resolve channel workspace — leaving team NULL to heal from inbound",
    );
    return null;
  }
  const token = await orgContext.run(
    { organizationId: connection.organizationId },
    () => resolveSecretValue(deps.secretStore, tokenRef),
  );
  if (!token) return null;

  try {
    const info = await deps.slackWeb.conversationInfo(
      token,
      stripPlatformPrefix("slack", channelId),
    );
    if (isSlackWorkspaceId(info.contextTeamId)) {
      return info.contextTeamId.trim();
    }
  } catch (error) {
    // A private channel the bot isn't in yet (channel_not_found / not_in_channel)
    // or any transient failure: leave the team NULL and heal from inbound. NEVER
    // fall back to the enterprise id.
    logger.info(
      {
        connectionId: connection.connectionId,
        channelId,
        error: String(error),
      },
      "Slack binding-scope: conversations.info failed — leaving team NULL to heal from inbound",
    );
  }
  return null;
}

/** A PG-backed secret store — Slack bot tokens are written under the default
 *  (PG) scheme, so this resolves them exactly as the gateway's store. */
function slackSecretStore(): SecretStore {
  const pg = new PostgresSecretStore();
  return new SecretStoreRegistry(pg, { secret: pg });
}

/** The Slack binding-scope module — wired with the real Slack Web API + the
 *  process secret store. Enumerated by the generic resolver's module list. */
export const slackBindingScopeModule: BindingScopeModule = {
  key: "slack",
  resolve: (params) =>
    resolveSlackBindingTeam(
      { slackWeb: createSlackWebApi(), secretStore: slackSecretStore() },
      params,
    ),
};
