import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../../gateway/__tests__/helpers/db-setup";
import { runtimeConnectionIdToSlug } from "../../../lobu/stores/connections-projection";
import { registerScheduledJobsTicker } from "../../../scheduled/scheduled-jobs-service";
import type { ToolContext } from "../../registry";
import { manageSchedules } from "../manage_schedules";

const ORG = "org-scheduled-delivery";
const AGENT = "agent-scheduled-delivery";
const USER = "user-scheduled-delivery";

function ctx(sourceContext?: ToolContext["sourceContext"]): ToolContext {
  return {
    organizationId: ORG,
    userId: USER,
    memberRole: "admin",
    agentId: AGENT,
    sourceContext: sourceContext ?? null,
    isAuthenticated: true,
    clientId: "lobu-worker",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    tokenType: "pat",
    scopedToOrg: true,
    allowCrossOrg: false,
  };
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

describe("manage_schedules wake_agent chat delivery", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT, { organizationId: ORG, ownerUserId: USER });
  }, 60_000);

  test("ignores and strips caller-supplied delivery payload", async () => {
    await seedChatConnection({ id: "conn-real" });

    const result = await manageSchedules(
      {
        action: "create",
        description: "forged delivery is ignored",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          type: "wake_agent",
          agent_id: AGENT,
          prompt: "wake up",
          delivery: {
            platform: "slack",
            connectionId: "conn-real",
            channelId: "C-real",
            conversationId: "slack:C-real:123",
          },
        } as any,
      },
      {} as any,
			ctx(),
    );

    expect(result.error).toBeUndefined();
		const rows =
			await getDb()`SELECT action_args, delivery_context FROM scheduled_jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_args.delivery).toBeUndefined();
    expect(rows[0].delivery_context).toBeNull();
  });

  test("persists a per-schedule model override into action_args on create", async () => {
    const result = await manageSchedules(
      {
        action: "create",
        description: "with model override",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          type: "wake_agent",
          agent_id: AGENT,
          prompt: "wake up",
          model: "openai/gpt-4o",
        },
      },
      {} as any,
      ctx(),
    );

    expect(result.error).toBeUndefined();
    const id = (result as { schedule?: { id: string } }).schedule?.id;
    expect(id).toBeTruthy();
    const rows =
      await getDb()`SELECT action_args FROM scheduled_jobs WHERE id = ${id}`;
    expect(rows[0].action_args.model).toBe("openai/gpt-4o");

    // Update with an empty model clears the override; a real model replaces it.
    await manageSchedules(
      { action: "update", id: id as string, model: "anthropic/claude-sonnet-4-6" },
      {} as any,
      ctx(),
    );
    const afterSet =
      await getDb()`SELECT action_args FROM scheduled_jobs WHERE id = ${id}`;
    expect(afterSet[0].action_args.model).toBe("anthropic/claude-sonnet-4-6");

    await manageSchedules(
      { action: "update", id: id as string, model: "" },
      {} as any,
      ctx(),
    );
    const afterClear =
      await getDb()`SELECT action_args FROM scheduled_jobs WHERE id = ${id}`;
    expect(afterClear[0].action_args.model).toBeUndefined();
  });

  test("stores trusted delivery context from the worker source context", async () => {
    await seedChatConnection({ id: "conn-real" });

    const result = await manageSchedules(
      {
        action: "create",
        description: "trusted delivery",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          type: "wake_agent",
          agent_id: AGENT,
          prompt: "wake up",
        },
      },
      {} as any,
      ctx({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
			}),
    );

    expect(result.error).toBeUndefined();
    const rows = await getDb()`SELECT delivery_context FROM scheduled_jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_context).toEqual({
      platform: "slack",
      connectionId: "conn-real",
      channelId: "C-real",
      conversationId: "slack:C-real:123",
      teamId: "T-real",
      userId: USER,
    });
  });

  test("scheduled-jobs ticker injects delivery_context into the wake task payload", async () => {
    await seedChatConnection({ id: "conn-real" });

    const result = await manageSchedules(
      {
        action: "create",
        description: "due trusted delivery",
        run_at: new Date(Date.now() - 60_000).toISOString(),
        payload: { type: "wake_agent", agent_id: AGENT, prompt: "wake up" },
      },
      {} as any,
      ctx({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
			}),
    );
    expect(result.error).toBeUndefined();

    const spawned: Array<{ name: string; payload: any; opts: any }> = [];
		const handlers = new Map<
			string,
			(ctx: { payload: unknown; taskRunId: number }) => Promise<void>
		>();
    registerScheduledJobsTicker({
      register: (name: string, handler: any) => handlers.set(name, handler),
      spawn: async (name: string, payload: any, opts: any) => {
        spawned.push({ name, payload, opts });
        return "spawned-job";
      },
    } as any);

    await handlers.get("scheduled-jobs-tick")!({ payload: {}, taskRunId: 1 });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].name).toBe("wake_agent");
    expect(spawned[0].payload.__delivery_context).toEqual({
      platform: "slack",
      connectionId: "conn-real",
      channelId: "C-real",
      conversationId: "slack:C-real:123",
      teamId: "T-real",
      userId: USER,
    });
  });

  test("requires agentless managed connections to have a matching channel binding", async () => {
    await seedChatConnection({
      id: "slackinst-real",
      agentId: null,
      externalTenantId: "T-real",
    });

    const missingBinding = await manageSchedules(
      {
        action: "create",
        description: "missing binding",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        payload: { type: "wake_agent", agent_id: AGENT, prompt: "wake up" },
      },
      {} as any,
      ctx({
        platform: "slack",
        connectionId: "slackinst-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
			}),
    );
    expect(missingBinding.error).toMatch(/channel is not bound/);

    await getDb()`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id)
      SELECT ${ORG}, ${AGENT}, 'slack', 'C-real', 'T-real', id
      FROM connections
      WHERE organization_id = ${ORG} AND slug = ${runtimeConnectionIdToSlug("slackinst-real")}
    `;

    const withBinding = await manageSchedules(
      {
        action: "create",
        description: "with binding",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        payload: { type: "wake_agent", agent_id: AGENT, prompt: "wake up" },
      },
      {} as any,
      ctx({
        platform: "slack",
        connectionId: "slackinst-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
			}),
    );
    expect(withBinding.error).toBeUndefined();
		const rows =
			await getDb()`SELECT delivery_context FROM scheduled_jobs ORDER BY created_at DESC LIMIT 1`;
    expect(rows[0].delivery_context.connectionId).toBe("slackinst-real");
  });

  test("update rejects an empty cron but still clears the cadence on null", async () => {
    const created = await manageSchedules(
      {
        action: "create",
        description: "recurring digest",
        run_at: new Date(Date.now() + 60_000).toISOString(),
        cron: "0 9 * * 1-5",
        payload: { type: "wake_agent", agent_id: AGENT, prompt: "digest" },
      } as any,
      {} as any,
			ctx(),
    );
    const id = (created as { schedule?: { id: string } }).schedule?.id;
    expect(id).toBeTruthy();

    // "" is not a valid cron — it must be rejected, not persisted.
    const empty = await manageSchedules(
      { action: "update", id, cron: "" } as any,
      {} as any,
			ctx(),
    );
    expect(empty.error).toMatch(/cron/i);

    // null clears the cadence (recurring → one-shot).
    const cleared = await manageSchedules(
      { action: "update", id, cron: null } as any,
      {} as any,
			ctx(),
    );
    expect(cleared.error).toBeUndefined();
		const rows =
			await getDb()`SELECT cron FROM scheduled_jobs WHERE id = ${id}`;
    expect(rows[0].cron).toBeNull();
  });
});
