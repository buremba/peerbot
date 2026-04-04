/**
 * OAuth Utility Routes
 *
 * OAuth code exchange and redirect handling.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ProviderOAuthStateStore } from "../../auth/oauth/state-store";
import { verifySettingsSessionOrToken } from "./settings-auth";

const TAG = "Auth";
const SuccessResponse = z.object({ success: z.boolean() });
const ErrorResponse = z.object({ error: z.string() });

export interface ProviderCredentialStore {
  hasCredentials(agentId: string): Promise<boolean>;
  deleteCredentials(agentId: string): Promise<void>;
  setCredentials(agentId: string, credentials: unknown): Promise<void>;
}

export interface ProviderOAuthClient {
  generateCodeVerifier(): string;
  buildAuthUrl(state: string, codeVerifier: string): string;
  exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    state?: string
  ): Promise<unknown>;
}

const codeExchangeRoute = createRoute({
  method: "post",
  path: "/{provider}/code",
  tags: [TAG],
  summary: "Exchange OAuth code for token",
  request: {
    query: z.object({ token: z.string().optional() }),
    params: z.object({ provider: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ code: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Exchanged",
      content: { "application/json": { schema: SuccessResponse } },
    },
    400: {
      description: "Invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export interface OAuthRoutesConfig {
  providerStores?: Record<string, ProviderCredentialStore>;
  oauthClients?: Record<string, ProviderOAuthClient>;
  oauthStateStore?: ProviderOAuthStateStore;
}

export function createOAuthRoutes(config: OAuthRoutesConfig): OpenAPIHono {
  const app = new OpenAPIHono();

  // --- Provider login redirect (excluded from docs) ---
  app.get("/:provider/login", async (c) => {
    const session = verifySettingsSessionOrToken(c);
    const agentId = session?.agentId || c.req.query("agentId");

    if (!agentId) return c.json({ error: "Missing agentId" }, 400);

    if (!session) {
      // No session — redirect through settings OAuth to establish one, then return here
      const returnUrl = `${c.req.path}?agentId=${encodeURIComponent(agentId)}`;
      return c.redirect(
        `/connect/oauth/login?returnUrl=${encodeURIComponent(returnUrl)}`
      );
    }

    const oauthClient = config.oauthClients?.[c.req.param("provider")];
    if (!oauthClient) return c.json({ error: "Unknown provider" }, 404);
    if (!config.oauthStateStore)
      return c.json({ error: "Not configured" }, 500);

    const codeVerifier = oauthClient.generateCodeVerifier();
    const state = await config.oauthStateStore.create({
      userId: session.userId,
      agentId,
      codeVerifier,
      context: { platform: session.platform, channelId: agentId },
    });

    return c.redirect(oauthClient.buildAuthUrl(state, codeVerifier));
  });

  // --- Provider code exchange ---
  app.openapi(codeExchangeRoute, async (c): Promise<any> => {
    const session = verifySettingsSessionOrToken(c);
    const agentId = session?.agentId;
    if (!session || !agentId) return c.json({ error: "Unauthorized" }, 401);

    const { provider } = c.req.valid("param");
    const oauthClient = config.oauthClients?.[provider];
    const credentialStore = config.providerStores?.[provider];
    if (!oauthClient || !credentialStore)
      return c.json({ error: "Unknown provider" }, 404);
    if (!config.oauthStateStore)
      return c.json({ error: "Not configured" }, 500);

    const { code: input } = c.req.valid("json");
    const parts = input.split("#");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return c.json({ error: "Invalid format" }, 400);
    }

    const authCode = parts[0].trim();
    const state = parts[1].trim();
    const stateData = await config.oauthStateStore.consume(state);
    if (!stateData) return c.json({ error: "Invalid state" }, 400);

    try {
      const credentials = await oauthClient.exchangeCodeForToken(
        authCode,
        stateData.codeVerifier,
        "https://console.anthropic.com/oauth/code/callback",
        state
      );
      await credentialStore.setCredentials(agentId, credentials);
      return c.json({ success: true });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Exchange failed" },
        400
      );
    }
  });

  return app;
}
