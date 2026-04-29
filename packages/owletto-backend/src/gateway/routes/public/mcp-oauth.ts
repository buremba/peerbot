/**
 * Public callback endpoint for MCP OAuth 2.1 authorization-code flows.
 *
 * After the user approves the app in the authorization server's UI, the
 * provider redirects here with `?code=…&state=…`. We validate & consume the
 * state (GETDEL, so replay fails), exchange the code for tokens using the
 * stored PKCE verifier, and render a simple "you can close this tab" page.
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { completeAuthCodeFlow } from "../../auth/mcp/oauth-flow.js";
import { postOAuthCompletionPrompt } from "../../auth/mcp/resume-after-oauth.js";
import { escapeHtml } from "../../auth/oauth-templates.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { CoreServices } from "../../platform.js";
import type { WritableSecretStore } from "../../secrets/index.js";

const logger = createLogger("mcp-oauth-callback");

interface McpOAuthRoutesConfig {
  secretStore: WritableSecretStore;
  /** Absolute URL mounted on the gateway — used as redirect_uri verbatim. */
  publicGatewayUrl: string;
  /**
   * Optional — when provided, on a successful callback we enqueue a synthetic
   * "you connected X" follow-up so the agent proactively retries the original
   * request instead of making the user type again.
   */
  coreServices?: CoreServices;
  chatInstanceManager?: ChatInstanceManager;
}

function renderResultPage(opts: {
  success: boolean;
  title: string;
  body: string;
}): string {
  const color = opts.success ? "#16a34a" : "#dc2626";
  const safeTitle = escapeHtml(opts.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
    .card { max-width: 440px; padding: 32px; background: white;
            border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            text-align: center; }
    h1 { color: ${color}; margin: 0 0 12px; font-size: 20px; }
    p  { color: #475569; margin: 4px 0; line-height: 1.5; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    ${opts.body}
  </div>
</body>
</html>`;
}

export function createMcpOAuthRoutes(config: McpOAuthRoutesConfig): Hono {
  const {
    secretStore,
    publicGatewayUrl,
    coreServices,
    chatInstanceManager,
  } = config;
  const router = new Hono();

  const redirectUri = `${publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;

  router.get("/mcp/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    if (error) {
      logger.warn("OAuth provider returned error to callback", {
        error,
        errorDescription,
      });
      const safeError = escapeHtml(error);
      const safeErrorDescription = errorDescription
        ? escapeHtml(errorDescription)
        : "Please try again from the chat.";
      return c.html(
        renderResultPage({
          success: false,
          title: "Authorization failed",
          body: `<p>The provider returned <span class="mono">${safeError}</span>.</p>
                 <p>${safeErrorDescription}</p>`,
        }),
        400
      );
    }

    if (!code || !state) {
      return c.html(
        renderResultPage({
          success: false,
          title: "Missing code or state",
          body: `<p>This callback URL was opened without a valid authorization response.</p>`,
        }),
        400
      );
    }

    try {
      const result = await completeAuthCodeFlow({
        secretStore,
        state,
        code,
        redirectUri,
      });

      logger.info("Stored MCP OAuth credential via callback", {
        mcpId: result.mcpId,
        agentId: result.agentId,
        scopeKey: result.scopeKey,
        platform: result.platform,
      });

      // Proactively resume the agent in the original thread so the user
      // doesn't have to retype. Best-effort — if the injection fails (no
      // coreServices, missing provider, queue unavailable), the credential
      // is still stored and the user can send a follow-up message manually.
      if (coreServices) {
        try {
          await postOAuthCompletionPrompt({
            coreServices,
            chatInstanceManager,
            agentId: result.agentId,
            platform: result.platform,
            userId: result.userId,
            channelId: result.channelId,
            conversationId: result.conversationId,
            teamId: result.teamId,
            connectionId: result.connectionId,
            mcpId: result.mcpId,
            scope: result.scope,
          });
        } catch (err) {
          logger.warn("Failed to enqueue OAuth resume prompt", {
            mcpId: result.mcpId,
            agentId: result.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const safeMcpId = escapeHtml(result.mcpId);
      const scopeLabel = result.scopeKey.startsWith("channel-")
        ? "channel"
        : "user";
      return c.html(
        renderResultPage({
          success: true,
          title: `Connected ${result.mcpId}`,
          body: `<p>You can close this tab and return to the chat.</p>
                 <p>Signed in as <span class="mono">${safeMcpId}</span> for this ${scopeLabel}.</p>`,
        })
      );
    } catch (err) {
      logger.error("Failed to complete MCP OAuth flow", {
        error: err instanceof Error ? err.message : String(err),
      });
      const safeMessage = escapeHtml(
        err instanceof Error ? err.message : "Unknown error"
      );
      return c.html(
        renderResultPage({
          success: false,
          title: "Authorization failed",
          body: `<p>${safeMessage}</p>
                 <p>Please try again from the chat.</p>`,
        }),
        500
      );
    }
  });

  logger.debug("MCP OAuth callback route registered at /mcp/oauth/callback");
  return router;
}
