import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { createSlackRoutes } from "../routes/public/slack.js";
import { ensurePgliteForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

describe("slack routes", () => {
  const originalClientId = process.env.SLACK_CLIENT_ID;
  const originalScopes = process.env.SLACK_OAUTH_SCOPES;

  let completeSlackOAuthInstall: ReturnType<typeof mock>;
  let handleSlackAppWebhook: ReturnType<typeof mock>;
  let router: ReturnType<typeof createSlackRoutes>;
  let app: Hono;
  // Per-test org id injected into the Hono context — mirrors what
  // `lobuApp.use('*', ...)` sets in production (see lobu/gateway.ts). The
  // /slack/install + /slack/oauth_callback handlers require a non-empty
  // value to scope install state to the initiating tenant.
  let sessionOrgId: string | null;

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

    sessionOrgId = "org-default";
    app = new Hono();
    app.use("*", async (c, next) => {
      if (sessionOrgId !== null) c.set("organizationId" as never, sessionOrgId);
      await next();
    });
    app.route("", router);
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
    const response = await app.request("/slack/install");

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
    expect(payload.organizationId).toBe("org-default");
    expect(typeof payload.createdAt).toBe("number");
  });

  test("GET /slack/install rejects when no session org is bound", async () => {
    sessionOrgId = null;
    const response = await app.request("/slack/install");
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).toContain("Sign in to an organization");
  });

  test("GET /slack/oauth_callback rejects invalid state", async () => {
    const response = await app.request(
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
          organizationId: "org-default",
        })},
        ${expiresAt}
      )
    `;

    const response = await app.request(
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

  test("GET /slack/oauth_callback rejects when callback session org differs from install state", async () => {
    const sql = getDb();
    const expiresAt = new Date(Date.now() + 600_000);
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        'cross-org-state',
        'slack:oauth:state',
        ${sql.json({
          createdAt: Date.now(),
          redirectUri: "https://gateway.example.com/slack/oauth_callback",
          organizationId: "org-a",
        })},
        ${expiresAt}
      )
    `;
    // Caller signs in to org-b — must be rejected with 403.
    sessionOrgId = "org-b";
    const response = await app.request(
      "/slack/oauth_callback?code=test-code&state=cross-org-state"
    );
    const body = await response.text();
    expect(response.status).toBe(403);
    expect(body).toContain("different organization");
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
    // State is preserved for the legitimate caller to retry (peek-before-
    // consume). The previous behavior burned the row on every failed
    // org check and forced the user to restart the OAuth flow.
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'cross-org-state'
    `;
    expect(remaining.length).toBe(1);
  });

  test("POST /slack/events forwards requests to the chat manager", async () => {
    const response = await app.request("/slack/events", {
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
