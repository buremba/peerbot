/**
 * Channel Binding Routes - Manage channel-to-agent bindings
 *
 * Routes (under /api/v1/agents/{agentId}/channels):
 * - GET / - List all bindings for an agent
 * - POST / - Create a new binding
 * - DELETE /{platform}/{channelId} - Delete a binding
 */

import { createLogger } from "@lobu/core";
import { type Context, Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChannelBindingService } from "../../channels/binding-service.js";
import {
  createSlackWebApi,
  type SlackWebApi,
} from "../../connections/slack-web.js";
import { getDb } from "../../../db/client.js";
import { canonicalSlackChannelId } from "../../../preview/slack.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
import type { SecretStore } from "../../secrets/index.js";
import { resolveSecretValue } from "../../secrets/index.js";
import { listCatalogConnectorDefinitions } from "../../../utils/connector-catalog.js";
import {
  createOwnershipResolver,
  createTokenVerifier,
} from "../shared/agent-ownership.js";
import { errorResponse } from "../shared/helpers.js";
import { verifySettingsSession } from "./settings-auth.js";

const logger = createLogger("channel-binding-routes");

interface ChannelBindingRoutesConfig {
  channelBindingService: ChannelBindingService;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: AgentMetadataStore;
  /**
   * Generic app-installation store. When present the router exposes
   * `/installations` (list the agent org's connected apps) and the chat-bind
   * actions that consume them. Optional so a runtime without installations
   * configured simply omits the surface.
   */
  appInstallationStore?: AppInstallationStore;
  /** Resolves an install's bot-token `secret://` ref to call provider APIs. */
  secretStore?: SecretStore;
  /** Slack Web API client (injectable for tests). Defaults to a real one. */
  slackWeb?: SlackWebApi;
}

/** A connected app as the web UI consumes it (provider-generic). */
interface InstallationDto {
  /** Stable external id (e.g. Slack's `slackinst-…`); the action handle. */
  externalId: string;
  provider: string;
  /** Provider tenant id (Slack team_id, GitHub installation_id, …). */
  tenantId: string;
  /** Human label for the tenant (workspace/account name), when known. */
  tenantName: string | null;
  status: string;
  /** `chat` | `data` | null — drives which action the UI offers. */
  deliveryKind: string | null;
  connectorName: string;
  faviconDomain: string | null;
}

/**
 * Resolve the Slack user id to DM for the caller. A Slack chat settings session
 * already IS that user (its `userId` is the Slack user id); a web/OAuth session
 * is matched to its linked "Sign in with Slack" account (`account.accountId` =
 * the Slack OIDC subject). Null when neither resolves — the caller has no Slack
 * identity to open a DM with.
 */
async function resolveCallerSlackUserId(
  payload: SettingsTokenPayload
): Promise<string | null> {
  if (payload.platform === "slack" && payload.userId) {
    return payload.userId;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT "accountId" FROM account
    WHERE "providerId" = 'slack' AND "userId" = ${payload.userId}
    LIMIT 1
  `) as Array<{ accountId: string }>;
  return rows[0]?.accountId ?? null;
}

/**
 * Create channel binding routes
 * These are mounted under /api/v1/agents/{agentId}/channels
 */
export function createChannelBindingRoutes(
  config: ChannelBindingRoutesConfig
): Hono {
  const router = new Hono();

  const verifyToken = createTokenVerifier(config);
  const resolveOwnership = createOwnershipResolver(config);
  const slackWeb = config.slackWeb ?? createSlackWebApi();

  // Authorize the caller for `agentId` AND resolve the agent's org in one step.
  // Unlike `authorize` (which only proves ownership), the install routes query
  // org-scoped resources, so they need the org id from the authoritative
  // `agent_users` mapping — not the request's ambient org context.
  const authorizeWithOrg = async (
    c: Context
  ): Promise<
    | { agentId: string; payload: SettingsTokenPayload; organizationId: string }
    | Response
  > => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      return errorResponse(c, "Missing agentId", 400);
    }
    const session = await verifySettingsSession(c);
    const result = await resolveOwnership(session, agentId);
    if (!result.authorized || !session) {
      return errorResponse(c, "Unauthorized", 401);
    }
    // Prefer the org the ownership check pinned from `agent_users` (the caller
    // demonstrably owns the agent there). When that's absent — an admin session,
    // which is authorized but carries no session-bound org — fall back to the
    // agent's OWN org from its metadata. That's tenant-safe here: installations
    // are scoped to the agent's org, not the caller's ambient context.
    let organizationId = result.organizationId;
    if (!organizationId && config.agentMetadataStore) {
      const metadata = await config.agentMetadataStore.getMetadata(agentId);
      organizationId = metadata?.organizationId ?? undefined;
    }
    if (!organizationId) {
      return errorResponse(c, "Organization could not be resolved", 409);
    }
    return { agentId, payload: session, organizationId };
  };

  const verifyAuth = async (
    c: Context,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    return verifyToken(await verifySettingsSession(c), agentId);
  };

  // Resolve the `agentId` path param and authorize the caller in one step.
  // Returns the verified token payload, or an early-return Response (400 when
  // the param is missing, 401 when the session is not authorized for it).
  const authorize = async (
    c: Context
  ): Promise<{ agentId: string; payload: SettingsTokenPayload } | Response> => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      return errorResponse(c, "Missing agentId", 400);
    }
    const payload = await verifyAuth(c, agentId);
    if (!payload) {
      return errorResponse(c, "Unauthorized", 401);
    }
    return { agentId, payload };
  };

  // GET /api/v1/agents/{agentId}/channels - List all bindings for an agent
  router.get("/", async (c) => {
    const auth = await authorize(c);
    if (auth instanceof Response) return auth;
    const { agentId } = auth;

    try {
      const bindings = await config.channelBindingService.listBindings(agentId);

      return c.json({
        agentId,
        bindings: bindings.map((b) => ({
          platform: b.platform,
          channelId: b.channelId,
          teamId: b.teamId,
          createdAt: b.createdAt,
        })),
      });
    } catch (error) {
      logger.error("Failed to list bindings", { error, agentId });
      return errorResponse(c, "Failed to list bindings", 500);
    }
  });

  // POST /api/v1/agents/{agentId}/channels - Create a new binding
  router.post("/", async (c) => {
    const auth = await authorize(c);
    if (auth instanceof Response) return auth;
    const { agentId, payload: authPayload } = auth;

    try {
      const body = await c.req.json<{
        platform: string;
        channelId: string;
        teamId?: string;
      }>();

      // Validate required fields
      if (!body.platform || !body.channelId) {
        return errorResponse(
          c,
          "Missing required fields: platform, channelId",
          400
        );
      }

      // Validate platform format (alphanumeric, lowercase)
      if (!/^[a-z][a-z0-9_-]*$/.test(body.platform)) {
        return errorResponse(
          c,
          "Invalid platform format. Must be lowercase alphanumeric.",
          400
        );
      }

      // Validate channelId format
      if (typeof body.channelId !== "string" || !body.channelId.trim()) {
        return errorResponse(c, "Invalid channelId", 400);
      }

      // Validate optional teamId
      if (
        body.teamId &&
        (typeof body.teamId !== "string" || !body.teamId.trim())
      ) {
        return errorResponse(c, "Invalid teamId", 400);
      }

      await config.channelBindingService.createBinding(
        agentId,
        body.platform,
        body.channelId.trim(),
        body.teamId?.trim(),
        { configuredBy: authPayload.userId }
      );

      logger.info(
        `Created binding: ${body.platform}/${body.channelId} -> ${agentId}`
      );

      return c.json({
        success: true,
        agentId,
        platform: body.platform,
        channelId: body.channelId,
        teamId: body.teamId,
      });
    } catch (error) {
      logger.error("Failed to create binding", { error, agentId });
      return errorResponse(c, "Failed to create binding", 400);
    }
  });

  // DELETE /api/v1/agents/{agentId}/channels/{platform}/{channelId} - Delete a binding
  router.delete("/:platform/:channelId", async (c) => {
    const platform = c.req.param("platform");
    const channelId = c.req.param("channelId");
    const teamId = c.req.query("teamId"); // Optional query param for multi-tenant platforms

    // Authorize on the agentId before validating the route-specific params so
    // the 401 takes precedence over a 400, matching the prior behavior.
    const agentId = c.req.param("agentId");
    if (!agentId || !platform || !channelId) {
      return errorResponse(c, "Missing required parameters", 400);
    }

    if (!(await verifyAuth(c, agentId))) {
      return errorResponse(c, "Unauthorized", 401);
    }

    // Validate platform format
    if (!/^[a-z][a-z0-9_-]*$/.test(platform)) {
      return errorResponse(c, "Invalid platform format", 400);
    }

    try {
      const deleted = await config.channelBindingService.deleteBinding(
        agentId,
        platform,
        channelId,
        teamId || undefined
      );

      if (!deleted) {
        return errorResponse(c, "Binding not found", 404);
      }

      logger.info(`Deleted binding: ${platform}/${channelId} -> ${agentId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete binding", { error, agentId });
      return errorResponse(c, "Failed to delete binding", 500);
    }
  });

  // GET /api/v1/agents/{agentId}/channels/installations?provider=slack
  // List the agent org's connected apps (provider-generic). The UI uses this to
  // show "your workspace X is connected" instead of always nagging "Add to App".
  router.get("/installations", async (c) => {
    const auth = await authorizeWithOrg(c);
    if (auth instanceof Response) return auth;
    const { organizationId } = auth;

    if (!config.appInstallationStore) {
      return c.json({ installations: [] satisfies InstallationDto[] });
    }

    try {
      const providerFilter = c.req.query("provider");
      const rows = providerFilter
        ? await config.appInstallationStore.listByProviderAndOrg(
            providerFilter,
            organizationId
          )
        : await config.appInstallationStore.listByOrg(organizationId);

      // Join connector metadata (display name, deliveryKind, favicon) so the UI
      // can render + decide the action without hardcoding provider knowledge.
      const defs = await listCatalogConnectorDefinitions();
      const byKey = new Map(defs.map((d) => [d.key, d]));

      const installations: InstallationDto[] = rows.map((r) => {
        const def = byKey.get(r.provider);
        const webhook = (def?.webhook ?? null) as {
          deliveryKind?: string;
        } | null;
        const externalId =
          typeof r.metadata.external_id === "string" && r.metadata.external_id
            ? r.metadata.external_id
            : String(r.id);
        return {
          externalId,
          provider: r.provider,
          tenantId: r.externalTenantId,
          tenantName:
            (r.metadata.team_name as string | undefined) ??
            (r.metadata.account_login as string | undefined) ??
            null,
          status: r.status,
          deliveryKind: webhook?.deliveryKind ?? null,
          connectorName: def?.name ?? r.provider,
          faviconDomain: def?.favicon_domain ?? null,
        };
      });

      return c.json({ installations });
    } catch (error) {
      logger.error("Failed to list installations", { error });
      return errorResponse(c, "Failed to list installations", 500);
    }
  });

  // POST /api/v1/agents/{agentId}/channels/installations/{externalId}/connect-dm
  // Auto-bind the caller's Slack DM (with the installed workspace's bot) to this
  // agent — the web-first onboarding "one click connects my DM" action. Resolves
  // the bot token from the install, opens the DM with the caller's Slack user id,
  // creates the binding, and posts a best-effort welcome.
  router.post("/installations/:externalId/connect-dm", async (c) => {
    const auth = await authorizeWithOrg(c);
    if (auth instanceof Response) return auth;
    const { agentId, payload, organizationId } = auth;

    const externalId = c.req.param("externalId");
    if (!externalId) {
      return errorResponse(c, "Missing externalId", 400);
    }
    if (!config.appInstallationStore || !config.secretStore) {
      return errorResponse(c, "Installations not available", 503);
    }

    try {
      // Resolve the install and confirm it belongs to the caller's org — never
      // bind across tenants off a guessed external id. Require an ACTIVE install:
      // `resolveByExternalId` falls back to the most-recent row when no active one
      // exists, so a revoked/suspended workspace must not yield a bot token or a
      // binding (the token may be dead and the workspace was intentionally turned
      // off). Treat non-active as not-found.
      const install = await config.appInstallationStore.resolveByExternalId(
        "slack",
        externalId
      );
      if (
        !install ||
        install.provider !== "slack" ||
        install.organizationId !== organizationId ||
        install.status !== "active"
      ) {
        return errorResponse(c, "Installation not found", 404);
      }

      // Bot token lives in the secret store, scoped to the install's org.
      const tokenRef = (
        install.metadata.config as { botToken?: string } | undefined
      )?.botToken;
      const botToken = await orgContext.run({ organizationId }, () =>
        resolveSecretValue(config.secretStore!, tokenRef)
      );
      if (!botToken) {
        return errorResponse(c, "Workspace bot token unavailable", 409);
      }

      const slackUserId = await resolveCallerSlackUserId(payload);
      if (!slackUserId) {
        return errorResponse(
          c,
          "No linked Slack identity for your account. Sign in with Slack first.",
          409
        );
      }

      let dmChannelId: string;
      try {
        dmChannelId = await slackWeb.openDm(botToken, slackUserId);
      } catch (error) {
        logger.error("Failed to open Slack DM", {
          error: String(error),
          externalId,
        });
        return errorResponse(c, "Could not open a Slack DM with you", 502);
      }

      // Store the binding under the canonical `slack:<id>` channel key. Inbound
      // Slack messages reach the dispatcher with `thread.channelId` already in
      // canonical form, so a raw `D…` key here would never match and the DM
      // would silently fail to route. (`dmChannelId` stays raw for the Slack
      // Web API calls below, which expect the unprefixed id.)
      await config.channelBindingService.createBinding(
        agentId,
        "slack",
        canonicalSlackChannelId(dmChannelId),
        install.externalTenantId,
        { configuredBy: payload.userId, organizationId }
      );

      // Best-effort inline welcome — the binding is the contract, not this DM.
      void slackWeb
        .postMessage(
          botToken,
          dmChannelId,
          "✅ Connected. I'm now wired to this DM — ask me anything to get started."
        )
        .catch(() => {});

      logger.info(
        `Connected Slack DM ${dmChannelId} (team ${install.externalTenantId}) -> ${agentId}`
      );

      return c.json({
        success: true,
        platform: "slack",
        channelId: dmChannelId,
        teamId: install.externalTenantId,
      });
    } catch (error) {
      logger.error("Failed to connect Slack DM", { error, agentId });
      return errorResponse(c, "Failed to connect Slack DM", 500);
    }
  });

  return router;
}
