/**
 * Slack webhook signing helper for integration tests.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 */
import { createHmac } from "node:crypto";

function signSlackRequest(
  signingSecret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000)
): { signature: string; timestamp: string } {
  const timestamp = String(timestampSeconds);
  const basestring = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;
  return { signature, timestamp };
}

/**
 * Build a signed fetch Request carrying a Slack block_actions payload.
 * `payload` is the Slack interactive payload JSON; it gets form-encoded as `payload={json}`.
 */
export function buildSignedBlockActionsRequest(
  signingSecret: string,
  payload: Record<string, unknown>
): Request {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const { signature, timestamp } = signSlackRequest(signingSecret, body);
  return new Request("https://example.test/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

export function blockActionsPayload(options: {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  actionId: string;
  value: string;
  triggerId?: string;
}): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: options.teamId, domain: "test" },
    user: {
      id: options.userId,
      username: "tester",
      name: "tester",
      team_id: options.teamId,
    },
    api_app_id: "A000000",
    token: "verification-token",
    container: {
      type: "message",
      message_ts: options.messageTs,
      channel_id: options.channelId,
      is_ephemeral: false,
    },
    trigger_id: options.triggerId ?? "123.456.abc",
    channel: { id: options.channelId, name: "general" },
    message: {
      ts: options.messageTs,
      thread_ts: options.messageTs,
      type: "message",
      user: "U_BOT",
      text: "",
    },
    response_url: "https://hooks.slack.test/response",
    actions: [
      {
        action_id: options.actionId,
        block_id: "block-1",
        type: "button",
        value: options.value,
        action_ts: String(Date.now() / 1000),
      },
    ],
  };
}
