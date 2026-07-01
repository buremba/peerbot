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
  /**
   * `users.info` → the workspace-admin flags for one user. Used by the
   * marketplace-claim flow to verify the claiming user is a workspace admin or
   * owner before binding the pending install to their org. Throws on a
   * Slack-level error (the caller treats a throw as a failed claim).
   */
  usersInfo(
    botToken: string,
    userId: string
  ): Promise<{ isAdmin: boolean; isOwner: boolean }>;
  /**
   * `auth.revoke` — invalidate a bot token so an abandoned install can't leave a
   * live credential lying around. Best-effort by contract: an already-invalid or
   * unknown token yields a Slack-level error (`invalid_auth`, `token_revoked`)
   * which this throws on, and the caller treats any throw as "already gone" and
   * continues. Resolves to Slack's `revoked` flag on success. Used by the
   * expired-pending-install reaper.
   */
  revokeToken(botToken: string): Promise<boolean>;
  /**
   * `oauth.v2.access` — exchange an OAuth `code` for the workspace bot token +
   * tenant/installer identity. Unlike the other methods this authenticates with
   * the app's client id/secret (not a bot token), so it lives outside
   * {@link slackPost}. Used by the marketplace / Slack-initiated install path,
   * which lands at the callback with a `code` but no Lobu-minted state — we need
   * the raw response (`authed_user`, `team`, `bot_user_id`) to park a pending
   * install and DM the installer to claim it.
   */
  exchangeOAuthCode(params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{
    botToken: string;
    teamId: string;
    teamName: string | null;
    botUserId: string | null;
    authedUserId: string | null;
    isEnterpriseInstall: boolean;
  }>;
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
    async usersInfo(botToken, userId) {
      const json = await slackPost(botToken, "users.info", { user: userId });
      const user = json.user as
        | { is_admin?: boolean; is_owner?: boolean }
        | undefined;
      return {
        isAdmin: user?.is_admin === true,
        isOwner: user?.is_owner === true,
      };
    },
    async revokeToken(botToken) {
      const json = await slackPost(botToken, "auth.revoke", {});
      return json.revoked === true;
    },
    async exchangeOAuthCode({ clientId, clientSecret, code, redirectUri }) {
      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const res = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: form.toString(),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (json.ok !== true) {
        throw new Error(
          `Slack oauth.v2.access failed: ${String(json.error ?? res.status)}`
        );
      }
      const team = json.team as { id?: string; name?: string } | undefined;
      const authedUser = json.authed_user as { id?: string } | undefined;
      const botToken = json.access_token;
      const teamId = team?.id;
      if (typeof botToken !== "string" || !botToken) {
        throw new Error("Slack oauth.v2.access returned no access_token");
      }
      if (typeof teamId !== "string" || !teamId) {
        throw new Error("Slack oauth.v2.access returned no team id");
      }
      return {
        botToken,
        teamId,
        teamName: typeof team?.name === "string" ? team.name : null,
        botUserId:
          typeof json.bot_user_id === "string" ? json.bot_user_id : null,
        authedUserId:
          typeof authedUser?.id === "string" ? authedUser.id : null,
        isEnterpriseInstall: json.is_enterprise_install === true,
      };
    },
  };
}
