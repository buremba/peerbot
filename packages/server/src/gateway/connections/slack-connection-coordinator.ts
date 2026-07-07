import { createLogger } from "@lobu/core";
import { Chat } from "chat";
import type { AppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
  claimSlackWelcomeDm,
  getSlackInstallByEnterpriseId,
  getSlackInstallByTeamId,
  resolveSlackPendingByTenant,
  writeSlackPendingInstall,
} from "../../lobu/stores/slack-installations.js";
import { getConfiguredPublicOrigin } from "../../utils/public-origin.js";
import { getDb } from "../../db/client.js";
import { createSlackWebApi, type SlackWebApi } from "./slack-web.js";
import {
  resolveSecretValue,
  type WritableSecretStore,
} from "../secrets/index.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  getOrgAppInstallationMethod,
  getPrimedBundledMethod,
  resolveAppInstallCredentials,
} from "../installation/app-install-credentials.js";
import type { PlatformAdapterConfig, PlatformConnection } from "./types.js";
import {
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  type ParsedSlackTeamJoinEvent,
} from "./slack-platform-bridge.js";

const logger = createLogger("slack-connection-coordinator");

/**
 * Complete a Slack install by parking it as an UNCLAIMED `pending` install
 * (org-less): exchange the `code` for the bot token + installer identity via
 * `oauth.v2.access`, then write the pending row. The installer later chooses
 * which Lobu org to bind the workspace to via the claim flow — this never binds.
 *
 * This is the converged completion for BOTH marketplace ("Add to Slack", no
 * state) AND state-carrying (logged-in) installs. `credsOrgHint` is the org the
 * Lobu-minted state peeked to, when present: it selects THAT org's BYO per-org
 * `connector_definitions` creds for the code exchange (self-host), mirroring
 * install-start's resolution; absent (hosted / logged-out) → primed bundled
 * creds. It is a creds hint ONLY, never a binding. Returns `null` when no creds
 * resolve (so the caller can fall through to the invalid-state rejection).
 */
export async function completeSlackPendingInstall(
  request: Request,
  redirectUri: string,
  credsOrgHint: string | null,
): Promise<{
  /** Provider-agnostic subject reference (the claim `ref`) — the Slack team id. */
  externalRef: string;
  /** Human-readable subject name for the claim confirm copy. */
  subjectName: string | null;
} | null> {
  const method =
    (credsOrgHint
      ? await getOrgAppInstallationMethod(credsOrgHint, "slack", "slack")
      : null) ?? getPrimedBundledMethod("slack", "slack");
  const creds = method ? resolveAppInstallCredentials(method) : null;
  if (!creds?.clientId || !creds?.clientSecret) {
    logger.warn(
      "Slack pending-install: no app credentials resolved; cannot exchange code",
    );
    return null;
  }
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return null;

  const web = createSlackWebApi();
  const result = await web.exchangeOAuthCode({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    code,
    redirectUri,
  });

  await writeSlackPendingInstall({
    teamId: result.teamId,
    teamName: result.teamName,
    botUserId: result.botUserId,
    botToken: result.botToken,
    installerUserId: result.authedUserId,
    isEnterpriseInstall: result.isEnterpriseInstall,
    enterpriseId: result.enterpriseId,
  });
  logger.info(
    {
      teamId: result.teamId,
      installerUserId: result.authedUserId,
      enterprise: result.isEnterpriseInstall,
    },
    "Slack pending-install parked (unclaimed) — awaiting claim",
  );

  // Best-effort: DM the installer their connect link. The pending row is already
  // parked; a DM failure (installer un-DMable, un-configured web base, …) must
  // never fail the install — the workspace can still be connected via the app.
  if (result.authedUserId) {
    await dmProviderClaimLink(web, result.botToken, result.authedUserId, result.teamId);
  } else {
    logger.info(
      { teamId: result.teamId },
      "Slack pending-install: no installer id — skipping connect DM",
    );
  }

  return {
    externalRef: result.teamId,
    subjectName: result.teamName,
  };
}

/**
 * DM the installer a single-use claim link so they can connect the freshly
 * parked (pending) workspace to their Lobu account. Best-effort: any failure is
 * logged and swallowed — the install stays parked and claimable via the app.
 */
async function dmProviderClaimLink(
  web: SlackWebApi,
  botToken: string,
  installerUserId: string,
  teamId: string,
): Promise<void> {
  const webBase = getConfiguredPublicOrigin()?.replace(/\/+$/, "");
  if (!webBase) {
    logger.warn(
      { teamId, installerUserId },
      "Slack pending-install: no public web base configured — skipping connect DM",
    );
    return;
  }
  const claimUrl = `${webBase}/connector/slack/connection?ref=${encodeURIComponent(teamId)}`;
  const text = `👋 Thanks for adding Lobu to your workspace! Connect it to your Lobu account to finish setup: ${claimUrl}`;
  try {
    const dm = await web.openDm(botToken, installerUserId);
    await web.postMessage(botToken, dm, text);
  } catch (error) {
    logger.warn(
      { teamId, installerUserId, error: String(error) },
      "Slack pending-install: failed to DM the installer their claim link",
    );
  }
}

/** The org's display name + URL slug (for the welcome DM's dashboard link). */
async function resolveOrgNameAndSlug(
  organizationId: string,
): Promise<{ name: string; slug: string } | null> {
  const rows = (await getDb()`
    SELECT name, slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `) as Array<{ name: string; slug: string }>;
  return rows[0] ?? null;
}

/**
 * Fire the ONE-TIME "you're all set" welcome DM to the installer, the moment a
 * claimed + installed Slack workspace gets its FIRST agent bound to a channel.
 * Distinct from {@link dmProviderClaimLink}, which fires at install/pending time
 * with the claim link — this fires later, once all three onboarding steps are
 * done (install → workspace claimed → first agent mapped), confirming the bot is
 * live and wired to an agent.
 *
 * Call this AFTER any successful Slack channel binding. The three preconditions
 * are enforced together by {@link claimSlackWelcomeDm}'s single conditional
 * UPDATE:
 *   - installed & workspace-mapped  → there is an ACTIVE `app_installations` row
 *     for the team (an unclaimed workspace is only ever `pending`, never active);
 *   - installer known               → that row carries `installer_user_id`;
 *   - exactly once, multi-replica   → the update flips `welcome_dm_sent` unset →
 *     true and returns the row ONLY to the winner, so concurrent pods racing the
 *     first binding send at most one DM.
 * When the claim returns null (any precondition unmet, or already sent) this is a
 * no-op.
 *
 * Best-effort delivery: a DM failure is logged and swallowed (matching
 * {@link dmProviderClaimLink}) — it must NEVER roll back the binding. The marker is
 * already claimed, so a failed send is not retried (at-most-once wins over
 * at-least-once here, per the idempotency invariant).
 */
export async function maybeSendSlackWorkspaceWelcome(args: {
  teamId: string;
  secretStore: WritableSecretStore;
  /** Injectable Slack Web API (tests stub the DM calls). */
  web?: SlackWebApi;
}): Promise<void> {
  const { teamId, secretStore } = args;
  const claim = await claimSlackWelcomeDm(teamId);
  if (!claim) return;

  const webBase = getConfiguredPublicOrigin()?.replace(/\/+$/, "");
  const botToken = claim.botTokenRef
    ? await orgContext.run({ organizationId: claim.organizationId }, () =>
        resolveSecretValue(secretStore, claim.botTokenRef),
      )
    : undefined;
  if (!botToken) {
    logger.warn(
      { teamId, installationId: claim.installationId },
      "Slack welcome DM: no resolvable bot token — skipping installer welcome",
    );
    return;
  }

  // Link the ORG NAME (not a raw URL) to its dashboard, using Slack's
  // `<url|label>` mrkdwn link syntax — a bare URL reads as noise in a DM.
  const org = await resolveOrgNameAndSlug(claim.organizationId);
  const dashboard =
    webBase && org
      ? ` Manage it anytime in <${webBase}/${org.slug}|${org.name}>.`
      : "";
  const text = `🎉 You're all set! Lobu is live in your workspace and now wired up to an agent. Mention it in a channel or send it a DM to start.${dashboard}`;
  const web = args.web ?? createSlackWebApi();
  try {
    const dm = await web.openDm(botToken, claim.installerUserId);
    await web.postMessage(botToken, dm, text);
    logger.info(
      { teamId, installationId: claim.installationId },
      "Slack welcome DM: sent installer the first-agent-bound welcome",
    );
  } catch (error) {
    logger.warn(
      {
        teamId,
        installationId: claim.installationId,
        installerUserId: claim.installerUserId,
        error: String(error),
      },
      "Slack welcome DM: failed to DM the installer the welcome message",
    );
  }
}

/**
 * Parse an Events API webhook body into a user-facing message we should reply
 * to when the workspace is unclaimed: an `app_mention`, or a direct message
 * (`message` with channel_type `im`). Returns null for everything else — the
 * bot's own messages, message edits/subtypes, channel chatter, url_verification
 * challenges, or non-JSON (interactivity/slash) payloads.
 */
export function parseSlackUserMessageEvent(
  body: string,
  contentType: string,
): { channel: string; user: string } | null {
  // Events API always posts application/json; form bodies are slash/interactivity.
  if (contentType.includes("application/x-www-form-urlencoded")) return null;
  let payload: {
    type?: string;
    event?: {
      type?: string;
      channel?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      channel_type?: string;
    };
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (payload.type !== "event_callback") return null;
  const event = payload.event;
  if (!event || !event.channel || !event.user || event.bot_id) return null;
  const isMention = event.type === "app_mention";
  const isDirectMessage =
    event.type === "message" &&
    event.channel_type === "im" &&
    !event.subtype;
  if (!isMention && !isDirectMessage) return null;
  return { channel: event.channel, user: event.user };
}

type SlackInstallation = {
  botToken: string;
  botUserId?: string;
  teamName?: string;
};

type SlackOAuthAdapter = {
  handleOAuthCallback(request: Request): Promise<{
    teamId: string;
    installation: SlackInstallation;
  }>;
  deleteInstallation(teamId: string): Promise<void>;
  handleWebhook(request: Request): Promise<Response>;
};

type SlackRuntimeConfig = {
  signingSecret?: string;
  clientId?: string;
  clientSecret?: string;
  encryptionKey?: string;
  installationKeyPrefix?: string;
  userName?: string;
  botToken?: string;
};

/**
 * App-level Slack credentials for the shared (hosted) Lobu Slack app.
 *
 * The three core OAuth/signing keys (clientId, clientSecret, signingSecret)
 * are read via the declared env-var names from the Slack catalog connector
 * (primed at boot by primeAppInstallationMethods). All other keys (botToken,
 * encryptionKey, installationKeyPrefix, userName) remain direct env reads —
 * they are not part of the app_installation auth schema.
 *
 * Reading from env (not from whatever connection happens to be warm on the
 * current pod) makes config resolution deterministic across replicas — every
 * pod sees the same values regardless of which Slack connections it has warmed.
 * Per-workspace connections persist only tenant data (bot token); the Slack
 * adapter falls back to these env vars at runtime, so rotating them does not
 * require reinstalling each workspace.
 *
 * When the env is unset, OAuth/preview is simply unavailable and operators must
 * bring their own Slack credentials on a per-connection basis.
 */
function readSlackAppEnvConfig(): SlackRuntimeConfig {
  // Use the declared env-var names from the Slack connector declaration (primed
  // at boot). Falls back to direct env reads when the bundled method is not
  // primed (e.g. a build without the connector on disk), so startup ordering
  // is never a hard failure.
  const primedMethod = getPrimedBundledMethod("slack", "slack");
  const declared = primedMethod
    ? resolveAppInstallCredentials(primedMethod)
    : null;
  return {
    signingSecret: declared?.webhookSecret ?? process.env.SLACK_SIGNING_SECRET,
    clientId: declared?.clientId ?? process.env.SLACK_CLIENT_ID,
    clientSecret: declared?.clientSecret ?? process.env.SLACK_CLIENT_SECRET,
    encryptionKey: process.env.SLACK_ENCRYPTION_KEY,
    installationKeyPrefix: process.env.SLACK_INSTALLATION_KEY_PREFIX,
    userName: process.env.SLACK_USER_NAME,
    botToken: process.env.SLACK_BOT_TOKEN,
  };
}

interface SlackConnectionCoordinatorDeps {
  createStateAdapter(): Promise<any>;
  ensureConnectionRunning(connectionId: string): Promise<boolean>;
  forwardWebhook(connectionId: string, request: Request): Promise<Response>;
  getRunningChat(connectionId: string): any | undefined;
  listSlackConnections(): Promise<PlatformConnection[]>;
  /**
   * The generic app-installation store. Slack OAuth workspace installs are a
   * thin projection over it (`lobu/stores/slack-installations.ts`) — no bespoke
   * table or store. Resolved lazily so building the coordinator never forces the
   * store to exist; only the install/webhook paths actually need it.
   */
  getAppInstallationStore(): AppInstallationStore;
  /** Secret store for persisting/purging the per-workspace bot token. */
  getSecretStore(): WritableSecretStore;
}

export class SlackConnectionCoordinator {
  constructor(private readonly deps: SlackConnectionCoordinatorDeps) {}

  async findConnectionByTeamId(
    teamId: string
  ): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    return (
      connections.find(
        (connection) =>
          connection.metadata?.teamId === teamId &&
          // A stopped BYO connection must not preempt routing — otherwise it
          // shadows an active OAuth install (an `app_installations` row) for the team
          // (matched first → 503, never falling through to the install).
          connection.status !== "stopped"
      ) || null
    );
  }

  /**
   * Resolve the connection that should handle a webhook we could NOT route by
   * team_id (url_verification challenges, events with no extractable team).
   *
   * Only the hosted shared-app / preview connection is a safe default: it is
   * explicitly marked `settings.previewMode === true` and belongs to no
   * specific tenant. Everything else is tenant-owned — a team-scoped row
   * obviously so, but ALSO a plain org-owned row with empty metadata (a BYO
   * connection created without an OAuth install never gets a `metadata.teamId`,
   * yet still carries that org's bot token). Forwarding an unmatched-team
   * webhook to any tenant-owned row would let one tenant's bot act on (and
   * reply with its own bot token to) another tenant's Slack traffic.
   * `listSlackConnections()` is platform-scoped only (the public `/api/v1/app-webhooks/slack`
   * route carries no org context, so the store's per-tenant predicate doesn't
   * apply) — so we must require the explicit preview marker and otherwise fail
   * closed (return null → handled-by-OAuth-fallback / 503) rather than pick a
   * foreign tenant.
   */
  async getDefaultConnection(): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    return (
      connections.find(
        (connection) =>
          connection.settings?.previewMode === true &&
          !connection.metadata?.teamId
      ) || null
    );
  }

  async handleAppWebhook(request: Request): Promise<Response> {
    const body = await request.text();
    const contentType = request.headers.get("content-type") || "";
    const teamJoinEvent = parseSlackTeamJoinEvent(body, contentType);
    const teamId = this.extractTeamId(body, contentType);
    // Grid: events for a workspace inside an Enterprise Grid arrive stamped with
    // a SIBLING workspace's `team_id` (not the install's), but carry the shared
    // `enterprise_id`. Captured so path 2 can fall back to an enterprise match
    // when the exact team id misses.
    const enterpriseId = this.extractEnterpriseId(body, contentType);

    if (teamId) {
      // 1) A BYO agent-owned Slack connection for this workspace (created via
      //    the UI with its own bot token) — unchanged legacy path.
      const connection = await this.findConnectionByTeamId(teamId);
      if (connection) {
        if (!(await this.deps.ensureConnectionRunning(connection.id))) {
          return new Response("Slack connection unavailable", { status: 503 });
        }
        const response = await this.deps.forwardWebhook(
          connection.id,
          this.cloneRequestWithBody(request, body)
        );
        if (response.ok && teamJoinEvent) {
          await this.handleTeamJoinWelcome(connection.id, teamJoinEvent);
        }
        return response;
      }

      // 2) An OAuth-installed workspace (the "Add to Slack" path). The install
      //    is an `app_installations` row (provider=slack), not a BYO `connections` chat row;
      //    the manager hydrates an agentless Slack instance from it (the
      //    `slackinst-` id is namespaced, so `ensureConnectionRunning`/
      //    `forwardWebhook` resolve it via the Slack install projection). Per-message
      //    routing is via `/lobu link` bindings.
      const store = this.deps.getAppInstallationStore();
      // Exact team id first; on a Grid workspace the event's team id is a sibling
      // of the install's, so fall back to the shared enterprise id — but only
      // when that enterprise has a SINGLE install (else it's ambiguous and the
      // fallback returns null rather than cross-tenant misroute).
      const installation =
        (await getSlackInstallByTeamId(store, teamId)) ??
        (enterpriseId
          ? await getSlackInstallByEnterpriseId(store, enterpriseId)
          : null);
      if (installation && installation.status !== "stopped") {
        if (!(await this.deps.ensureConnectionRunning(installation.id))) {
          return new Response("Slack connection unavailable", { status: 503 });
        }
        const response = await this.deps.forwardWebhook(
          installation.id,
          this.cloneRequestWithBody(request, body)
        );
        if (response.ok && teamJoinEvent) {
          await this.handleTeamJoinWelcome(installation.id, teamJoinEvent);
        }
        return response;
      }

      // 3) A workspace that installed Lobu but hasn't been CLAIMED into a Lobu
      //    org yet (a `pending` install). Don't silently drop their messages —
      //    reply with the connect link so a workspace admin can finish setup.
      const pending = await resolveSlackPendingByTenant(teamId);
      if (pending) {
        return await this.replyUnclaimedWorkspace(
          pending.botToken,
          teamId,
          body,
          contentType,
          request.headers.get("x-slack-retry-num") !== null,
        );
      }
    }

    const fallbackConnection = await this.getDefaultConnection();
    if (fallbackConnection) {
      if (!(await this.deps.ensureConnectionRunning(fallbackConnection.id))) {
        return new Response("Slack connection unavailable", { status: 503 });
      }
      const response = await this.deps.forwardWebhook(
        fallbackConnection.id,
        this.cloneRequestWithBody(request, body)
      );
      if (
        response.ok &&
        teamJoinEvent &&
        (!fallbackConnection.metadata?.teamId ||
          fallbackConnection.metadata.teamId === teamJoinEvent.teamId)
      ) {
        await this.handleTeamJoinWelcome(fallbackConnection.id, teamJoinEvent);
      }
      return response;
    }

    const { chat, adapter } = await this.createOAuthChat();
    try {
      return await adapter.handleWebhook(
        this.cloneRequestWithBody(request, body)
      );
    } finally {
      await chat.shutdown().catch((err) => {
        logger.warn(
          { error: String(err) },
          "Failed to shut down Slack webhook chat"
        );
      });
    }
  }

  resolveAdapterConfig(options?: {
    requireOAuth?: boolean;
  }): PlatformAdapterConfig {
    const currentConfig = readSlackAppEnvConfig();
    const {
      signingSecret,
      clientId,
      clientSecret,
      encryptionKey,
      installationKeyPrefix,
      userName,
    } = currentConfig;

    if (!signingSecret) {
      throw new Error("Slack signing secret is not configured. Set SLACK_SIGNING_SECRET.");
    }

    if (options?.requireOAuth) {
      if (!clientId || !clientSecret) {
        throw new Error(
          "Slack OAuth is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."
        );
      }

      return {
        platform: "slack",
        signingSecret,
        clientId,
        clientSecret,
        ...(encryptionKey ? { encryptionKey } : {}),
        ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
        ...(userName ? { userName } : {}),
      };
    }

    const botToken = currentConfig.botToken;
    if (!botToken && (!clientId || !clientSecret)) {
      throw new Error(
        "Slack adapter is not configured. Set SLACK_BOT_TOKEN, or SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."
      );
    }

    return {
      platform: "slack",
      signingSecret,
      ...(botToken ? { botToken } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(encryptionKey ? { encryptionKey } : {}),
      ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
      ...(userName ? { userName } : {}),
    };
  }

  /**
   * Reply to a user in an unclaimed workspace with the connect link, using the
   * pending install's bot token. Only responds to a real @mention or DM — never
   * to challenges, retries, or the bot's own messages — and always acks 200 so
   * Slack doesn't retry (and so we never double-post).
   */
  private async replyUnclaimedWorkspace(
    botToken: string,
    teamId: string,
    body: string,
    contentType: string,
    isRetry: boolean,
  ): Promise<Response> {
    const ack = new Response("", { status: 200 });
    if (isRetry) return ack;
    const event = parseSlackUserMessageEvent(body, contentType);
    if (!event) return ack;
    const webBase = getConfiguredPublicOrigin()?.replace(/\/+$/, "");
    if (!webBase) return ack;
    const claimUrl = `${webBase}/connector/slack/connection?ref=${encodeURIComponent(teamId)}`;
    const text = `👋 This Slack workspace isn't connected to Lobu yet. A workspace admin can connect it here: ${claimUrl}`;
    try {
      await createSlackWebApi().postMessage(botToken, event.channel, text);
    } catch (error) {
      logger.warn(
        { teamId, error: String(error) },
        "Slack unclaimed-workspace connect reply failed",
      );
    }
    return ack;
  }

  extractTeamId(body: string, contentType: string): string | null {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      const directTeamId = params.get("team_id");
      if (directTeamId) {
        return directTeamId;
      }

      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return null;
      }

      try {
        const payload = JSON.parse(payloadStr) as {
          team?: { id?: string };
          team_id?: string;
        };
        return payload.team?.id || payload.team_id || null;
      } catch {
        return null;
      }
    }

    try {
      const payload = JSON.parse(body) as {
        team_id?: string;
        team?: string;
        event?: { team_id?: string; team?: string };
      };
      return (
        payload.team_id ||
        payload.team ||
        payload.event?.team_id ||
        payload.event?.team ||
        null
      );
    } catch {
      return null;
    }
  }

  /**
   * The Slack Enterprise Grid enterprise id for a delivery, or null for a plain
   * workspace. Events on a Grid workspace arrive stamped with a SIBLING
   * workspace's `team_id`, so the exact team-id install lookup misses; the
   * enterprise id (shared across the Grid) is the fallback routing key. Read from
   * top-level `enterprise_id` / `context_enterprise_id`, then the first
   * authorization's `enterprise_id` (interactive `payload` for form posts).
   */
  extractEnterpriseId(body: string, contentType: string): string | null {
    const fromPayload = (payload: {
      enterprise_id?: string;
      context_enterprise_id?: string;
      enterprise?: { id?: string };
      authorizations?: Array<{ enterprise_id?: string | null }>;
    }): string | null =>
      payload.enterprise_id ||
      payload.context_enterprise_id ||
      payload.enterprise?.id ||
      payload.authorizations?.[0]?.enterprise_id ||
      null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      const direct = params.get("enterprise_id");
      if (direct) return direct;
      const payloadStr = params.get("payload");
      if (!payloadStr) return null;
      try {
        return fromPayload(JSON.parse(payloadStr));
      } catch {
        return null;
      }
    }

    try {
      return fromPayload(JSON.parse(body));
    } catch {
      return null;
    }
  }

  private async createOAuthChat(options?: { requireOAuth?: boolean }) {
    const { createSlackAdapter } = await import("@chat-adapter/slack");

    const adapter = createSlackAdapter(
      this.resolveAdapterConfig(options) as any
    );
    const state = await this.deps.createStateAdapter();

    const chat = new Chat({
      userName: "lobu-slack-oauth",
      adapters: { slack: adapter },
      state,
      logger: "warn",
    });

    await chat.initialize();
    return { chat, adapter: adapter as SlackOAuthAdapter };
  }

  private cloneRequestWithBody(request: Request, body: string): Request {
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : body,
    });
  }

  private async handleTeamJoinWelcome(
    connectionId: string,
    event: ParsedSlackTeamJoinEvent
  ): Promise<void> {
    const chat = this.deps.getRunningChat(connectionId);
    if (!chat) {
      return;
    }

    try {
      await postSlackTeamJoinWelcome(chat, event);
    } catch (error) {
      logger.warn(
        {
          connectionId,
          teamId: event.teamId,
          userId: event.userId,
          error: String(error),
        },
        "Failed to send Slack team_join welcome message"
      );
    }
  }
}
