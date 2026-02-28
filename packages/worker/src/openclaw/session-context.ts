import {
  buildMcpToolInstructions,
  createLogger,
  type McpToolDef,
} from "@lobu/core";
import { ensureBaseUrl } from "../core/url-utils";

const logger = createLogger("openclaw-session-context");

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
  authenticated: boolean;
  configured: boolean;
}

export interface ProviderConfig {
  credentialEnvVarName?: string;
  defaultProvider?: string;
  defaultModel?: string;
  cliBackends?: Array<{
    providerId: string;
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    modelArg?: string;
    sessionArg?: string;
  }>;
  providerBaseUrlMappings?: Record<string, string>;
}

interface SessionContextResponse {
  agentInstructions: string;
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
  mcpTools?: Record<string, McpToolDef[]>;
  providerConfig?: ProviderConfig;
}

// Module-level cache for session context
let cachedResult: {
  gatewayInstructions: string;
  providerConfig: ProviderConfig;
} | null = null;

/**
 * Invalidate the session context cache.
 * Called by the SSE client when a config_changed event is received.
 */
export function invalidateSessionContextCache(): void {
  cachedResult = null;
  logger.info("Session context cache invalidated");
}

function buildMcpInstructions(mcpStatus: McpStatus[]): string {
  if (!mcpStatus || mcpStatus.length === 0) {
    return "";
  }

  const unavailableMcps = mcpStatus.filter(
    (mcp) =>
      (mcp.requiresAuth && !mcp.authenticated) ||
      (mcp.requiresInput && !mcp.configured)
  );

  if (unavailableMcps.length === 0) {
    return "";
  }

  const lines: string[] = ["## MCP Tools Requiring Setup"];

  for (const mcp of unavailableMcps) {
    const reasons: string[] = [];
    if (mcp.requiresAuth && !mcp.authenticated) {
      reasons.push("OAuth authentication");
    }
    if (mcp.requiresInput && !mcp.configured) {
      reasons.push("configuration");
    }

    lines.push(
      `- ⚠️ **${mcp.name}**: Requires ${reasons.join(" and ")} - visit homepage to set up`
    );
  }

  return lines.join("\n");
}

/**
 * Fetch session context from gateway for OpenClaw worker.
 * Returns gateway instructions and dynamic provider configuration.
 * Caches the result until invalidated by a config_changed SSE event.
 * Skips MCP server config (OpenClaw doesn't use Claude SDK's MCP format).
 */
export async function getOpenClawSessionContext(): Promise<{
  gatewayInstructions: string;
  providerConfig: ProviderConfig;
}> {
  if (cachedResult) {
    logger.debug("Returning cached session context");
    return cachedResult;
  }

  const dispatcherUrl = process.env.DISPATCHER_URL;
  const workerToken = process.env.WORKER_TOKEN;

  if (!dispatcherUrl || !workerToken) {
    logger.warn("Missing dispatcher URL or worker token for session context");
    return { gatewayInstructions: "", providerConfig: {} };
  }

  try {
    const url = new URL(
      "/worker/session-context",
      ensureBaseUrl(dispatcherUrl)
    );
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${workerToken}`,
      },
    });

    if (!response.ok) {
      logger.warn("Gateway returned non-success status for session context", {
        status: response.status,
      });
      return { gatewayInstructions: "", providerConfig: {} };
    }

    const data = (await response.json()) as SessionContextResponse;

    logger.info(
      `Received session context: ${data.platformInstructions.length} chars platform instructions, ${data.mcpStatus.length} MCP status entries, provider: ${data.providerConfig?.defaultProvider || "none"}, cliBackends: ${data.providerConfig?.cliBackends?.map((b) => b.name).join(", ") || "none"}`
    );

    const mcpInstructions = buildMcpInstructions(data.mcpStatus);
    const mcpToolInstructions =
      data.mcpTools && Object.keys(data.mcpTools).length > 0
        ? buildMcpToolInstructions(data.mcpTools, dispatcherUrl)
        : "";

    const gatewayInstructions = [
      data.agentInstructions,
      data.platformInstructions,
      data.networkInstructions,
      data.skillsInstructions,
      mcpInstructions,
      mcpToolInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");

    logger.info(
      `Built gateway instructions: agent (${(data.agentInstructions || "").length} chars) + platform (${data.platformInstructions.length} chars) + network (${data.networkInstructions.length} chars) + skills (${(data.skillsInstructions || "").length} chars) + MCP (${mcpInstructions.length} chars)`
    );

    const result = {
      gatewayInstructions,
      providerConfig: data.providerConfig || {},
    };
    cachedResult = result;
    return result;
  } catch (error) {
    logger.error("Failed to fetch session context from gateway", { error });
    return { gatewayInstructions: "", providerConfig: {} };
  }
}
