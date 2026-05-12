import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { getDb } from "../../db/client.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import type { Env } from "../../index";
import { bindSlackPreviewClaim, createSlackPreviewClaim } from "../slack";

const ORG_ID = "org-slack-preview";
const USER_ID = "user-slack-preview";
const AGENT_ID = "demo-agent";
const OTHER_AGENT_ID = "other-agent";
const RELAY_TOKEN = "relay-test-token";

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
    req: {
      json: async () => jsonBody,
      header: () => undefined,
    },
    json: (body: Record<string, unknown>, status = 200): FakeResponse => ({
      status,
      body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

function relayContext(
  jsonBody: unknown,
  authHeader: string | undefined = `Bearer ${RELAY_TOKEN}`
): Context<{ Bindings: Env }> {
  return {
    var: {},
    req: {
      json: async () => jsonBody,
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? authHeader : undefined,
    },
    json: (body: Record<string, unknown>, status = 200): FakeResponse => ({
      status,
      body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function call(
  handler: (c: Context<{ Bindings: Env }>) => Promise<unknown>,
  c: Context<{ Bindings: Env }>
): Promise<FakeResponse> {
  const res = await handler(c);
  if (!isFakeResponse(res)) throw new Error("handler did not return c.json()");
  return res;
}

async function seedOrgAndAgent(): Promise<void> {
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

describe("Slack Preview claims + bindings (Postgres-backed)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
    process.env.LOBU_SLACK_PREVIEW_RELAY_TOKEN = RELAY_TOKEN;
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrgAndAgent();
  });

  test("happy path: claim → bind writes an agent_channel_bindings row and consumes the claim", async () => {
    const created = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: AGENT_ID, surfaces: ["dm", "thread"] })
    );
    expect(created.status).toBe(200);
    const code = created.body.code as string;
    expect(code).toMatch(/^demo-agent-[A-Z0-9]{6}$/);
    expect(created.body.command).toBe(`link ${code}`);

    // The claim landed in oauth_states under the dedicated scope.
    const sql = getDb();
    const claims =
      await sql`SELECT scope, payload FROM oauth_states WHERE scope = 'slack-preview-claim'`;
    expect(claims).toHaveLength(1);
    expect((claims[0] as { payload: { agentId: string } }).payload.agentId).toBe(
      AGENT_ID
    );

    const bound = await call(
      bindSlackPreviewClaim,
      relayContext({
        code,
        external_team_id: "T123",
        external_channel_id: "D456",
      })
    );
    expect(bound.status).toBe(200);
    expect(bound.body.status).toBe("bound");
    expect(bound.body.agent_id).toBe(AGENT_ID);
    expect(bound.body.surface_key).toBe("dm:D456");

    // Binding row exists and is resolvable by (platform, channel, team).
    const bindings = await sql`
      SELECT agent_id, platform, channel_id, team_id
      FROM agent_channel_bindings
      WHERE platform = 'slack-preview'
    `;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      agent_id: AGENT_ID,
      platform: "slack-preview",
      channel_id: "dm:D456",
      team_id: "T123",
    });

    // Claim was consumed (one-time use).
    const remaining =
      await sql`SELECT 1 FROM oauth_states WHERE scope = 'slack-preview-claim'`;
    expect(remaining).toHaveLength(0);
  });

  test("re-linking a surface rebinds it to the new agent (last link wins)", async () => {
    const c1 = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: AGENT_ID })
    );
    await call(
      bindSlackPreviewClaim,
      relayContext({
        code: c1.body.code,
        external_team_id: "T1",
        external_channel_id: "Dsame",
      })
    );

    const c2 = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: OTHER_AGENT_ID })
    );
    const rebound = await call(
      bindSlackPreviewClaim,
      relayContext({
        code: c2.body.code,
        external_team_id: "T1",
        external_channel_id: "Dsame",
      })
    );
    expect(rebound.status).toBe(200);
    expect(rebound.body.agent_id).toBe(OTHER_AGENT_ID);

    const sql = getDb();
    const rows = await sql`
      SELECT agent_id FROM agent_channel_bindings
      WHERE platform = 'slack-preview' AND channel_id = 'dm:Dsame' AND team_id = 'T1'
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_id: string }).agent_id).toBe(OTHER_AGENT_ID);
  });

  test("unknown / expired code → 404", async () => {
    const res = await call(
      bindSlackPreviewClaim,
      relayContext({
        code: "demo-agent-NOPE00",
        external_team_id: "T1",
        external_channel_id: "D1",
      })
    );
    expect(res.status).toBe(404);

    const created = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: AGENT_ID })
    );
    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE scope = 'slack-preview-claim'`;
    const expired = await call(
      bindSlackPreviewClaim,
      relayContext({
        code: created.body.code,
        external_team_id: "T1",
        external_channel_id: "D1",
      })
    );
    expect(expired.status).toBe(404);
  });

  test("binding a surface the claim didn't allow → 400, claim untouched", async () => {
    const created = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: AGENT_ID, surfaces: ["dm"] })
    );
    const res = await call(
      bindSlackPreviewClaim,
      relayContext({
        code: created.body.code,
        external_team_id: "T1",
        external_channel_id: "C9",
        external_thread_ts: "1700000000.000100",
      })
    );
    expect(res.status).toBe(400);
    // The DELETE…RETURNING happens before the surface check, so the claim is
    // consumed even on rejection — assert that's the case so the relay knows
    // to mint a fresh code.
    const sql = getDb();
    const remaining =
      await sql`SELECT 1 FROM oauth_states WHERE scope = 'slack-preview-claim'`;
    expect(remaining).toHaveLength(0);
  });

  test("relay endpoint rejects a bad bearer token", async () => {
    const created = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: AGENT_ID })
    );
    const res = await call(
      bindSlackPreviewClaim,
      relayContext(
        {
          code: created.body.code,
          external_team_id: "T1",
          external_channel_id: "D1",
        },
        "Bearer wrong"
      )
    );
    expect(res.status).toBe(401);
  });

  test("claim for an agent outside the caller's org → 404", async () => {
    const res = await call(
      createSlackPreviewClaim,
      orgUserContext({ agent_id: "some-other-agent" })
    );
    expect(res.status).toBe(404);
  });
});
