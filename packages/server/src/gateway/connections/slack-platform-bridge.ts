import { createLogger } from "@lobu/core";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
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
	commandDispatcher?: CommandDispatcher,
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
        organizationId: connection.organizationId,
        reply,
			},
    );

    if (!handled) {
      await reply(
				`Unknown /lobu subcommand: ${commandName}. Try \`/lobu help\`.`,
      );
    }
  });
}

/** Adapter surface used by the home tab — `publishHomeView` lives on the Slack adapter. */
type SlackHomeAdapter = {
  publishHomeView?: (
    userId: string,
		view: Record<string, unknown>,
  ) => Promise<void>;
};

type SlackAppHomeEvent = {
  userId: string;
  adapter?: SlackHomeAdapter;
};

/** A single "what's recent" row for the home tab, mirroring the web's recent feed. */
export interface SlackHomeRecentItem {
  /** Display title (event title, or a payload snippet, or a fallback). */
  title: string;
  /** Source label (connector key / platform), or null when unknown. */
  platform: string | null;
  /** Unix seconds of occurred_at|created_at — rendered via a Slack date token. */
  ts: number;
}

/** A single per-user notification row for the home tab. */
export interface SlackHomeNotification {
  /** Notification title. */
  title: string;
  /** Absolute deep link to the resource, or null when none. */
  url: string | null;
  /** Whether the user has already read it. */
  isRead: boolean;
}

/**
 * The viewing user's personal notification inbox (from `notification_targets`),
 * resolved by mapping their Slack user id → Lobu user id. Null when the user
 * hasn't linked an agent yet (no identity) — they see the setup prompt instead.
 */
export interface SlackHomeInbox {
  unreadCount: number;
  items: SlackHomeNotification[];
  /** The user's primary org slug, for deep-linking the setup button to their org home. */
  orgSlug: string | null;
}

/**
 * Glanceable, org-scoped context for the home tab's dashboard card. `events`
 * has no per-agent or per-user attribution column, so every count here is
 * organization-wide — never present it as "your" items.
 */
export interface SlackHomeContext {
  /** Org slug for the dashboard deep link, or null if it can't be resolved. */
  orgSlug: string | null;
  /** Non-deleted entities tracked in the org. */
  entitiesTracked: number;
  /** Events captured today (org-wide, local server day). */
  capturedToday: number;
  /** Most-recent org events (mirrors the web "recent" feed), newest first. */
  recent: SlackHomeRecentItem[];
}

/** Dependencies the App Home tab needs to render status and run OAuth. */
interface SlackAppHomeDeps {
  /**
   * The initialized Slack adapter — the one with the live `@slack/web-api`
   * client. The adapter handed to event handlers via `event.adapter` is the
   * webhook-dispatch instance and has no `client`, so `publishHomeView` must
   * go through this one.
   */
  adapter?: SlackHomeAdapter;
  /**
   * Public origin of the gateway — since the web SPA is served same-origin,
   * this is the base for the dashboard deep link and preview setup prompt.
   */
  publicGatewayUrl?: string;
  /**
   * Resolves the org dashboard slug + glanceable counts for the home tab.
   * Read-only; failures degrade gracefully to a slug-less dashboard link.
   */
  resolveHomeContext?: (
    organizationId: string,
  ) => Promise<SlackHomeContext | null>;
  /**
   * Resolves the viewing Slack user's personal notification inbox, or null when
   * they have no linked Lobu identity. `teamId` scopes the lookup to the
   * correct Slack workspace (empty string for hosted-preview connections, which
   * write identity rows with team_id=''). Read-only; failures degrade to no inbox.
   */
  resolveUserInbox?: (
    slackUserId: string,
    teamId: string,
  ) => Promise<SlackHomeInbox | null>;
}

/** Trim a trailing slash so we can append `/segment` cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Turn a connector key like `apple.screen_time` into `Apple Screen Time`. */
function humanizeSource(platform: string | null): string | null {
  if (!platform) return null;
  return platform.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) =>
    c.toUpperCase(),
  );
}

/** Escape Slack mrkdwn control chars so titles can't inject formatting. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the "Recent activity" list as a single section, or `[]` if empty. */
function recentBlocks(
  recent: SlackHomeRecentItem[],
): Record<string, unknown>[] {
  if (recent.length === 0) return [];
  const lines = recent.map((item) => {
    const title = escapeMrkdwn(item.title);
    const source = humanizeSource(item.platform);
    // `<!date^…>` renders in the viewer's own timezone; the pipe text is the
    // fallback Slack shows if it can't resolve the token.
    const when = `<!date^${item.ts}^{date_short_pretty}|recently>`;
    return source
      ? `• *${title}*  ·  ${escapeMrkdwn(source)}  ·  ${when}`
      : `• *${title}*  ·  ${when}`;
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Recent activity*\n${lines.join("\n")}` },
    },
    { type: "divider" },
  ];
}

/**
 * The dashboard card: a "Open dashboard" deep link into the web app plus a
 * context line of org-wide counts. Returns `[]` when there's nowhere to link
 * (no public URL), so the home tab still renders without it.
 */
function dashboardBlocks(
  webBaseUrl: string | undefined,
  context: SlackHomeContext | null,
): Record<string, unknown>[] {
  if (!webBaseUrl) return [];
  const base = trimTrailingSlash(webBaseUrl);
  const dashboardUrl = context?.orgSlug ? `${base}/${context.orgSlug}` : base;

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Your dashboard*\nBrowse everything I've captured, review entities, and tune what I watch.",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open dashboard ↗" },
        url: dashboardUrl,
        style: "primary",
      },
    },
  ];

  if (context && (context.entitiesTracked > 0 || context.capturedToday > 0)) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:bar_chart: ${context.entitiesTracked.toLocaleString()} tracked  ·  ${context.capturedToday.toLocaleString()} captured today`,
        },
      ],
    });
  }

  blocks.push({ type: "divider" });
  return blocks;
}

/**
 * The viewing user's notifications, newest first, each linking to its resource.
 * Relative `resource_url`s are made absolute against the web origin so Slack can
 * link them. Returns `[]` when the inbox is empty/absent.
 */
function notificationBlocks(
  webBaseUrl: string | undefined,
  inbox: SlackHomeInbox | null,
): Record<string, unknown>[] {
  if (!inbox || inbox.items.length === 0) return [];
  const base = webBaseUrl ? trimTrailingSlash(webBaseUrl) : undefined;
  const absolute = (url: string): string =>
    /^https?:\/\//.test(url) || !base
      ? url
      : `${base}/${url.replace(/^\/+/, "")}`;

  const lines = inbox.items.map((item) => {
    const dot = item.isRead ? ":white_circle:" : ":large_blue_circle:";
    const title = escapeMrkdwn(item.title);
    return item.url
      ? `${dot} <${absolute(item.url)}|${title}>`
      : `${dot} ${title}`;
  });
  const header =
    inbox.unreadCount > 0
      ? `*Notifications* · ${inbox.unreadCount} unread`
      : "*Notifications*";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${header}\n${lines.join("\n")}` },
    },
    { type: "divider" },
  ];
}

/**
 * Preview-workspace onboarding: a button to set up an agent for this DM in the
 * web app, alongside the `/lobu link <code>` CLI path. Deep-links to the user's
 * org home `/{slug}` (the Builder — where agents are created/configured and a
 * channel is connected per agent) when we know their org, else the web root
 * (which logs them in and routes there). `/{slug}/agents` is intentionally NOT
 * used — it redirects to `/{slug}`. Returns `[]` with no web URL.
 */
function setupBlocks(
  webBaseUrl: string | undefined,
  orgSlug: string | null,
): Record<string, unknown>[] {
  if (!webBaseUrl) return [];
  const base = trimTrailingSlash(webBaseUrl);
  const setupUrl = orgSlug ? `${base}/${orgSlug}` : base;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Set up your own agent*\nConnect an agent to this DM so I can answer from your own data.",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Set up your agent ↗" },
        url: setupUrl,
        style: "primary",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Already have a code? Run `/lobu link <code>` here. Get a code from your dashboard or `lobu run`.",
        },
      ],
    },
    { type: "divider" },
  ];
}

interface HomeViewParams {
  connection: PlatformConnection;
  deps: SlackAppHomeDeps;
  /** Slack user the home tab is being rendered for (credential scope key). */
  userId: string;
}

async function buildSlackHomeBlocks(
	params: HomeViewParams,
): Promise<unknown[]> {
  const { connection, deps, userId } = params;
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
        text: `*${botName}* :wave:\n\nI watch your tools, build shared memory, and act on your goals. Mention me in any channel, or send me a DM, to start a thread.`,
      },
    },
    { type: "divider" },
  ];

  // Personal notifications, for users who've linked a Lobu identity (both
  // preview and BYO connections). Scoped by teamId to prevent cross-workspace
  // leaks when platform_user_id collides across Slack workspaces. Preview
  // connections write identity rows with team_id='', so we pass '' there.
  const teamId =
    typeof connection.metadata?.teamId === "string"
      ? connection.metadata.teamId
      : "";
  let inbox: SlackHomeInbox | null = null;
  try {
    inbox = (await deps.resolveUserInbox?.(userId, teamId)) ?? null;
  } catch (error) {
    logger.warn(
      { error, userId },
      "Failed to resolve Slack home notifications; rendering without them",
    );
  }
  blocks.push(...notificationBlocks(deps.publicGatewayUrl, inbox));

  if (!isPreview && connection.organizationId) {
    let context: SlackHomeContext | null = null;
    try {
      context =
        (await deps.resolveHomeContext?.(connection.organizationId)) ?? null;
    } catch (error) {
      logger.warn(
        { error, organizationId: connection.organizationId },
        "Failed to resolve Slack home dashboard context; rendering link without counts",
      );
    }
    blocks.push(...dashboardBlocks(deps.publicGatewayUrl, context));
    blocks.push(...recentBlocks(context?.recent ?? []));
  }

  if (isPreview) {
    blocks.push(...setupBlocks(deps.publicGatewayUrl, inbox?.orgSlug ?? null));
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: isPreview
        ? "Mention me in a channel or DM me to start a thread. `/lobu help` lists the commands."
        : "*Tips*\n• Mention me in a channel, or DM me directly.\n• `/lobu help` lists the built-in commands.\n• Integrations that need you to sign in will also prompt you with a button right in the thread.",
    },
  });

  return blocks;
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
	params: HomeViewParams,
): Promise<void> {
  if (typeof adapter?.publishHomeView !== "function") return;
  // Call `publishHomeView` AS A METHOD on the adapter. Extracting it into a
  // local (`const fn = adapter.publishHomeView; fn(...)`) drops the `this`
  // binding, so inside `@chat-adapter/slack` `this` is undefined and
  // `this.client.views.publish(...)` throws "Cannot read properties of
  // undefined (reading 'client')" — failing every publish, rich AND fallback,
  // which left the App Home tab frozen on its last-published view.
  try {
    const blocks = await buildSlackHomeBlocks(params);
    await adapter.publishHomeView(params.userId, { type: "home", blocks });
  } catch (error) {
    // Message-first: the console logger drops the metadata object for
    // pino-style `logger.warn({...}, "msg")` calls, so inline the detail here.
    logger.warn(
      `Failed to publish Slack home tab (conn=${params.connection.id} user=${params.userId}); falling back: ${JSON.stringify(errorDetail(error))}`,
    );
    // The rich view failed. Don't leave the user staring at a stale cached
    // view — publish a plain text-only home tab.
    try {
      await adapter.publishHomeView(params.userId, {
        type: "home",
        blocks: HOME_FALLBACK_BLOCKS,
      });
    } catch (fallbackError) {
      logger.warn(
        `Failed to publish fallback Slack home tab (conn=${params.connection.id}): ${JSON.stringify(errorDetail(fallbackError))}`,
      );
    }
  }
}

/**
 * Publish the Slack App Home tab when a user opens it.
 *
 * The home view shows the bot intro, the user's personal notification inbox
 * (when they've linked a Lobu identity), the org dashboard card with recent
 * activity, and a preview-workspace setup prompt. It re-renders on every
 * `app_home_opened` event.
 */
export function registerSlackAppHome(
  chat: any,
  connection: PlatformConnection,
	deps: SlackAppHomeDeps = {},
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
}

export function parseSlackTeamJoinEvent(
  body: string,
	contentType: string,
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
	event: ParsedSlackTeamJoinEvent,
): Promise<void> {
  const thread = await chat.openDM(event.userId);
  const greeting = event.displayName
    ? `Welcome to Lobu, ${event.displayName}.`
    : "Welcome to Lobu.";
  await thread.post(`${greeting} ${DEFAULT_SLACK_TEAM_JOIN_WELCOME}`);
}
