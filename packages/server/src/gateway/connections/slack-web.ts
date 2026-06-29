import { createLogger } from "@lobu/core";

const logger = createLogger("slack-web");

/**
 * Minimal Slack Web API surface used by the connected-apps onboarding flow:
 * open a DM channel with a user and post a message into it.
 *
 * Deliberately a dependency-free `fetch` wrapper — NOT `@slack/web-api`, NOT the
 * chat adapter. These are one-shot calls made with an INSTALLED workspace's bot
 * token, outside any live connection (the user clicks "Connect my DM" on the web
 * app), so spinning up the full adapter would be wasteful. Behind the
 * {@link SlackWebApi} interface so routes can inject a stub in tests.
 */
export interface SlackWebApi {
  /** `conversations.open` with a single user → the IM channel id (`D…`). */
  openDm(botToken: string, slackUserId: string): Promise<string>;
  /** `chat.postMessage` of a plain-text body. Throws on a Slack-level error. */
  postMessage(botToken: string, channel: string, text: string): Promise<void>;
  /**
   * `conversations.members` for one channel — the bare `U…` ids of every member,
   * following `response_metadata.next_cursor` to completion. Throws on a
   * Slack-level error (the ACL sync treats a throw as fail-closed). Used by the
   * authz channel-membership sync to materialize the read-ACL graph.
   */
  conversationMembers(botToken: string, channelId: string): Promise<string[]>;
  /**
   * `conversations.info` → the channel's human-readable name (e.g. `general`)
   * and privacy flag. `name` is null when Slack omits it (e.g. a DM/MPIM or an
   * unreadable channel); callers fall back to the channel id.
   */
  conversationInfo(
    botToken: string,
    channelId: string
  ): Promise<{ name: string | null; isPrivate: boolean }>;
}

async function slackPost(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // Slack's read methods (conversations.members/list, users.info, …) accept ONLY
  // application/x-www-form-urlencoded — a JSON body yields `invalid_arguments`.
  // Form encoding is accepted by every Web API method (including chat.postMessage
  // / conversations.open used here), so encode uniformly.
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: form.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`Slack ${method} failed: ${String(json.error ?? res.status)}`);
  }
  return json;
}

export function createSlackWebApi(): SlackWebApi {
  return {
    async openDm(botToken, slackUserId) {
      const json = await slackPost(botToken, "conversations.open", {
        users: slackUserId,
      });
      const channel = json.channel as { id?: string } | undefined;
      const channelId = channel?.id;
      if (typeof channelId !== "string" || !channelId) {
        throw new Error("Slack conversations.open returned no channel id");
      }
      return channelId;
    },
    async postMessage(botToken, channel, text) {
      try {
        await slackPost(botToken, "chat.postMessage", { channel, text });
      } catch (error) {
        // The welcome message is best-effort; the binding is the contract.
        logger.warn(
          { channel, error: String(error) },
          "Slack chat.postMessage failed"
        );
        throw error;
      }
    },
    async conversationMembers(botToken, channelId) {
      const members: string[] = [];
      let cursor: string | undefined;
      do {
        const json = await slackPost(botToken, "conversations.members", {
          channel: channelId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        const page = Array.isArray(json.members)
          ? (json.members as unknown[]).filter(
              (m): m is string => typeof m === "string"
            )
          : [];
        members.push(...page);
        const meta = json.response_metadata as
          | { next_cursor?: string }
          | undefined;
        const next = meta?.next_cursor;
        cursor = next && next.length > 0 ? next : undefined;
      } while (cursor);
      return members;
    },
    async conversationInfo(botToken, channelId) {
      const json = await slackPost(botToken, "conversations.info", {
        channel: channelId,
      });
      const ch = json.channel as
        | { name?: string; is_private?: boolean }
        | undefined;
      return {
        name: typeof ch?.name === "string" ? ch.name : null,
        isPrivate: ch?.is_private === true,
      };
    },
  };
}
