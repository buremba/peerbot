import { createLogger } from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("slack-platform-bridge");

const DEFAULT_SLACK_COMMAND = "/lobu";
const DEFAULT_SLACK_TEAM_JOIN_WELCOME =
  "Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands.";
const DEFAULT_SLACK_APP_NAME = "Lobu";

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

type SlackAppHomeEvent = {
  userId: string;
  adapter?: {
    publishHomeView?: (
      userId: string,
      view: Record<string, unknown>
    ) => Promise<void>;
  };
};

// Internal plumbing MCPs (e.g. the Lobu memory backend) — not user integrations.
const HIDDEN_HOME_INTEGRATION_IDS = new Set(["lobu-memory"]);

function humanizeIntegrationName(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function buildIntegrationsBlock(
  agentId: string,
  mcpConfigService: McpConfigService
): Promise<Record<string, unknown> | null> {
  const statuses = (await mcpConfigService.getMcpStatus(agentId)).filter(
    (s) => !HIDDEN_HOME_INTEGRATION_IDS.has(s.id)
  );
  if (statuses.length === 0) {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Integrations*\n_No integrations connected yet._",
      },
    };
  }
  const lines = statuses
    .map((s) => {
      const name = humanizeIntegrationName(s.name || s.id);
      return s.requiresAuth ? `• ${name} — sign-in required` : `• ${name}`;
    })
    .join("\n");
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*Integrations you can use*\n${lines}` },
  };
}

async function buildSlackHomeBlocks(
  connection: PlatformConnection,
  mcpConfigService?: McpConfigService
): Promise<unknown[]> {
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

  if (!isPreview && connection.agentId && mcpConfigService) {
    try {
      const integrationsBlock = await buildIntegrationsBlock(
        connection.agentId,
        mcpConfigService
      );
      if (integrationsBlock) {
        blocks.push(integrationsBlock, { type: "divider" });
      }
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
        : "*Tips*\n• Mention me in a channel, or DM me directly.\n• `/lobu help` lists the built-in commands.\n• Integrations that need you to sign in will prompt you with a button right in the thread — there's nothing to set up here.",
    },
  });

  return blocks;
}

/**
 * Publish the Slack App Home tab whenever a user opens it. The home view is
 * derived per-connection: the bot's display name plus the list of integrations
 * the owning agent can use (skipped for preview workspaces and when the MCP
 * config can't be loaded). User-facing OAuth happens in-thread via interaction
 * buttons, so there is intentionally nothing to authorize from this surface.
 */
export function registerSlackAppHome(
  chat: any,
  connection: PlatformConnection,
  mcpConfigService?: McpConfigService
): void {
  if (connection.platform !== "slack") {
    return;
  }

  chat.onAppHomeOpened(async (event: SlackAppHomeEvent) => {
    const publishHomeView = event.adapter?.publishHomeView;
    if (typeof publishHomeView !== "function") {
      return;
    }
    try {
      const blocks = await buildSlackHomeBlocks(connection, mcpConfigService);
      await publishHomeView(event.userId, { type: "home", blocks });
    } catch (error) {
      logger.warn(
        { error, connectionId: connection.id, userId: event.userId },
        "Failed to publish Slack home tab"
      );
    }
  });
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
