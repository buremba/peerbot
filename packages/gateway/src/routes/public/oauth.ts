/**
 * OAuth Utility Routes
 *
 * OAuth code exchange and redirect handling.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ClaudeOAuthStateStore } from "../../auth/oauth/state-store";
import type { AgentSettingsStore } from "../../auth/settings";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import { verifySettingsSession } from "./settings-auth";

const TAG = "OAuth";
const ErrorResponse = z.object({ error: z.string() });
const SuccessResponse = z.object({ success: z.boolean() });

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
  path: "/providers/{provider}/code",
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

const providerLogoutRoute = createRoute({
  method: "post",
  path: "/providers/{provider}/logout",
  tags: [TAG],
  summary: "Disconnect OAuth provider",
  request: {
    query: z.object({ token: z.string().optional() }),
    params: z.object({ provider: z.string() }),
  },
  responses: {
    200: {
      description: "Disconnected",
      content: { "application/json": { schema: SuccessResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export interface OAuthRoutesConfig {
  providerStores?: Record<string, ProviderCredentialStore>;
  oauthClients?: Record<string, ProviderOAuthClient>;
  oauthStateStore?: ClaudeOAuthStateStore;
  agentSettingsStore: AgentSettingsStore;
}

export function createOAuthRoutes(config: OAuthRoutesConfig): OpenAPIHono {
  const app = new OpenAPIHono();

  const verifyToken = (
    payload: SettingsTokenPayload | null
  ): (SettingsTokenPayload & { agentId: string }) | null => {
    if (!payload || !payload.agentId) return null;
    return payload as typeof payload & { agentId: string };
  };

  // --- Provider login redirect (excluded from docs) ---
  app.get("/providers/:provider/login", async (c) => {
    const payload = verifyToken(verifySettingsSession(c));
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const provider = c.req.param("provider");
    const oauthClient = config.oauthClients?.[provider];
    if (!oauthClient) return c.json({ error: "Unknown provider" }, 404);
    if (!config.oauthStateStore)
      return c.json({ error: "Not configured" }, 500);

    const codeVerifier = oauthClient.generateCodeVerifier();
    const state = await config.oauthStateStore.create({
      userId: payload.userId,
      agentId: payload.agentId,
      codeVerifier,
      context: { platform: payload.platform, channelId: payload.agentId },
    });

    return c.redirect(oauthClient.buildAuthUrl(state, codeVerifier));
  });

  // --- Provider code exchange ---
  app.openapi(codeExchangeRoute, async (c): Promise<any> => {
    const payload = verifyToken(verifySettingsSession(c));
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

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
      await credentialStore.setCredentials(payload.agentId, credentials);
      return c.json({ success: true });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Exchange failed" },
        400
      );
    }
  });

  // --- Provider logout ---
  app.openapi(providerLogoutRoute, async (c): Promise<any> => {
    const payload = verifyToken(verifySettingsSession(c));
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const { provider } = c.req.valid("param");
    const store = config.providerStores?.[provider];
    if (!store) return c.json({ error: "Unknown provider" }, 404);

    await store.deleteCredentials(payload.agentId);
    return c.json({ success: true });
  });

  return app;
}
