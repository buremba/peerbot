/**
 * Internal Settings Link Routes
 *
 * Worker-facing endpoint for generating settings magic links.
 * Used by the InstallSkill, InstallPackage, and RequestNetworkAccess custom tools.
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ClaimService } from "../../auth/settings/claim-service";
import type {
  PrefillMcpServer,
  PrefillSkill,
} from "../../auth/settings/token-service";
import type { InteractionService } from "../../interactions";
import type { GrantStore } from "../../permissions/grant-store";
import { authenticateWorker } from "./middleware";

const logger = createLogger("internal-settings-link-routes");

function encodePrefillMcpServers(
  prefillMcpServers: PrefillMcpServer[]
): string {
  return Buffer.from(JSON.stringify(prefillMcpServers), "utf-8").toString(
    "base64url"
  );
}

type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      conversationId: string;
      channelId: string;
      teamId?: string;
      agentId?: string;
      connectionId?: string;
      deploymentName: string;
      platform?: string;
    };
  };
};

/**
 * Create internal settings link routes (Hono)
 */
export function createSettingsLinkRoutes(
  interactionService?: InteractionService,
  grantStore?: GrantStore,
  claimService?: ClaimService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Generate a settings magic link for the current user/agent context
   * POST /internal/settings-link
   */
  router.post("/internal/settings-link", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const body = await c.req.json().catch(() => ({}));
      const {
        reason,
        message,
        label,
        providers,
        skills,
        mcpServers,
        nixPackages,
        grants,
      } = body as {
        reason?: string;
        message?: string;
        label?: string;
        providers?: string[];
        skills?: PrefillSkill[];
        mcpServers?: PrefillMcpServer[];
        nixPackages?: string[];
        grants?: string[];
      };

      const agentId = worker.agentId;
      const userId = worker.userId;
      const platform = worker.platform || "unknown";

      if (!agentId) {
        logger.error("Missing agentId in worker token", { worker });
        return c.json({ error: "Missing agentId in worker context" }, 400);
      }

      logger.info("Generating settings link", {
        agentId,
        userId,
        platform,
        reason: reason?.substring(0, 100),
        hasMessage: !!message,
        providersCount: providers?.length || 0,
        skillsCount: skills?.length || 0,
        mcpServersCount: mcpServers?.length || 0,
        nixPackagesCount: nixPackages?.length || 0,
        grantsCount: grants?.length || 0,
      });

      // Domain-only requests can use inline approval buttons
      const isDomainOnly =
        grants &&
        grants.length > 0 &&
        !skills?.length &&
        !mcpServers?.length &&
        !providers?.length &&
        !nixPackages?.length;

      if (isDomainOnly && interactionService && grantStore) {
        logger.info("Using inline grant approval", {
          agentId,
          domains: grants,
        });

        await interactionService.postGrantRequest(
          userId,
          agentId,
          worker.conversationId,
          worker.channelId,
          worker.teamId,
          worker.connectionId,
          grants,
          reason || "Domain access requested"
        );

        return c.json({
          type: "inline_grant",
          message:
            "Approval buttons sent to user in chat. The user will approve or deny the request.",
        });
      }

      // Package-only requests can use inline approval buttons
      const isPackageOnly =
        nixPackages &&
        nixPackages.length > 0 &&
        !skills?.length &&
        !mcpServers?.length &&
        !providers?.length &&
        !grants?.length;

      if (isPackageOnly && interactionService) {
        logger.info("Using inline package approval", {
          agentId,
          packages: nixPackages,
        });

        await interactionService.postPackageRequest(
          userId,
          agentId,
          worker.conversationId,
          worker.channelId,
          worker.teamId,
          nixPackages,
          reason || "Package install requested"
        );

        return c.json({
          type: "inline_package",
          message:
            "Approval buttons sent to user in chat. The user will approve or deny the package install.",
        });
      }

      // Use claim-based URLs (all platforms, including Telegram)
      if (!claimService) {
        return c.json({ error: "Claim service not configured" }, 500);
      }

      const claimCode = await claimService.createClaim(
        platform,
        worker.channelId,
        userId
      );

      const baseUrl = process.env.PUBLIC_GATEWAY_URL || "http://localhost:8080";
      const settingsPath = agentId
        ? `/agent/${encodeURIComponent(agentId)}`
        : "/agent";
      const settingsUrl = new URL(settingsPath, baseUrl);
      settingsUrl.searchParams.set("claim", claimCode);

      // Thread conversation context so the settings page can send
      // post-install notifications back to the originating conversation.
      settingsUrl.searchParams.set("conversationId", worker.conversationId);
      if (worker.connectionId) {
        settingsUrl.searchParams.set("connectionId", worker.connectionId);
      }

      // For webapp-initdata platforms (Telegram), include platform + chat
      // so the settings page renders the WebApp bootstrap instead of OAuth redirect
      if (platform === "telegram") {
        settingsUrl.searchParams.set("platform", platform);
        settingsUrl.searchParams.set("chat", worker.channelId);
      }

      // For simple prefill data, use query params
      if (skills?.length) {
        settingsUrl.searchParams.set(
          "skills",
          skills.map((s) => s.repo).join(",")
        );
      }
      if (providers?.length) {
        settingsUrl.searchParams.set("providers", providers.join(","));
      }
      if (mcpServers?.length) {
        settingsUrl.searchParams.set(
          "mcps",
          encodePrefillMcpServers(mcpServers)
        );
      }
      if (message) {
        settingsUrl.searchParams.set("message", message);
      }
      if (nixPackages?.length) {
        settingsUrl.searchParams.set("nix", nixPackages.join(","));
      }
      if (grants?.length) {
        settingsUrl.searchParams.set("grants", grants.join(","));
      }

      const url = settingsUrl.toString();

      if (interactionService) {
        const buttonLabel =
          label ||
          (mcpServers?.length
            ? `Install ${mcpServers[0]?.name || "MCP Server"}`
            : skills?.length
              ? "Install Skill"
              : "Open Settings");

        await interactionService.postLinkButton(
          userId,
          worker.conversationId,
          worker.channelId,
          worker.teamId,
          worker.connectionId,
          platform,
          url,
          buttonLabel,
          skills?.length || mcpServers?.length ? "install" : "settings"
        );

        return c.json({
          type: "settings_link",
          message: "Settings link sent as a button to the user.",
        });
      }

      return c.json({
        url,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
    } catch (error) {
      logger.error("Failed to generate settings link", { error });
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to generate settings link",
        },
        500
      );
    }
  });

  logger.debug("Internal settings link routes registered");

  return router;
}
