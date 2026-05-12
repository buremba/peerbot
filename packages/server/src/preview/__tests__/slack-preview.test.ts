import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Context } from "hono";
import { CommandRegistry } from "@lobu/core";
import { registerBuiltInCommands } from "../../gateway/commands/built-in-commands.js";
import { getDb } from "../../db/client.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import type { Env } from "../../index";
import { consumeSlackPreviewClaim, createSlackPreviewClaim } from "../slack";

const ORG_ID = "org-slack-preview";
const USER_ID = "user-slack-preview";
const AGENT_ID = "demo-agent";
const OTHER_AGENT_ID = "other-agent";
const TEAM_ID = "T_DEVELOPER";

interface FakeResponse {
  status: number;
  body: Record<string, unknown>;
}

function isFakeResponse(value: unknown): value is FakeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

function orgUserContext(jsonBody: unknown): Context<{ Bindings: Env }> {
  return {
    var: { organizationId: ORG_ID, session: { userId: USER_ID } },
    req: { json: async () => jsonBody, header: () => undefined },
    json: (body: Record<string, unknown>, status = 200): FakeResponse => ({
      status,
      body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function createClaim(
  agentId: string,
  surfaces: string[] = ["dm", "channel"]
): Promise<string> {
  const res = await createSlackPreviewClaim(
    orgUserContext({ agent_id: agentId, surfaces })
  );
  if (!isFakeResponse(res)) throw new Error("not a json response");
  expect(res.status).toBe(200);
  return res.body.code as string;
}

async function seedOrgAndAgents(): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, 'Slack Preview Org', 'slack-preview-org')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT_ID}, ${ORG_ID}, 'Demo'), (${OTHER_AGENT_ID}, ${ORG_ID}, 'Other')
    ON CONFLICT (id) DO NOTHING
  `;
}

describe("Slack Preview claims + channel bindings (Postgres-backed)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrgAndAgents();
  });

  test("claim mints a /link code in oauth_states under the dedicated scope", async () => {
    const res = await createSlackPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, surfaces: ["dm", "channel"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    expect(code).toMatch(/^demo-agent-[A-Z0-9]{6}$/);
    expect(res.body.command).toBe(`/link ${code}`);
    expect(res.body.allowed_surfaces).toEqual(["dm", "channel"]);

    const sql = getDb();
    const rows =
      await sql`SELECT payload FROM oauth_states WHERE scope = 'slack-preview-claim'`;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { payload: { agentId: string } }).payload.agentId).toBe(
      AGENT_ID
    );
  });

  test("claim for an agent outside the caller's org → 404", async () => {
    const res = await createSlackPreviewClaim(
      orgUserContext({ agent_id: "nope" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(404);
  });

  test("consume binds the Slack channel to the agent and is one-time-use", async () => {
    const code = await createClaim(AGENT_ID);
    const bound = await consumeSlackPreviewClaim({
      code,
      teamId: TEAM_ID,
      channelId: "D123",
    });
    expect(bound).toEqual({
      status: "bound",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });

    // Resolvable by the same (platform, channel_id, team_id) lookup
    // message-handler-bridge uses for every inbound Slack message.
    const sql = getDb();
    const rows = await sql`
      SELECT agent_id, platform, channel_id, team_id
      FROM agent_channel_bindings WHERE platform = 'slack'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: AGENT_ID,
      platform: "slack",
      channel_id: "D123",
      team_id: TEAM_ID,
    });

    // Claim consumed; replay fails.
    expect(await consumeSlackPreviewClaim({ code, teamId: TEAM_ID, channelId: "D123" }))
      .toEqual({ status: "not_found" });
  });

  test("re-linking a channel rebinds it to the new agent (last link wins)", async () => {
    await consumeSlackPreviewClaim({
      code: await createClaim(AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    const rebound = await consumeSlackPreviewClaim({
      code: await createClaim(OTHER_AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    expect(rebound).toMatchObject({ status: "bound", agentId: OTHER_AGENT_ID });

    const sql = getDb();
    const rows = await sql`
      SELECT agent_id FROM agent_channel_bindings
      WHERE platform = 'slack' AND channel_id = 'Csame' AND team_id = ${TEAM_ID}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_id: string }).agent_id).toBe(OTHER_AGENT_ID);
  });

  test("expired or unknown code → not_found, nothing bound", async () => {
    expect(
      await consumeSlackPreviewClaim({
        code: "demo-agent-NOPE00",
        teamId: TEAM_ID,
        channelId: "D1",
      })
    ).toEqual({ status: "not_found" });

    const code = await createClaim(AGENT_ID);
    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE scope = 'slack-preview-claim'`;
    expect(
      await consumeSlackPreviewClaim({ code, teamId: TEAM_ID, channelId: "D1" })
    ).toEqual({ status: "not_found" });
    const bindings = await sql`SELECT 1 FROM agent_channel_bindings WHERE platform = 'slack'`;
    expect(bindings).toHaveLength(0);
  });

  test("using a dm-only code in a channel → surface_not_allowed", async () => {
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlackPreviewClaim({ code, teamId: TEAM_ID, channelId: "C9" })
    ).toEqual({ status: "surface_not_allowed", surfaceType: "channel" });
  });

  test("a transport-prefixed DM channelId still counts as a dm and binds verbatim", async () => {
    // The Slack bridge sometimes passes the Chat SDK thread id (`slack:D…`).
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlackPreviewClaim({
        code,
        teamId: TEAM_ID,
        channelId: "slack:D999",
      })
    ).toMatchObject({ status: "bound", agentId: AGENT_ID });
    const sql = getDb();
    const rows = await sql`
      SELECT channel_id FROM agent_channel_bindings
      WHERE platform = 'slack' AND team_id = ${TEAM_ID}
    `;
    expect((rows[0] as { channel_id: string }).channel_id).toBe("slack:D999");
  });

  test("the /link chat command redeems a code end to end", async () => {
    const code = await createClaim(AGENT_ID);
    const registry = new CommandRegistry();
    // registerBuiltInCommands wires `status` against an agent settings store we
    // don't need here; only `link` is exercised.
    registerBuiltInCommands(registry, {
      agentSettingsStore: {} as never,
    });

    const replies: string[] = [];
    const handled = await registry.tryHandle("link", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      platform: "slack",
      args: code,
      reply: async (text: string) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies.join("\n")).toContain(`agent \`${AGENT_ID}\``);

    const sql = getDb();
    const rows = await sql`
      SELECT agent_id FROM agent_channel_bindings
      WHERE platform = 'slack' AND channel_id = 'D777' AND team_id = ${TEAM_ID}
    `;
    expect((rows[0] as { agent_id: string }).agent_id).toBe(AGENT_ID);

    // A bad code via the command surfaces the friendly error, no throw.
    const replies2: string[] = [];
    await registry.tryHandle("link", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      platform: "slack",
      args: "demo-agent-BADBAD",
      reply: async (text: string) => {
        replies2.push(text);
      },
    });
    expect(replies2.join("\n")).toMatch(/invalid or expired/i);
  });
});
