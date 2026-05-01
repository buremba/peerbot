import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { createSlackRoutes } from "../routes/public/slack.js";
import { ensurePgliteForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

describe("slack routes", () => {
  const originalClientId = process.env.SLACK_CLIENT_ID;
  const originalScopes = process.env.SLACK_OAUTH_SCOPES;

  let completeSlackOAuthInstall: ReturnType<typeof mock>;
  let handleSlackAppWebhook: ReturnType<typeof mock>;
  let router: ReturnType<typeof createSlackRoutes>;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.SLACK_CLIENT_ID = "client-123";
    process.env.SLACK_OAUTH_SCOPES = "chat:write,commands";

    completeSlackOAuthInstall = mock(async () => ({
      teamId: "T123",
      teamName: "Acme",
      connectionId: "conn-1",
    }));
    handleSlackAppWebhook = mock(async (request: Request) => {
      const body = await request.text();
      return new Response(`handled:${body}`);
    });

    router = createSlackRoutes({
      getServices: () => ({
        getPublicGatewayUrl: () => "https://gateway.example.com",
      }),
      completeSlackOAuthInstall,
      handleSlackAppWebhook,
    } as any);
  });

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.SLACK_CLIENT_ID;
    } else {
      process.env.SLACK_CLIENT_ID = originalClientId;
    }

    if (originalScopes === undefined) {
      delete process.env.SLACK_OAUTH_SCOPES;
    } else {
      process.env.SLACK_OAUTH_SCOPES = originalScopes;
    }
  });

  test("GET /slack/install redirects to Slack OAuth and stores state", async () => {
    const response = await router.request("/slack/install");

    expect(response.status).toBe(302);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.pathname).toBe("/oauth/v2/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("client-123");
    expect(redirectUrl.searchParams.get("scope")).toBe("chat:write,commands");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );

    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const sql = getDb();
    const rows = await sql`
      SELECT payload FROM oauth_states
      WHERE id = ${state} AND scope = 'slack:oauth:state' AND expires_at > now()
    `;
    expect(rows.length).toBe(1);
    const payload = (rows[0] as any).payload;
    expect(payload.redirectUri).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );
    expect(typeof payload.createdAt).toBe("number");
  });

  test("GET /slack/oauth_callback rejects invalid state", async () => {
    const response = await router.request(
      "/slack/oauth_callback?code=test-code&state=missing"
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Authentication Failed");
    expect(body).toContain("invalid or has expired");
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
  });

  test("GET /slack/oauth_callback completes install and clears state", async () => {
    const sql = getDb();
    const expiresAt = new Date(Date.now() + 600_000);
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        'test-state',
        'slack:oauth:state',
        ${sql.json({
          createdAt: Date.now(),
          redirectUri: "https://gateway.example.com/slack/oauth_callback",
        })},
        ${expiresAt}
      )
    `;

    const response = await router.request(
      "/slack/oauth_callback?code=test-code&state=test-state"
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Slack installed");
    expect(body).toContain("Workspace connected to Lobu:");
    expect(body).toContain("Connection ID: conn-1");
    expect(completeSlackOAuthInstall).toHaveBeenCalledTimes(1);
    expect(completeSlackOAuthInstall.mock.calls[0]?.[1]).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'test-state'
    `;
    expect(remaining.length).toBe(0);
  });

  test("POST /slack/events forwards requests to the chat manager", async () => {
    const response = await router.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ team_id: "T123", type: "event_callback" }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("handled:");
    expect(handleSlackAppWebhook).toHaveBeenCalledTimes(1);
  });
});
