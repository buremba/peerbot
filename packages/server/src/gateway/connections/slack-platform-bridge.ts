import { createChatReply } from "../commands/command-reply-adapters.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import type { PlatformConnection } from "./types.js";

const DEFAULT_SLACK_COMMAND = "/lobu";
const DEFAULT_SLACK_TEAM_JOIN_WELCOME =
  "Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands.";

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
    const channelId =
      typeof raw.channel_id === "string" ? raw.channel_id : undefined;
    const teamId = typeof raw.team_id === "string" ? raw.team_id : undefined;
    const userId =
      event.user?.userId ||
      (typeof raw.user_id === "string" ? raw.user_id : undefined);

    if (!channelId || !userId || !event.channel) {
      return;
    }

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
        isGroup: isSlackGroupChannel(channelId),
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
