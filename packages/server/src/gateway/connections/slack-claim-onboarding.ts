/**
 * Post-claim Slack onboarding — the "you just connected a workspace, here's your
 * agent" step. Runs once, immediately after a pending Slack install is CLAIMED
 * into an org (see `claimSlackPendingInstall`), and does two things:
 *
 *   1. Auto-link the org's Builder agent to the installer's bot DM, so the
 *      installer can DM the bot and immediately talk to an agent — no manual
 *      channel binding required for the DM surface.
 *   2. Fire the one-time installer welcome DM (via the coordinator's atomic
 *      `welcome_dm_sent` marker), now that the workspace is claimed AND has its
 *      first agent (the Builder) wired to a channel (the DM).
 *
 * This is the DM half of the onboarding split the product wants: DM = auto-wired
 * here; named channels stay explicit (the bot posts a bind link when it's added
 * to a channel — see the team-join / channel-bind flow). Best-effort throughout:
 * a failure to open the DM, resolve the token, or bind must NEVER roll back the
 * claim — the workspace is already bound and remains claimable/usable.
 *
 * Idempotency: `createBinding` upserts on (org, connection, channel), so a
 * repeated claim re-binds the same DM harmlessly; the welcome marker guarantees
 * at-most-once delivery across replicas. This lives in its own module (not the
 * coordinator) because it imports `binding-service` + `preview/slack`, and
 * `preview/slack` imports the coordinator — importing it there would be circular.
 */
import { createLogger } from "@lobu/core";
import { BUILDER_AGENT_ID, ensureBuilderAgent } from "../../auth/builder-provisioning.js";
import { getDb } from "../../db/client.js";
import { canonicalSlackChannelId } from "../../preview/slack.js";
import { ChannelBindingService } from "../channels/binding-service.js";
import { resolveBindingTeam } from "../channels/binding-scope-resolver.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  resolveSecretValue,
  type WritableSecretStore,
} from "../secrets/index.js";
import { createSlackWebApi, type SlackWebApi } from "./slack-web.js";
import { maybeSendSlackWorkspaceWelcome } from "./slack-connection-coordinator.js";

const logger = createLogger("slack-claim-onboarding");

/**
 * Resolve the freshly-claimed workspace's active managed connection row (the
 * `slackinst-…` slug IS the connection slug). Returns the numeric connection id
 * + the bot-token `secret://` ref, or null when the install can't be resolved
 * (a claim that didn't project a connection — nothing to auto-link).
 */
async function resolveClaimedConnection(
  organizationId: string,
  teamId: string,
): Promise<{ connectionId: string; slug: string; botTokenRef: string | null } | null> {
  const rows = (await getDb()`
    SELECT id, slug, config
    FROM connections
    WHERE organization_id = ${organizationId}
      AND connector_key = 'slack'
      AND external_tenant_id = ${teamId}
      AND credential_mode = 'managed'
      AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `) as Array<{
    id: number;
    slug: string;
    config: { botToken?: string } | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    connectionId: String(row.id),
    slug: row.slug,
    botTokenRef: row.config?.botToken ?? null,
  };
}

/**
 * Auto-link the org's Builder agent to the installer's Slack DM, then fire the
 * installer welcome. Call AFTER `claimSlackPendingInstall` has committed the
 * active install. Every argument the caller already holds from the claim; the
 * secret store resolves the bot token org-scoped.
 *
 * Never throws — a wrapped best-effort so a welcome/link failure can't fail the
 * claim response the user is waiting on.
 */
export async function autoLinkBuilderAndWelcome(args: {
  teamId: string;
  organizationId: string;
  installerUserId: string | null;
  secretStore: WritableSecretStore;
  /** Injectable Slack Web API (tests stub DM open). */
  web?: SlackWebApi;
}): Promise<void> {
  const { teamId, organizationId, installerUserId, secretStore } = args;
  try {
    // The DM auto-link needs the installer's Slack id to open a DM. Without it
    // (BYO/self-heal claim), skip the link but still let the welcome path run —
    // its marker requires installer_user_id anyway, so it's a no-op too.
    if (!installerUserId) {
      logger.info(
        { teamId, organizationId },
        "Slack claim onboarding: no installer id — skipping builder DM auto-link",
      );
    } else {
      await linkBuilderToInstallerDm({
        teamId,
        organizationId,
        installerUserId,
        secretStore,
        web: args.web,
      });
    }

    // Welcome DM: the workspace is claimed and (when the link above succeeded)
    // has its first agent wired to the DM. The atomic marker keeps this
    // at-most-once regardless of which onboarding milestone fires it first.
    await maybeSendSlackWorkspaceWelcome({
      teamId,
      secretStore,
      web: args.web,
    });
  } catch (error) {
    logger.warn(
      { teamId, organizationId, error: String(error) },
      "Slack claim onboarding failed (non-fatal)",
    );
  }
}

/** Open the installer's bot DM and bind it to the org's Builder agent. */
async function linkBuilderToInstallerDm(args: {
  teamId: string;
  organizationId: string;
  installerUserId: string;
  secretStore: WritableSecretStore;
  web?: SlackWebApi;
}): Promise<void> {
  const { teamId, organizationId, installerUserId, secretStore } = args;

  const connection = await resolveClaimedConnection(organizationId, teamId);
  if (!connection?.botTokenRef) {
    logger.info(
      { teamId, organizationId },
      "Slack claim onboarding: no active managed connection/token — skipping builder DM auto-link",
    );
    return;
  }

  // Guarantee the org has a Builder agent to bind to (idempotent; heals a team
  // org that predates the builder feature). Skips recreation if the admin
  // deleted it (deletion sentinel) — then the pointer stays null and we bail.
  await ensureBuilderAgent(organizationId);
  const builderId = await resolveBuilderAgentId(organizationId);
  if (!builderId) {
    logger.info(
      { teamId, organizationId },
      "Slack claim onboarding: no builder/system agent — skipping DM auto-link",
    );
    return;
  }

  const botToken = await orgContext.run({ organizationId }, () =>
    resolveSecretValue(secretStore, connection.botTokenRef),
  );
  if (!botToken) {
    logger.warn(
      { teamId, organizationId },
      "Slack claim onboarding: bot token unresolved — skipping DM auto-link",
    );
    return;
  }

  const dmChannelId = await (args.web ?? createSlackWebApi()).openDm(
    botToken,
    installerUserId,
  );
  // Store under the canonical `slack:<id>` key — inbound messages reach the
  // dispatcher already canonicalized, so a raw `D…` key would never route.
  const channelId = canonicalSlackChannelId(dmChannelId);
  // Resolve the DM's CONCRETE workspace. On a Grid org-wide install the claim's
  // `teamId` (and the connection's external_tenant_id) is the enterprise `E…`,
  // which must never land in a binding — the resolver returns the real
  // workspace or null (heal-from-inbound). Not the raw `teamId`.
  const [conn] = (await getDb()`
    SELECT external_tenant_id FROM connections
    WHERE id = ${Number(connection.connectionId)}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `) as Array<{ external_tenant_id: string | null }>;
  const bindingTeamId =
    (await resolveBindingTeam({
      connection: {
        connectorKey: "slack",
        externalTenantId: conn?.external_tenant_id ?? teamId ?? null,
        connectionId: Number(connection.connectionId),
        organizationId,
      },
      channelId,
      // The claim's teamId is the workspace for a normal install — a trusted hint
      // the resolver uses directly (no Slack round-trip). For an org-wide install
      // it's the enterprise id, which the resolver rejects and resolves via
      // conversations.info instead.
      workspaceHint: teamId,
    })) ?? undefined;
  await new ChannelBindingService().createBinding(
    builderId,
    "slack",
    channelId,
    bindingTeamId,
    { organizationId, connectionId: connection.connectionId },
  );
  logger.info(
    { teamId, organizationId, builderId },
    "Slack claim onboarding: auto-linked Builder agent to installer DM",
  );
}

/**
 * The org's system (Builder) agent id: the explicit `system_agent_id` pointer
 * when set, else the conventional `lobu-builder` row if it exists. Null when the
 * org has no builder (deleted + sentinel), so the caller skips the link.
 */
async function resolveBuilderAgentId(
  organizationId: string,
): Promise<string | null> {
  const rows = (await getDb()`
    SELECT COALESCE(
      o.system_agent_id,
      (SELECT a.id FROM agents a
        WHERE a.organization_id = ${organizationId} AND a.id = ${BUILDER_AGENT_ID}
        LIMIT 1)
    ) AS agent_id
    FROM organization o
    WHERE o.id = ${organizationId}
    LIMIT 1
  `) as Array<{ agent_id: string | null }>;
  return rows[0]?.agent_id ?? null;
}
