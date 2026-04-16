import {
  type ConfigProviderMeta,
  createLogger,
  type McpStatus,
  type McpToolDef,
} from "@lobu/core";
import { ensureBaseUrl } from "../core/url-utils";

const logger = createLogger("openclaw-session-context");

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
  /** Dynamic provider metadata from config-driven providers */
  configProviders?: Record<string, ConfigProviderMeta>;
  /** Credential env var placeholders for proxy mode (e.g. Z_AI_API_KEY → "lobu-proxy") */
  credentialPlaceholders?: Record<string, string>;
}

interface SkillContent {
  name: string;
  content: string;
}

interface SessionContextResponse {
  agentInstructions: string;
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
  mcpTools?: Record<string, McpToolDef[]>;
  mcpInstructions?: Record<string, string>;
  mcpContext?: Record<string, string>;
  providerConfig?: ProviderConfig;
  skillsConfig?: SkillContent[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SESSION_CONTEXT = {
  agentInstructions: "",
  gatewayInstructions: "",
  providerConfig: {} as ProviderConfig,
  skillsConfig: [] as SkillContent[],
  mcpStatus: [] as McpStatus[],
  mcpTools: {} as Record<string, McpToolDef[]>,
  mcpContext: {} as Record<string, string>,
} as const;

// Module-level cache for session context
let cachedResult: {
  agentInstructions: string;
  gatewayInstructions: string;
  providerConfig: ProviderConfig;
  skillsConfig: SkillContent[];
  mcpStatus: McpStatus[];
  mcpTools: Record<string, McpToolDef[]>;
  mcpContext: Record<string, string>;
  mcpExposure: "tools" | "cli";
  cachedAt: number;
} | null = null;

/**
 * Invalidate the session context cache.
 * Called by the SSE client when a config_changed event is received.
 */
export function invalidateSessionContextCache(): void {
  cachedResult = null;
  logger.info("Session context cache invalidated");
}

function buildMcpInstructions(
  mcpStatus: McpStatus[],
  mcpToolIds: Set<string>,
  mcpExposure: "tools" | "cli" = "tools"
): string {
  if (!mcpStatus || mcpStatus.length === 0) {
    return "";
  }

  const needsAuthentication = mcpStatus.filter(
    (mcp) => mcp.requiresAuth && !mcp.authenticated
  );
  const needsConfiguration = mcpStatus.filter(
    (mcp) => mcp.requiresInput && !mcp.configured
  );
  const undiscoveredMcps = mcpStatus.filter((mcp) => !mcpToolIds.has(mcp.id));

  if (
    needsAuthentication.length === 0 &&
    needsConfiguration.length === 0 &&
    undiscoveredMcps.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["## MCP Tools Requiring Setup"];

  for (const mcp of needsAuthentication) {
    const loginCmd =
      mcpExposure === "cli"
        ? `run \`${mcp.id} auth login\` in Bash`
        : `call \`${mcp.id}_login\``;
    const checkCmd =
      mcpExposure === "cli"
        ? `run \`${mcp.id} auth check\``
        : `call \`${mcp.id}_login_check\``;
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Authentication is required. To start login, ${loginCmd}. After the user completes login, ${checkCmd}. Newly available MCP tools will refresh on the next message.`
    );
  }

  for (const mcp of needsConfiguration) {
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Additional MCP input is required before this server can be used. Tell the user an admin must configure the MCP inputs in settings.`
    );
  }

  for (const mcp of undiscoveredMcps) {
    if (mcp.requiresAuth || mcp.requiresInput) {
      continue;
    }
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): No tools were discovered for this MCP in the current session. Do not assume a login tool exists unless it is actually registered.`
    );
  }

  return lines.join("\n");
}

/**
 * CLI-mode header introducing the `<server> <tool>` idiom. Appended to gateway
 * instructions when `mcpExposure === "cli"` so the model understands how to
 * invoke MCP tools through bash instead of as first-class function calls.
 */
function buildMcpCliInstructions(mcpStatus: McpStatus[]): string {
  if (!mcpStatus || mcpStatus.length === 0) return "";
  const servers = mcpStatus.map((m) => `- \`${m.id}\` — ${m.name}`).join("\n");
  return `## Available MCP CLIs

MCP servers are exposed as Bash commands. One command per server. Invoke tools by piping JSON on stdin:

\`\`\`bash
<server> <tool> <<'EOF'
{ ...json args... }
EOF
\`\`\`

Discovery:
- \`<server> --help\` — list a server's tools
- \`<server> <tool> --schema\` — print the JSON Schema for a tool
- \`<server> auth login|check|logout\` — manage OAuth where required

Servers:
${servers}`;
}

function buildMcpServerInstructions(
  mcpInstructions: Record<string, string>
): string {
  const entries = Object.entries(mcpInstructions).filter(([, v]) => v);
  if (entries.length === 0) return "";

  const lines: string[] = ["## MCP Server Instructions", ""];
  for (const [mcpId, instructions] of entries) {
    lines.push(`### ${mcpId}`, "", instructions, "");
  }
  return lines.join("\n");
}

/**
 * Fetch session context from gateway for OpenClaw worker.
 * Returns gateway instructions and dynamic provider configuration.
 * Caches the result until invalidated by a config_changed SSE event.
 * Skips MCP server config (OpenClaw doesn't use Claude SDK's MCP format).
 */
export async function getOpenClawSessionContext(
  opts: { mcpExposure?: "tools" | "cli" } = {}
): Promise<{
  /**
   * Identity/soul/user instructions for this agent. Returned separately from
   * `gatewayInstructions` so the worker can prepend identity BEFORE the
   * pi-coding-agent base prompt (which would otherwise anchor the model with
   * "You are an expert coding assistant" before the agent's real persona is
   * declared).
   */
  agentInstructions: string;
  /** Platform / network / skills / MCP setup instructions (no identity). */
  gatewayInstructions: string;
  providerConfig: ProviderConfig;
  skillsConfig: SkillContent[];
  mcpStatus: McpStatus[];
  mcpTools: Record<string, McpToolDef[]>;
  mcpContext: Record<string, string>;
}> {
  const mcpExposure: "tools" | "cli" = opts.mcpExposure ?? "tools";

  if (
    cachedResult &&
    cachedResult.mcpExposure === mcpExposure &&
    Date.now() - cachedResult.cachedAt < CACHE_TTL_MS
  ) {
    logger.debug("Returning cached session context");
    return cachedResult;
  }

  const dispatcherUrl = process.env.DISPATCHER_URL;
  const workerToken = process.env.WORKER_TOKEN;

  if (!dispatcherUrl || !workerToken) {
    logger.warn("Missing dispatcher URL or worker token for session context");
    return { ...DEFAULT_SESSION_CONTEXT };
  }

  try {
    const url = new URL(
      `${ensureBaseUrl(dispatcherUrl)}/worker/session-context`
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
      return { ...DEFAULT_SESSION_CONTEXT };
    }

    const data = (await response.json()) as SessionContextResponse;

    logger.info(
      `Received session context: ${data.platformInstructions.length} chars platform instructions, ${data.mcpStatus.length} MCP status entries, provider: ${data.providerConfig?.defaultProvider || "none"}, cliBackends: ${data.providerConfig?.cliBackends?.map((b) => b.name).join(", ") || "none"}`
    );

    const toolMcpIds = new Set(Object.keys(data.mcpTools || {}));
    const mcpSetupInstructions = buildMcpInstructions(
      data.mcpStatus,
      toolMcpIds,
      mcpExposure
    );
    // Include MCP server instructions for all servers (with or without tools).
    // These provide workspace context (available connectors, entity schemas, etc.)
    // that helps the agent use the tools effectively.
    const mcpServerInstructions = buildMcpServerInstructions(
      data.mcpInstructions || {}
    );
    const mcpCliInstructions =
      mcpExposure === "cli" ? buildMcpCliInstructions(data.mcpStatus) : "";

    // Identity/soul/user instructions are returned separately so the worker
    // can prepend them BEFORE the pi-coding-agent base prompt.
    const agentInstructions = data.agentInstructions || "";

    const gatewayInstructions = [
      data.platformInstructions,
      data.networkInstructions,
      data.skillsInstructions,
      mcpCliInstructions,
      mcpSetupInstructions,
      mcpServerInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");

    const mcpTools = data.mcpTools || {};

    logger.info(
      `Built gateway instructions: agent (${agentInstructions.length} chars, prepended) + platform (${data.platformInstructions.length} chars) + network (${data.networkInstructions.length} chars) + skills (${(data.skillsInstructions || "").length} chars) + MCP setup (${mcpSetupInstructions.length} chars) + MCP server instructions (${mcpServerInstructions.length} chars), mcpTools: ${Object.keys(mcpTools).length} servers`
    );

    const mcpContext = data.mcpContext || {};

    const result = {
      agentInstructions,
      gatewayInstructions,
      providerConfig: data.providerConfig || {},
      skillsConfig: data.skillsConfig || [],
      mcpStatus: data.mcpStatus || [],
      mcpTools,
      mcpContext,
    };

    // Don't cache if any authenticated MCP returned no tools — likely a
    // transient upstream failure that should be retried on the next message.
    const hasEmptyAuthenticatedMcp = data.mcpStatus.some(
      (mcp) => mcp.authenticated && !toolMcpIds.has(mcp.id)
    );
    if (!hasEmptyAuthenticatedMcp) {
      cachedResult = { ...result, mcpExposure, cachedAt: Date.now() };
    } else {
      logger.warn(
        "Skipping session context cache — authenticated MCP(s) returned no tools",
        {
          emptyMcps: data.mcpStatus
            .filter((mcp) => mcp.authenticated && !toolMcpIds.has(mcp.id))
            .map((mcp) => mcp.id),
        }
      );
    }

    return result;
  } catch (error) {
    logger.error("Failed to fetch session context from gateway", { error });
    return { ...DEFAULT_SESSION_CONTEXT };
  }
}
