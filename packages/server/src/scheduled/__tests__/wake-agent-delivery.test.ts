import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import { getDb } from "../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup";
import type { CoreServices } from "../../gateway/services/core-services";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection";
import { runWakeAgentTask, type WakeAgentTaskPayload } from "../jobs";

const ORG = "org-wake-delivery";
const AGENT = "agent-wake-delivery";
const USER = "user-wake-delivery";

/**
 * Drive the real `wake_agent` handler against the live test DB. The queue
 * producer is captured; the session manager throws on any access so a fall
 * through to the api-platform path (createThreadForAgent / enqueueAgentMessage)
 * is observable as a rejection rather than silently running the legacy path.
 */
function fakeCoreServices(enqueued: MessagePayload[]): CoreServices {
  const sessionManager = new Proxy(
    {},
    {
      get() {
        throw new Error("API_PATH_REACHED");
      },
    }
  );
  return {
    getQueueProducer: () => ({
      enqueueMessage: async (payload: MessagePayload) => {
        enqueued.push(payload);
        return "queued";
      },
    }),
    getSessionManager: () => sessionManager,
  } as unknown as CoreServices;
}

async function seedChatConnection(params: {
  id: string;
  platform?: string;
  agentId?: string | null;
  status?: string;
  externalTenantId?: string | null;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, external_tenant_id, agent_id,
      display_name, status, config, credential_mode, slug, visibility
    ) VALUES (
      ${ORG}, ${params.platform ?? "slack"}, ${params.externalTenantId ?? null},
      ${params.agentId === undefined ? AGENT : params.agentId}, 'Test chat', ${params.status ?? "active"},
      ${sql.json({})}, 'byo', ${runtimeConnectionIdToSlug(params.id)}, 'org'
    )
  `;
}

function payload(
  deliveryContext: unknown,
  overrides?: Partial<WakeAgentTaskPayload>
): WakeAgentTaskPayload {
  return {
    __organization_id: ORG,
    __created_by_user: USER,
    __scheduled_job_id: "job-1",
    __delivery_context: deliveryContext,
    agent_id: AGENT,
    prompt: "wake up",
    ...overrides,
  };
}

describe("runWakeAgentTask chat delivery dispatch", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT, { organizationId: ORG, ownerUserId: USER });
  }, 60_000);

  test("posts back to the channel when delivery context is authorized", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: null,
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    const msg = enqueued[0];
    expect(msg.platform).toBe("slack");
    expect(msg.channelId).toBe("C-real");
    expect(msg.conversationId).toBe("slack:C-real:123");
    expect(msg.messageText).toBe("wake up");
    // teamId omitted (not stamped with the platform name) when delivery has none.
    expect(msg.teamId).toBeUndefined();
    expect(msg.platformMetadata.connectionId).toBe("conn-real");
    expect(msg.platformMetadata.teamId).toBeUndefined();
    expect(msg.platformMetadata.source).toBe("scheduled-job");
  });

  test("injects the per-schedule model override into agentOptions", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload(
        {
          platform: "slack",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "slack:C-real:123",
          teamId: null,
          userId: USER,
        },
        { model: "openai/gpt-5" }
      )
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agentOptions).toEqual({ model: "openai/gpt-5" });
  });

  test("leaves agentOptions empty when no per-schedule model is set", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: null,
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agentOptions).toEqual({});
  });

  test("forwards a real teamId through to the message payload", async () => {
    await seedChatConnection({ id: "conn-real", externalTenantId: "T-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].teamId).toBe("T-real");
    expect(enqueued[0].platformMetadata.teamId).toBe("T-real");
  });

  test("falls through to the api path when the connection is no longer active", async () => {
    await seedChatConnection({ id: "conn-real", status: "paused" });
    const enqueued: MessagePayload[] = [];

    // Unauthorized delivery skips the channel dispatch and runs the api path,
    // which touches the (throwing) session manager — proving no message was
    // posted to the channel.
    await expect(
      runWakeAgentTask(
        fakeCoreServices(enqueued),
        payload({
          platform: "slack",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "slack:C-real:123",
          teamId: null,
          userId: USER,
        })
      )
    ).rejects.toThrow("API_PATH_REACHED");
    expect(enqueued).toHaveLength(0);
  });

  test("falls through to the api path for a non-deliverable platform", async () => {
    await seedChatConnection({ id: "conn-real", platform: "discord" });
    const enqueued: MessagePayload[] = [];

    await expect(
      runWakeAgentTask(
        fakeCoreServices(enqueued),
        payload({
          platform: "discord",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "discord:C-real:123",
          teamId: null,
          userId: USER,
        })
      )
    ).rejects.toThrow("API_PATH_REACHED");
    expect(enqueued).toHaveLength(0);
  });
});
