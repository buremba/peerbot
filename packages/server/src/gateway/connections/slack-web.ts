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
}

async function slackPost(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
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
  };
}
