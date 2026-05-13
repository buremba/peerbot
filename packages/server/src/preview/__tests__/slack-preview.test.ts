import { CommandRegistry } from "@lobu/core";
import type { Context } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cleanupTestDatabase } from "../../__tests__/setup/test-db.js";
import {
  createTestAgent,
  createTestOrganization,
} from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { registerBuiltInCommands } from "../../gateway/commands/built-in-commands.js";
import type { Env } from "../../index";
import {
  bindChatToPreviewAgent,
  canonicalSlackChannelId,
  consumePreviewClaim,
  createPreviewClaim,
  listPreviewAgents,
  previewAgentMenu,
  slackSurfaceType,
} from "../slack";

const AGENT_ID = "demo-agent";
const OTHER_AGENT_ID = "other-agent";
const TEAM_ID = "T_DEVELOPER";

let ORG_ID = "";
const USER_ID = "user-slack-preview";

// The `link` command computes platform/surface/canonical-channel from the
// command context before calling `consumePreviewClaim`; mirror that here so the
// direct-call tests exercise the same shape a real Slack `/lobu link` produces.
function consumeSlack(args: { code: string; teamId: string; channelId: string }) {
  return consumePreviewClaim({
    code: args.code,
    platform: "slack",
    teamId: args.teamId,
    channelId: canonicalSlackChannelId(args.channelId),
    surfaceType: slackSurfaceType(args.channelId),
  });
}

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
  surfaces: string[] = ["dm", "channel"],
  platform = "slack"
): Promise<string> {
  const res = await createPreviewClaim(
    orgUserContext({ agent_id: agentId, platform, surfaces })
  );
  if (!isFakeResponse(res)) throw new Error("not a json response");
  expect(res.status).toBe(200);
  return res.body.code as string;
}

describe("Slack Preview claims + channel bindings", () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: "Slack Preview Org",
      slug: "slack-preview-org",
    });
    ORG_ID = org.id;
    await createTestAgent({ organizationId: ORG_ID, agentId: AGENT_ID, name: "Demo" });
    await createTestAgent({
      organizationId: ORG_ID,
      agentId: OTHER_AGENT_ID,
      name: "Other",
    });
  });

  beforeEach(async () => {
    const sql = getDb();
    await sql`DELETE FROM agent_channel_bindings`;
    await sql`DELETE FROM oauth_states WHERE scope = 'slack-preview-claim'`;
  });

  test("claim mints a /lobu link code in oauth_states under the dedicated scope", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "slack", surfaces: ["dm", "channel"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    expect(code).toMatch(/^demo-agent-[A-Z0-9]{6}$/);
    expect(res.body.provider).toBe("lobu-public-slack");
    expect(res.body.command).toBe(`/lobu link ${code}`);
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
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: "nope", platform: "slack" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(404);
  });

  test("claim with an unsupported platform → 400", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "discord" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(400);
  });

  test("a telegram claim mints a /link code and is consumable without a teamId", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "telegram", surfaces: ["dm"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    expect(res.body.provider).toBe("lobu-public-telegram");
    expect(res.body.command).toBe(`/link ${code}`);

    const bound = await consumePreviewClaim({
      code,
      platform: "telegram",
      channelId: "12345",
      surfaceType: "dm",
    });
    expect(bound).toMatchObject({ status: "bound", agentId: AGENT_ID });

    const sql = getDb();
    const rows = await sql`
      SELECT channel_id, team_id FROM agent_channel_bindings WHERE platform = 'telegram'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: "12345", team_id: null });
  });

  test("consume binds the Slack channel to the agent and is one-time-use", async () => {
    const code = await createClaim(AGENT_ID);
    const bound = await consumeSlack({
      code,
      teamId: TEAM_ID,
      channelId: "D123",
    });
    expect(bound).toEqual({
      status: "bound",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });

    // Stored under the canonical `slack:<id>` key the message-handler bridge
    // looks up via getBinding — the bare slash-command channel id is prefixed.
    const sql = getDb();
    const rows = await sql`
      SELECT agent_id, platform, channel_id, team_id
      FROM agent_channel_bindings WHERE platform = 'slack'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: AGENT_ID,
      platform: "slack",
      channel_id: "slack:D123",
      team_id: TEAM_ID,
    });

    // Claim consumed; replay fails.
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "D123" })
    ).toEqual({ status: "not_found" });
  });

  test("re-linking a channel rebinds it to the new agent (last link wins)", async () => {
    await consumeSlack({
      code: await createClaim(AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    const rebound = await consumeSlack({
      code: await createClaim(OTHER_AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    expect(rebound).toMatchObject({ status: "bound", agentId: OTHER_AGENT_ID });

    const sql = getDb();
    const rows = await sql`
      SELECT agent_id FROM agent_channel_bindings
      WHERE platform = 'slack' AND channel_id = 'slack:Csame' AND team_id = ${TEAM_ID}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_id: string }).agent_id).toBe(OTHER_AGENT_ID);
  });

  test("expired or unknown code → not_found, nothing bound", async () => {
    expect(
      await consumeSlack({
        code: "demo-agent-NOPE00",
        teamId: TEAM_ID,
        channelId: "D1",
      })
    ).toEqual({ status: "not_found" });

    const code = await createClaim(AGENT_ID);
    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE scope = 'slack-preview-claim'`;
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "D1" })
    ).toEqual({ status: "not_found" });
    const bindings =
      await sql`SELECT 1 FROM agent_channel_bindings WHERE platform = 'slack'`;
    expect(bindings).toHaveLength(0);
  });

  test("using a dm-only code in a channel → surface_not_allowed", async () => {
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "C9" })
    ).toEqual({ status: "surface_not_allowed", surfaceType: "channel" });
  });

  test("an already-`slack:`-prefixed DM channelId counts as a dm and is stored as-is", async () => {
    // Callers that already pass the canonical thread id (`slack:D…`) shouldn't
    // get it double-prefixed.
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlack({
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

  test("the /lobu link chat command redeems a code end to end", async () => {
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
      isGroup: false,
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
      WHERE platform = 'slack' AND channel_id = 'slack:D777' AND team_id = ${TEAM_ID}
    `;
    expect((rows[0] as { agent_id: string }).agent_id).toBe(AGENT_ID);

    // A bad code via the command surfaces the friendly error, no throw.
    const replies2: string[] = [];
    await registry.tryHandle("link", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      isGroup: false,
      platform: "slack",
      args: "demo-agent-BADBAD",
      reply: async (text: string) => {
        replies2.push(text);
      },
    });
    expect(replies2.join("\n")).toMatch(/invalid or expired/i);
  });
});

describe("Public preview — /lobu try a demo agent", () => {
  const PREVIEW_CONN = "conn-preview";
  const CONCIERGE = "preview-concierge";
  const DEMO_A = "food-ordering";
  const DEMO_B = "lunch-bot";
  let PREVIEW_ORG = "";
  let OTHER_ORG = "";

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: "Public Preview Org",
      slug: "public-preview-org",
    });
    PREVIEW_ORG = org.id;
    const other = await createTestOrganization({
      name: "Some Other Org",
      slug: "some-other-org",
    });
    OTHER_ORG = other.id;
    await createTestAgent({ organizationId: PREVIEW_ORG, agentId: CONCIERGE, name: "Concierge" });
    await createTestAgent({
      organizationId: PREVIEW_ORG,
      agentId: DEMO_A,
      name: "Food Ordering",
      description: "Orders lunch from Deliveroo",
    });
    await createTestAgent({ organizationId: PREVIEW_ORG, agentId: DEMO_B, name: "Lunch Bot" });
    await createTestAgent({ organizationId: OTHER_ORG, agentId: "private-agent", name: "Private" });

    const sql = getDb();
    await sql`
      INSERT INTO agent_connections (id, agent_id, platform, config, settings, metadata, status, created_at, updated_at)
      VALUES (${PREVIEW_CONN}, ${CONCIERGE}, 'slack', ${sql.json({ platform: "slack" })},
              ${sql.json({ previewMode: true })}, ${sql.json({})}, 'active', now(), now())
    `;
  });

  beforeEach(async () => {
    await getDb()`DELETE FROM agent_channel_bindings`;
  });

  test("listPreviewAgents returns the org's agents, excluding the connection's owning agent", async () => {
    const agents = await listPreviewAgents(PREVIEW_CONN);
    expect(agents.map((a) => a.agentId).sort()).toEqual([DEMO_A, DEMO_B]);
    expect(agents.find((a) => a.agentId === DEMO_A)?.description).toBe(
      "Orders lunch from Deliveroo"
    );
  });

  test("listPreviewAgents returns [] for an unknown connection", async () => {
    expect(await listPreviewAgents("conn-does-not-exist")).toEqual([]);
  });

  test("bindChatToPreviewAgent binds a DM to a demo agent in the connection's org", async () => {
    const res = await bindChatToPreviewAgent({
      connectionId: PREVIEW_CONN,
      agentId: DEMO_A,
      platform: "slack",
      teamId: TEAM_ID,
      channelId: canonicalSlackChannelId("D100"),
    });
    expect(res).toEqual({ status: "bound", agentId: DEMO_A });

    const rows = await getDb()`
      SELECT agent_id, channel_id, team_id FROM agent_channel_bindings WHERE platform = 'slack'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: DEMO_A, channel_id: "slack:D100", team_id: TEAM_ID });
  });

  test("re-binding switches the chat to the new demo agent (last wins)", async () => {
    await bindChatToPreviewAgent({
      connectionId: PREVIEW_CONN, agentId: DEMO_A, platform: "slack",
      teamId: TEAM_ID, channelId: canonicalSlackChannelId("Dswap"),
    });
    const res = await bindChatToPreviewAgent({
      connectionId: PREVIEW_CONN, agentId: DEMO_B, platform: "slack",
      teamId: TEAM_ID, channelId: canonicalSlackChannelId("Dswap"),
    });
    expect(res).toMatchObject({ status: "bound", agentId: DEMO_B });
    const rows = await getDb()`
      SELECT agent_id FROM agent_channel_bindings WHERE channel_id = 'slack:Dswap' AND team_id = ${TEAM_ID}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_id: string }).agent_id).toBe(DEMO_B);
  });

  test("won't bind an agent that isn't in the connection's org", async () => {
    expect(
      await bindChatToPreviewAgent({
        connectionId: PREVIEW_CONN, agentId: "private-agent", platform: "slack",
        teamId: TEAM_ID, channelId: canonicalSlackChannelId("D200"),
      })
    ).toEqual({ status: "not_available" });
    expect(
      await bindChatToPreviewAgent({
        connectionId: PREVIEW_CONN, agentId: "no-such-agent", platform: "slack",
        teamId: TEAM_ID, channelId: canonicalSlackChannelId("D200"),
      })
    ).toEqual({ status: "not_available" });
    expect(await getDb()`SELECT 1 FROM agent_channel_bindings`).toHaveLength(0);
  });

  test("reports no_connection for an unknown connection id", async () => {
    expect(
      await bindChatToPreviewAgent({
        connectionId: "conn-nope", agentId: DEMO_A, platform: "slack",
        teamId: TEAM_ID, channelId: canonicalSlackChannelId("D300"),
      })
    ).toEqual({ status: "no_connection" });
  });

  test("the /lobu try chat command binds end to end", async () => {
    const registry = new CommandRegistry();
    registerBuiltInCommands(registry, { agentSettingsStore: {} as never });

    const replies: string[] = [];
    const handled = await registry.tryHandle("try", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      isGroup: false,
      platform: "slack",
      connectionId: PREVIEW_CONN,
      args: DEMO_A,
      reply: async (text: string) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies.join("\n")).toContain(`\`${DEMO_A}\``);
    const rows = await getDb()`
      SELECT agent_id FROM agent_channel_bindings WHERE channel_id = 'slack:D777' AND team_id = ${TEAM_ID}
    `;
    expect((rows[0] as { agent_id: string }).agent_id).toBe(DEMO_A);

    // No arg → menu listing the demo agents, no throw.
    const menuReplies: string[] = [];
    await registry.tryHandle("try", {
      userId: "U1", channelId: "D777", teamId: TEAM_ID, isGroup: false,
      platform: "slack", connectionId: PREVIEW_CONN, args: "",
      reply: async (text: string) => { menuReplies.push(text); },
    });
    expect(menuReplies.join("\n")).toContain(`/lobu try ${DEMO_A}`);

    // Unknown agent → friendly "no demo agent" + the menu.
    const badReplies: string[] = [];
    await registry.tryHandle("try", {
      userId: "U1", channelId: "D777", teamId: TEAM_ID, isGroup: false,
      platform: "slack", connectionId: PREVIEW_CONN, args: "nope",
      reply: async (text: string) => { badReplies.push(text); },
    });
    expect(badReplies.join("\n")).toMatch(/no demo agent `nope`/i);
  });

  test("previewAgentMenu lists agents (or says none)", () => {
    expect(previewAgentMenu("slack", [])).toMatch(/no demo agents/i);
    const menu = previewAgentMenu("slack", [
      { agentId: DEMO_A, name: "Food Ordering", description: "Orders lunch" },
    ]);
    expect(menu).toContain(`/lobu try ${DEMO_A}`);
    expect(menu).toContain("Orders lunch");
    expect(previewAgentMenu("telegram", [
      { agentId: DEMO_A, name: "Food Ordering", description: null },
    ])).toContain(`/try ${DEMO_A}`);
  });
});
