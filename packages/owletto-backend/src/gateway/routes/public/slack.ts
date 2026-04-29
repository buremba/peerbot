import { readFile } from "node:fs/promises";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { createSlackInstallStateStore } from "../../auth/oauth/state-store.js";
import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../../auth/oauth-templates.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import { resolvePublicUrl } from "../../utils/public-url.js";

const logger = createLogger("slack-routes");

const DEFAULT_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
];
type SlackManifest = {
  oauth_config?: {
    scopes?: {
      bot?: string[];
    };
  };
};

function splitScopes(scopes: string): string[] {
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function loadSlackBotScopes(): Promise<string[]> {
  const envScopes =
    process.env.SLACK_OAUTH_SCOPES || process.env.SLACK_BOT_SCOPES;
  if (envScopes) {
    return splitScopes(envScopes);
  }

  const manifestPath =
    process.env.SLACK_MANIFEST_PATH ||
    "config/slack-app-manifest.self-install.json";

  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as SlackManifest;
    const scopes = manifest.oauth_config?.scopes?.bot;
    if (Array.isArray(scopes) && scopes.length > 0) {
      return scopes;
    }
  } catch (error) {
    logger.warn(
      { manifestPath, error: String(error) },
      "Failed to load Slack scopes from manifest, using defaults"
    );
  }

  return DEFAULT_SLACK_BOT_SCOPES;
}

export function createSlackRoutes(manager: ChatInstanceManager): Hono {
  const router = new Hono();

  router.get("/slack/install", async (c) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      return c.html(
        renderOAuthErrorPage(
          "slack_not_configured",
          "Slack OAuth is not configured on this gateway. Set SLACK_CLIENT_ID and try again."
        ),
        503
      );
    }

    const stateStore = createSlackInstallStateStore();
    const redirectUri = resolvePublicUrl("/slack/oauth_callback", {
      configuredUrl: manager.getServices().getPublicGatewayUrl?.(),
      requestUrl: c.req.url,
    });
    const scopes = await loadSlackBotScopes();
    const state = await stateStore.create({ redirectUri });

    const oauthUrl = new URL("https://slack.com/oauth/v2/authorize");
    oauthUrl.searchParams.set("client_id", clientId);
    oauthUrl.searchParams.set("scope", scopes.join(","));
    oauthUrl.searchParams.set("redirect_uri", redirectUri);
    oauthUrl.searchParams.set("state", state);

    return c.redirect(oauthUrl.toString(), 302);
  });

  router.get("/slack/oauth_callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) {
      return c.html(
        renderOAuthErrorPage(
          "invalid_request",
          "The Slack OAuth callback is missing the required state or code parameter."
        ),
        400
      );
    }

    const stateStore = createSlackInstallStateStore();
    const oauthState = await stateStore.consume(state);

    if (!oauthState) {
      return c.html(
        renderOAuthErrorPage(
          "invalid_state",
          "This Slack install link is invalid or has expired."
        ),
        400
      );
    }

    try {
      const result = await manager.completeSlackOAuthInstall(
        c.req.raw,
        oauthState.redirectUri
      );
      return c.html(
        renderOAuthSuccessPage(result.teamName || result.teamId, undefined, {
          title: "Slack installed",
          description: "Workspace connected to Lobu:",
          details: `Connection ID: ${result.connectionId}`,
        })
      );
    } catch (error) {
      logger.error({ error: String(error) }, "Slack OAuth callback failed");
      return c.html(
        renderOAuthErrorPage(
          "slack_install_failed",
          error instanceof Error
            ? error.message
            : "Slack OAuth callback failed."
        ),
        500
      );
    }
  });

  router.post("/slack/events", async (c) => {
    // Reject webhooks whose timestamp is outside Slack's 5-minute window.
    // The Chat SDK adapter does its own signature check, but enforcing the
    // freshness window at the edge defends against replay of an intercepted
    // (still-signed) payload regardless of what the adapter does.
    const tsHeader = c.req.header("x-slack-request-timestamp");
    if (tsHeader) {
      const ts = Number(tsHeader);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 60 * 5) {
        logger.warn(
          { tsHeader, nowSec },
          "Rejecting Slack webhook: timestamp outside 5-minute window"
        );
        return c.text("stale request", 400);
      }
    }

    try {
      return await manager.handleSlackAppWebhook(c.req.raw);
    } catch (error) {
      logger.error({ error: String(error) }, "Slack event handling failed");
      return c.text("Slack webhook processing failed", 500);
    }
  });

  return router;
}
