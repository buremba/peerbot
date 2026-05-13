import { createLogger } from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import { startAuthCodeFlow } from "../auth/mcp/oauth-flow.js";
import {
  deleteCredential,
  getStoredCredential,
} from "../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../secrets/index.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("slack-platform-bridge");

const DEFAULT_SLACK_COMMAND = "/lobu";
const DEFAULT_SLACK_TEAM_JOIN_WELCOME =
  "Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands.";
const DEFAULT_SLACK_APP_NAME = "Lobu";

const HOME_ACTION_CONNECT = "lobu_home_connect";
const HOME_ACTION_DISCONNECT = "lobu_home_disconnect";

type SlackSlashEvent = {
  text?: string;
  raw?: Record<string, unknown>;
  user?: { userId?: string };
  channel?: { post: (content: any) => Promise<unknown> };
};

type SlackTeamJoinPayload = {
  type?: string;
  team_id?: string;
  event?: {
    type?: string;
    user?: {
      id?: string;
      is_bot?: boolean;
      deleted?: boolean;
      real_name?: string;
      profile?: {
        display_name?: string;
        real_name?: string;
      };
    };
  };
};

export type ParsedSlackTeamJoinEvent = {
  teamId: string;
  userId: string;
  displayName?: string;
};

function isSlackGroupChannel(channelId: string): boolean {
  return !channelId.startsWith("D");
}

function parseSlackCommandText(text: string | undefined): {
  commandName: string;
  commandArgs: string;
} {
  const trimmed = text?.trim() || "";
  if (!trimmed) {
    return { commandName: "help", commandArgs: "" };
  }

  const [firstToken = "", ...rest] = trimmed.split(/\s+/);
  return {
    commandName: firstToken.replace(/^\/+/, "").toLowerCase() || "help",
    commandArgs: rest.join(" ").trim(),
  };
}

export function registerSlackPlatformHandlers(
  chat: any,
  connection: PlatformConnection,
  commandDispatcher?: CommandDispatcher
): void {
  if (connection.platform !== "slack" || !commandDispatcher) {
    return;
  }

  chat.onSlashCommand(DEFAULT_SLACK_COMMAND, async (event: SlackSlashEvent) => {
    const raw = event.raw || {};
    const rawChannelId =
      typeof raw.channel_id === "string" ? raw.channel_id : undefined;
    const teamId = typeof raw.team_id === "string" ? raw.team_id : undefined;
    const userId =
      event.user?.userId ||
      (typeof raw.user_id === "string" ? raw.user_id : undefined);

    if (!rawChannelId || !userId || !event.channel) {
      return;
    }

    // Slack hands slash commands the bare channel id (`C…`/`D…`), but inbound
    // messages reach the dispatcher with the Chat SDK's `slack:<id>` thread
    // channel id — and `agent_channel_bindings` is keyed on that form. Use it
    // here too so `getBinding` lookups (and preview `/lobu link` bindings)
    // agree across both ingress paths.
    const channelId = `slack:${rawChannelId}`;

    const { commandName, commandArgs } = parseSlackCommandText(event.text);
    const reply = createChatReply(async (content) => {
      await event.channel!.post(content);
    });
    const handled = await commandDispatcher.tryHandle(
      commandName,
      commandArgs,
      {
        platform: "slack",
        userId,
        channelId,
        teamId,
        isGroup: isSlackGroupChannel(rawChannelId),
        connectionId: connection.id,
        reply,
      }
    );

    if (!handled) {
      await reply(
        `Unknown /lobu subcommand: ${commandName}. Try \`/lobu help\`.`
      );
    }
  });
}

/** Adapter surface used by the home tab — `publishHomeView` lives on the Slack adapter. */
type SlackHomeAdapter = {
  publishHomeView?: (
    userId: string,
    view: Record<string, unknown>
  ) => Promise<void>;
};

type SlackAppHomeEvent = {
  userId: string;
  adapter?: SlackHomeAdapter;
};

type SlackActionEvent = {
  actionId: string;
  value?: string;
  user: { userId: string };
  adapter?: SlackHomeAdapter;
  raw?: unknown;
};

/** Dependencies the App Home tab needs to render status and run OAuth. */
export interface SlackAppHomeDeps {
  /**
   * The initialized Slack adapter — the one with the live `@slack/web-api`
   * client. The adapter handed to event handlers via `event.adapter` is the
   * webhook-dispatch instance and has no `client`, so `publishHomeView` must
   * go through this one.
   */
  adapter?: SlackHomeAdapter;
  mcpConfigService?: McpConfigService;
  secretStore?: WritableSecretStore;
  /** Public origin of the gateway — used to build the OAuth redirect URI. */
  publicGatewayUrl?: string;
}

// Internal plumbing MCPs (e.g. the Lobu memory backend) — not user integrations.
const HIDDEN_HOME_INTEGRATION_IDS = new Set(["lobu-memory"]);

function humanizeIntegrationName(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function teamIdFromRawPayload(raw: unknown): string | undefined {
  const team = (raw as { team?: { id?: unknown } } | undefined)?.team?.id;
  return typeof team === "string" ? team : undefined;
}

type IntegrationStatus = {
  id: string;
  name: string;
  requiresAuth: boolean;
  connected: boolean;
};

function integrationSection(
  status: IntegrationStatus,
  pendingAuthUrl?: string
): Record<string, unknown> {
  if (!status.requiresAuth) {
    return {
      type: "section",
      text: { type: "mrkdwn", text: `:white_circle: *${status.name}*` },
    };
  }
  if (status.connected) {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *${status.name}*  ·  connected`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Disconnect" },
        action_id: HOME_ACTION_DISCONNECT,
        value: status.id,
        style: "danger",
      },
    };
  }
  if (pendingAuthUrl) {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:hourglass_flowing_sand: *${status.name}*  ·  finish signing in`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open sign-in ↗" },
        url: pendingAuthUrl,
      },
    };
  }
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:white_circle: *${status.name}*  ·  not connected`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Connect" },
      action_id: HOME_ACTION_CONNECT,
      value: status.id,
      style: "primary",
    },
  };
}

interface HomeViewParams {
  connection: PlatformConnection;
  deps: SlackAppHomeDeps;
  /** Slack user the home tab is being rendered for (credential scope key). */
  userId: string;
  /** MCP ids → freshly-minted authorization URL, shown as an "Open sign-in" link. */
  pendingAuthUrls?: Record<string, string>;
}

async function buildSlackHomeBlocks(params: HomeViewParams): Promise<unknown[]> {
  const { connection, deps, userId, pendingAuthUrls } = params;
  const botName =
    (typeof connection.metadata?.botUsername === "string" &&
      connection.metadata.botUsername) ||
    DEFAULT_SLACK_APP_NAME;
  const isPreview = connection.settings?.previewMode === true;

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${botName}* :wave:\n\nMention me in any channel, or send me a DM, to start a thread.`,
      },
    },
    { type: "divider" },
  ];

  if (!isPreview && connection.agentId && deps.mcpConfigService) {
    try {
      const statuses = await loadIntegrationStatusesScoped(
        connection.agentId,
        userId,
        deps
      );
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: "Integrations" },
      });
      if (statuses.length === 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_No integrations connected yet._",
          },
        });
      } else {
        for (const status of statuses) {
          blocks.push(integrationSection(status, pendingAuthUrls?.[status.id]));
        }
      }
      blocks.push({ type: "divider" });
    } catch (error) {
      logger.warn(
        { error, agentId: connection.agentId },
        "Failed to load integrations for Slack home tab; rendering without them"
      );
    }
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: isPreview
        ? "This is a *preview* workspace. Run `lobu run`, then use `/lobu link <code>` in a channel to connect your own agent."
        : "*Tips*\n• Mention me in a channel, or DM me directly.\n• `/lobu help` lists the built-in commands.\n• Integrations that need you to sign in will also prompt you with a button right in the thread.",
    },
  });

  return blocks;
}

// Resolve the agent's integrations plus this user's connection status. The
// Slack user id is the credential scope key (home-tab connect is per-user).
async function loadIntegrationStatusesScoped(
  agentId: string,
  userId: string,
  deps: SlackAppHomeDeps
): Promise<IntegrationStatus[]> {
  const mcpConfigService = deps.mcpConfigService;
  if (!mcpConfigService) return [];
  const statuses = (await mcpConfigService.getMcpStatus(agentId)).filter(
    (s) => !HIDDEN_HOME_INTEGRATION_IDS.has(s.id)
  );
  const result: IntegrationStatus[] = [];
  for (const s of statuses) {
    let connected = false;
    if (s.requiresAuth && deps.secretStore) {
      try {
        connected = !!(await getStoredCredential(
          deps.secretStore,
          agentId,
          userId,
          s.id
        ));
      } catch {
        connected = false;
      }
    }
    result.push({
      id: s.id,
      name: humanizeIntegrationName(s.name || s.id),
      requiresAuth: s.requiresAuth,
      connected,
    });
  }
  return result;
}

/** Extract something useful out of a Slack `WebAPIPlatformError` (or anything). */
function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const data = (error as { data?: unknown }).data;
    return {
      message: error.message,
      ...(data && typeof data === "object" ? { slack: data } : {}),
    };
  }
  return { message: String(error) };
}

const HOME_FALLBACK_BLOCKS: unknown[] = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Lobu* :wave:\n\nMention me in any channel, or send me a DM, to start a thread. Use `/lobu help` for the built-in commands.",
    },
  },
];

async function publishHome(
  adapter: SlackHomeAdapter | undefined,
  params: HomeViewParams
): Promise<void> {
  const publishHomeView = adapter?.publishHomeView;
  if (typeof publishHomeView !== "function") return;
  try {
    const blocks = await buildSlackHomeBlocks(params);
    await publishHomeView(params.userId, { type: "home", blocks });
  } catch (error) {
    logger.warn(
      {
        error: errorDetail(error),
        connectionId: params.connection.id,
        userId: params.userId,
      },
      "Failed to publish Slack home tab; falling back to a minimal view"
    );
    // The rich view failed (likely Block Kit validation). Don't leave the user
    // staring at a stale cached view — publish a plain text-only home tab.
    try {
      await publishHomeView(params.userId, {
        type: "home",
        blocks: HOME_FALLBACK_BLOCKS,
      });
    } catch (fallbackError) {
      logger.warn(
        {
          error: errorDetail(fallbackError),
          connectionId: params.connection.id,
          userId: params.userId,
        },
        "Failed to publish fallback Slack home tab"
      );
    }
  }
}

/**
 * Guard against a crafted `block_actions` payload pointing at an MCP the agent
 * doesn't actually have configured. Connect already validates implicitly (a
 * missing `getHttpServer` is a no-op); this keeps Disconnect from issuing a
 * `secretStore.delete` with an attacker-supplied key string.
 */
async function isKnownIntegration(
  agentId: string,
  mcpId: string,
  deps: SlackAppHomeDeps
): Promise<boolean> {
  if (HIDDEN_HOME_INTEGRATION_IDS.has(mcpId)) return false;
  const mcpConfigService = deps.mcpConfigService;
  if (!mcpConfigService) return false;
  try {
    const statuses = await mcpConfigService.getMcpStatus(agentId);
    return statuses.some((s) => s.id === mcpId);
  } catch {
    return false;
  }
}

async function startMcpConnectFlow(params: {
  connection: PlatformConnection;
  deps: SlackAppHomeDeps;
  agentId: string;
  userId: string;
  mcpId: string;
  teamId?: string;
}): Promise<string | null> {
  const { connection, deps, agentId, userId, mcpId, teamId } = params;
  const mcpConfigService = deps.mcpConfigService;
  if (!mcpConfigService || !deps.secretStore || !deps.publicGatewayUrl) {
    return null;
  }
  const httpServer = await mcpConfigService.getHttpServer(mcpId, agentId);
  if (!httpServer) return null;
  const redirectUri = `${deps.publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
  const { authorizationUrl } = await startAuthCodeFlow({
    secretStore: deps.secretStore,
    mcpId,
    upstreamUrl: httpServer.upstreamUrl,
    agentId,
    userId,
    // Home-tab connect is always per-user.
    scopeKey: userId,
    wwwAuthenticate: null,
    redirectUri,
    staticOauth: httpServer.oauth,
    platform: "slack",
    channelId: userId,
    conversationId: userId,
    teamId,
    connectionId: connection.id,
  });
  return authorizationUrl;
}

/**
 * Publish the Slack App Home tab and wire its Connect / Disconnect buttons.
 *
 * The home view lists the integrations the owning agent can use, with a live
 * per-user status: `Disconnect` for ones the user has authorised, `Connect`
 * for the rest. `Connect` runs the MCP OAuth auth-code flow and re-publishes
 * the home tab with an `Open sign-in ↗` link; `Disconnect` revokes the stored
 * credential. Skipped for preview workspaces and when the MCP config / secret
 * store aren't available.
 */
export function registerSlackAppHome(
  chat: any,
  connection: PlatformConnection,
  deps: SlackAppHomeDeps = {}
): void {
  if (connection.platform !== "slack") {
    return;
  }

  chat.onAppHomeOpened(async (event: SlackAppHomeEvent) => {
    await publishHome(deps.adapter ?? event.adapter, {
      connection,
      deps,
      userId: event.userId,
    });
  });

  chat.onAction(
    [HOME_ACTION_CONNECT, HOME_ACTION_DISCONNECT],
    async (event: SlackActionEvent) => {
      const mcpId = event.value;
      const userId = event.user?.userId;
      const agentId = connection.agentId;
      if (!mcpId || !userId || !agentId) return;
      // `mcpId` comes from the (Slack-signed) button payload, but only the
      // button labels are ours — reject anything not in the agent's config.
      if (!(await isKnownIntegration(agentId, mcpId, deps))) {
        logger.warn(
          { agentId, userId, mcpId, actionId: event.actionId },
          "Ignoring Slack home action for an unknown integration"
        );
        return;
      }

      if (event.actionId === HOME_ACTION_DISCONNECT) {
        if (deps.secretStore) {
          try {
            await deleteCredential(deps.secretStore, agentId, userId, mcpId);
          } catch (error) {
            logger.warn(
              { error, agentId, userId, mcpId },
              "Failed to disconnect MCP credential from Slack home tab"
            );
          }
        }
        await publishHome(deps.adapter ?? event.adapter, { connection, deps, userId });
        return;
      }

      // Connect: mint an authorization URL, then re-publish with the link.
      let authorizationUrl: string | null = null;
      try {
        authorizationUrl = await startMcpConnectFlow({
          connection,
          deps,
          agentId,
          userId,
          mcpId,
          teamId: teamIdFromRawPayload(event.raw),
        });
      } catch (error) {
        logger.warn(
          { error, agentId, userId, mcpId },
          "Failed to start MCP OAuth flow from Slack home tab"
        );
      }
      await publishHome(deps.adapter ?? event.adapter, {
        connection,
        deps,
        userId,
        pendingAuthUrls: authorizationUrl ? { [mcpId]: authorizationUrl } : {},
      });
    }
  );
}

export function parseSlackTeamJoinEvent(
  body: string,
  contentType: string
): ParsedSlackTeamJoinEvent | null {
  if (!contentType.includes("application/json")) {
    return null;
  }

  let payload: SlackTeamJoinPayload;
  try {
    payload = JSON.parse(body) as SlackTeamJoinPayload;
  } catch {
    return null;
  }

  if (
    payload.type !== "event_callback" ||
    payload.event?.type !== "team_join"
  ) {
    return null;
  }

  const teamId = payload.team_id;
  const user = payload.event.user;
  if (!teamId || !user?.id || user.is_bot || user.deleted) {
    return null;
  }

  const displayName =
    user.profile?.display_name || user.profile?.real_name || user.real_name;

  return {
    teamId,
    userId: user.id,
    ...(displayName ? { displayName } : {}),
  };
}

export async function postSlackTeamJoinWelcome(
  chat: any,
  event: ParsedSlackTeamJoinEvent
): Promise<void> {
  const thread = await chat.openDM(event.userId);
  const greeting = event.displayName
    ? `Welcome to Lobu, ${event.displayName}.`
    : "Welcome to Lobu.";
  await thread.post(`${greeting} ${DEFAULT_SLACK_TEAM_JOIN_WELCOME}`);
}
