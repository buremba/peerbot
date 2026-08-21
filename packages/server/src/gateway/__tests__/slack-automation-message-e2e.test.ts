/**
 * Assembled Slack chat-automation regression.
 *
 * Fakes stop at Slack's network boundary. The test drives a signed Events API
 * request through the real Slack adapter and Chat SDK, then uses the real
 * channel subscription reader, Automation planner, transcript writer,
 * Postgres run queue, and Slack completion strategy.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, type StateAdapter } from "chat";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import { getDb } from "../../db/client.js";
import { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { registerMessageHandlers } from "../connections/message-handler-bridge.js";
import { getResponseStrategy } from "../connections/platform-strategies/index.js";
import { createConnectedGatewayStateAdapter } from "../connections/state-adapter.js";
import type { PlatformConnection } from "../connections/types.js";
import { QueueProducer } from "../infrastructure/queue/queue-producer.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const SIGNING_SECRET = "slack-e2e-signing-secret-20260821";
const BOT_USER_ID = "U_LOBU_BOT";
const ENTERPRISE_ID = "E0ENTERPRISE";
const WORKSPACE_TEAM_ID = "T0WORKSPACE";
const CHANNEL_ID = "C0CHANNEL";
const DM_ID = "D0DIRECT";
const RUNTIME_CONNECTION_ID = "slackinst-grid-message-e2e";

setDefaultTimeout(30_000);

function signedEventRequest(
  payload: Record<string, unknown>,
  retryNum?: number,
): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("https://gateway.example.test/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      ...(retryNum === undefined
        ? {}
        : {
            "x-slack-retry-num": String(retryNum),
            "x-slack-retry-reason": "http_timeout",
          }),
    },
    body,
  });
}

function slackEvent(options: {
  eventId: string;
  channel: string;
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  channelType?: "channel" | "im";
}) {
  return {
    token: "legacy-verification-token",
    type: "event_callback",
    api_app_id: "A_LOBU",
    event_id: options.eventId,
    event_time: Math.floor(Number(options.ts)),
    team_id: WORKSPACE_TEAM_ID,
    enterprise_id: ENTERPRISE_ID,
    is_enterprise_install: true,
    event: {
      type: "message",
      team: WORKSPACE_TEAM_ID,
      team_id: WORKSPACE_TEAM_ID,
      channel: options.channel,
      channel_type: options.channelType ?? "channel",
      ts: options.ts,
      text: options.text,
      ...(options.user ? { user: options.user, username: "burak" } : {}),
      ...(options.botId
        ? { bot_id: options.botId, username: "another-app" }
        : {}),
    },
  };
}

async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe("Slack Enterprise Grid event -> chat Automation -> Slack reply", () => {
  let chat: Chat;
  let state: StateAdapter;
  let queue: RunsQueue;
  let connectionDbId: number;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();

    const organizationId = "org-slack-grid-e2e";
    const agentId = "agent-slack-grid-e2e";
    await seedAgentRow(agentId, { organizationId });
    const sql = getDb();
    const [connectionRow] = await sql<{ id: number }[]>`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, external_tenant_id, config
      ) VALUES (
        ${organizationId}, 'slack', ${RUNTIME_CONNECTION_ID}, 'Grid Slack',
        'active', 'managed', ${ENTERPRISE_ID},
        ${sql.json({
          platform: "slack",
          settings: { allowGroups: true },
          chatMetadata: {
            teamId: ENTERPRISE_ID,
            enterpriseId: ENTERPRISE_ID,
            isEnterpriseInstall: true,
            botUserId: BOT_USER_ID,
          },
        })}
      )
      RETURNING id
    `;
    if (!connectionRow) throw new Error("Slack E2E connection was not seeded");
    connectionDbId = Number(connectionRow.id);

    await createTestAutomationSubscription({
      organizationId,
      agentId,
      connectionId: connectionDbId,
      platform: "slack",
      channelId: CHANNEL_ID,
      teamId: WORKSPACE_TEAM_ID,
    });
    await createTestAutomationSubscription({
      organizationId,
      agentId,
      connectionId: connectionDbId,
      platform: "slack",
      channelId: DM_ID,
      teamId: WORKSPACE_TEAM_ID,
    });

    queue = new RunsQueue();
    await queue.start();
    const producer = new QueueProducer(queue);
    await producer.start();

    state = await createConnectedGatewayStateAdapter();
    const adapter = createSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test-boundary-token",
      botUserId: BOT_USER_ID,
      userName: "lobu",
    });
    // Slack API reads/status writes are the external boundary too. Keep the
    // assembled server path hermetic while still exercising its calls.
    (adapter as any).fetchMessages = mock(async () => ({ messages: [] }));
    (adapter as any).startTyping = mock(async () => undefined);
    chat = new Chat({
      userName: "lobu",
      adapters: { slack: adapter },
      state,
      logger: "silent",
    });

    const connection: PlatformConnection = {
      id: RUNTIME_CONNECTION_ID,
      platform: "slack",
      organizationId,
      config: {
        platform: "slack",
        signingSecret: SIGNING_SECRET,
        botToken: "xoxb-test-boundary-token",
        botUserId: BOT_USER_ID,
      },
      settings: { allowGroups: true },
      metadata: {
        teamId: ENTERPRISE_ID,
        enterpriseId: ENTERPRISE_ID,
        isEnterpriseInstall: true,
        botUserId: BOT_USER_ID,
      },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationState = new ConversationStateStore(state);
    const subscriptions = new AutomationSubscriptionService();
    const manager = {
      has: (connectionId: string) => connectionId === RUNTIME_CONNECTION_ID,
      getInstance: (connectionId: string) =>
        connectionId === RUNTIME_CONNECTION_ID
          ? { connection, conversationState, chat }
          : undefined,
    };
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.test",
      getAutomationSubscriptionService: () => subscriptions,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getProviderCatalogService: () => undefined,
      getQueueProducer: () => producer,
    };
    registerMessageHandlers(
      chat,
      connection,
      services as never,
      manager as never,
    );
  });

  afterEach(async () => {
    await chat?.shutdown();
    await queue?.stop();
  });

  test("workspace-stamped channel and DM events persist, activate once, and reply", async () => {
    const sql = getDb();
    const channelTs = "1787292000.000821";
    const channelPayload = slackEvent({
      eventId: "Ev_GRID_CHANNEL_20260821",
      channel: CHANNEL_ID,
      ts: channelTs,
      text: "LOBU_SLACK_E2E_20260821 integration channel",
      user: "U_BURAK",
    });

    const first = await chat.webhooks.slack(signedEventRequest(channelPayload));
    expect(first.status).toBe(200);

    await waitFor(async () => {
      const rows = await sql`
        SELECT id, action_input
        FROM runs
        WHERE run_type = 'chat_message'
        ORDER BY id
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action_input).toMatchObject({
        agentId: "agent-slack-grid-e2e",
        organizationId: "org-slack-grid-e2e",
        messageText: "LOBU_SLACK_E2E_20260821 integration channel",
        platformMetadata: {
          automationId: expect.any(Number),
          teamId: WORKSPACE_TEAM_ID,
          connectionId: RUNTIME_CONNECTION_ID,
        },
      });
    });
    await waitFor(async () => {
      const rows = await sql`
        SELECT platform_message_id, team_id, text
        FROM channel_messages
        WHERE organization_id = 'org-slack-grid-e2e'
          AND connection_id = ${RUNTIME_CONNECTION_ID}
          AND channel_id = ${CHANNEL_ID}
      `;
      expect(rows).toEqual([
        {
          platform_message_id: channelTs,
          team_id: WORKSPACE_TEAM_ID,
          text: "LOBU_SLACK_E2E_20260821 integration channel",
        },
      ]);
    });

    // Delayed Events and normal Slack retries carry the same event_id. The
    // durable adapter marker and message idempotency must leave one transcript
    // row and one pending agent turn.
    await waitFor(async () => {
      expect(
        await state.get("slack:event-delivered:Ev_GRID_CHANNEL_20260821"),
      ).toBe(true);
    });
    const retry = await chat.webhooks.slack(
      signedEventRequest(channelPayload, 1),
    );
    expect(retry.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterRetry = await sql`
      SELECT id FROM runs WHERE run_type = 'chat_message'
    `;
    expect(afterRetry).toHaveLength(1);
    const transcriptAfterRetry = await sql`
      SELECT id FROM channel_messages
      WHERE organization_id = 'org-slack-grid-e2e'
        AND connection_id = ${RUNTIME_CONNECTION_ID}
        AND channel_id = ${CHANNEL_ID}
    `;
    expect(transcriptAfterRetry).toHaveLength(1);

    // DM ingress remains on the dedicated Chat SDK branch and routes through
    // the same workspace-scoped Automation planner.
    const dmTs = "1787292001.000821";
    const dmResponse = await chat.webhooks.slack(
      signedEventRequest(
        slackEvent({
          eventId: "Ev_GRID_DM_20260821",
          channel: DM_ID,
          channelType: "im",
          ts: dmTs,
          text: "LOBU_SLACK_E2E_20260821 integration dm",
          user: "U_BURAK",
        }),
      ),
    );
    expect(dmResponse.status).toBe(200);
    await waitFor(async () => {
      const rows = await sql`
        SELECT id FROM runs WHERE run_type = 'chat_message' ORDER BY id
      `;
      expect(rows).toHaveLength(2);
    });
    await waitFor(async () => {
      const rows = await sql`
        SELECT platform_message_id, team_id
        FROM channel_messages
        WHERE organization_id = 'org-slack-grid-e2e'
          AND connection_id = ${RUNTIME_CONNECTION_ID}
          AND channel_id = ${DM_ID}
      `;
      expect(rows).toEqual([
        { platform_message_id: dmTs, team_id: WORKSPACE_TEAM_ID },
      ]);
    });

    // The bot's own Slack echo is filtered by Chat SDK before the catch-all;
    // another app's bot message is rejected by the bridge's loop guard.
    for (const ownOrBot of [
      slackEvent({
        eventId: "Ev_GRID_SELF_20260821",
        channel: CHANNEL_ID,
        ts: "1787292002.000821",
        text: "self echo",
        user: BOT_USER_ID,
      }),
      slackEvent({
        eventId: "Ev_GRID_OTHER_BOT_20260821",
        channel: CHANNEL_ID,
        ts: "1787292003.000821",
        text: "another bot",
        botId: "B_OTHER_APP",
      }),
    ]) {
      const response = await chat.webhooks.slack(signedEventRequest(ownOrBot));
      expect(response.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterBots = await sql`
      SELECT id FROM runs WHERE run_type = 'chat_message'
    `;
    expect(afterBots).toHaveLength(2);

    // Feed the authoritative terminal text into the real Slack transport. The
    // only fake is chat.postMessage itself, Slack's external HTTP boundary.
    const [channelRun] = await sql<{ action_input: Record<string, any> }[]>`
      SELECT action_input
      FROM runs
      WHERE run_type = 'chat_message'
      ORDER BY id
      LIMIT 1
    `;
    if (!channelRun) throw new Error("Channel agent turn was not queued");
    expect(channelRun.action_input.channelId).toBe(`slack:${CHANNEL_ID}`);
    const postMessage = mock(async () => ({ ok: true }));
    await getResponseStrategy("slack").handleCompletion({
      ctx: {
        connectionId: RUNTIME_CONNECTION_ID,
        platform: "slack",
        channelId: String(channelRun.action_input.channelId),
        instance: {
          chat: {
            getAdapter: () => ({ client: { chat: { postMessage } } }),
          },
        },
      },
      payload: {
        messageId: String(channelRun.action_input.messageId),
        channelId: String(channelRun.action_input.channelId),
        conversationId: String(channelRun.action_input.conversationId),
        userId: String(channelRun.action_input.userId),
        teamId: WORKSPACE_TEAM_ID,
        platform: "slack",
        timestamp: Date.now(),
        finalText: "ACK_LOBU_SLACK_E2E_20260821 integration channel",
      },
      stream: null,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: CHANNEL_ID,
      thread_ts: channelTs,
      markdown_text: "ACK_LOBU_SLACK_E2E_20260821 integration channel",
    });

    // The connection is enterprise-scoped (`external_tenant_id` = E…), but
    // routing and durable state must retain the real workspace T id. An E id
    // in either place would cross the Grid boundary.
    const teamStamps = await sql<{ team_id: string }[]>`
      SELECT DISTINCT team_id
      FROM channel_messages
      WHERE organization_id = 'org-slack-grid-e2e'
        AND connection_id = ${RUNTIME_CONNECTION_ID}
    `;
    expect(teamStamps).toEqual([{ team_id: WORKSPACE_TEAM_ID }]);
    const runStamps = await sql<{ action_input: Record<string, any> }[]>`
      SELECT action_input FROM runs WHERE run_type = 'chat_message'
    `;
    for (const row of runStamps) {
      expect(row.action_input.platformMetadata.teamId).toBe(WORKSPACE_TEAM_ID);
    }
  });
});
