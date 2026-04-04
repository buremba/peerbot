#!/usr/bin/env bun

import type {
  ConfigProviderMeta,
  InstructionContext,
  WorkerTokenData,
} from "@lobu/core";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ApiKeyProviderModule } from "../auth/api-key-provider-module";
import type { McpConfigService } from "../auth/mcp/config-service";
import type { McpProxy } from "../auth/mcp/proxy";
import type { McpTool } from "../auth/mcp/tool-cache";
import type { ProviderCatalogService } from "../auth/provider-catalog";
import { resolveEffectiveModelRef } from "../auth/settings/model-selection";
import type { IMessageQueue } from "../infrastructure/queue";
import type { InstructionService } from "../services/instruction-service";
import type { SettingsResolver } from "../services/settings-resolver";
import type { SystemSkillsService } from "../services/system-skills-service";
import type { ISessionManager } from "../session";
import { type SSEWriter, WorkerConnectionManager } from "./connection-manager";
import { WorkerJobRouter } from "./job-router";

const logger = createLogger("worker-gateway");

/**
 * Worker Gateway - SSE and HTTP endpoints for worker communication
 * Workers connect via SSE to receive jobs, send responses via HTTP POST
 * Uses encrypted tokens for authentication and routing
 */
export class WorkerGateway {
  private app: Hono;
  private connectionManager: WorkerConnectionManager;
  private jobRouter: WorkerJobRouter;
  private queue: IMessageQueue;
  private mcpConfigService: McpConfigService;
  private instructionService: InstructionService;
  private publicGatewayUrl: string;
  private mcpProxy?: McpProxy;
  private providerCatalogService?: ProviderCatalogService;
  private settingsResolver?: SettingsResolver;
  private systemSkillsService?: SystemSkillsService;

  constructor(
    queue: IMessageQueue,
    publicGatewayUrl: string,
    sessionManager: ISessionManager,
    mcpConfigService: McpConfigService,
    instructionService: InstructionService,
    mcpProxy?: McpProxy,
    providerCatalogService?: ProviderCatalogService,
    settingsResolver?: SettingsResolver,
    systemSkillsService?: SystemSkillsService
  ) {
    this.queue = queue;
    this.publicGatewayUrl = publicGatewayUrl;
    this.connectionManager = new WorkerConnectionManager();
    this.jobRouter = new WorkerJobRouter(
      queue,
      this.connectionManager,
      sessionManager
    );
    this.mcpConfigService = mcpConfigService;
    this.instructionService = instructionService;
    this.mcpProxy = mcpProxy;
    this.providerCatalogService = providerCatalogService;
    this.settingsResolver = settingsResolver;
    this.systemSkillsService = systemSkillsService;

    // Setup Hono app
    this.app = new Hono();
    this.setupRoutes();
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Get the connection manager (for sending SSE notifications from external routes)
   */
  getConnectionManager(): WorkerConnectionManager {
    return this.connectionManager;
  }

  /**
   * Setup routes on Hono app
   */
  private setupRoutes() {
    // SSE endpoint for workers to receive jobs
    // Routes are mounted at /worker, so paths here should be relative
    this.app.get("/stream", (c) => this.handleStreamConnection(c));

    // HTTP POST endpoint for workers to send responses
    this.app.post("/response", (c) => this.handleWorkerResponse(c));

    // Unified session context endpoint (includes MCP + instructions)
    this.app.get("/session-context", (c) =>
      this.handleSessionContextRequest(c)
    );

    logger.debug("Worker gateway routes registered");
  }

  /**
   * Handle SSE connection from worker
   */
  private async handleStreamConnection(c: Context): Promise<Response> {
    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName, userId, conversationId, agentId } =
      auth.tokenData as any;
    if (!conversationId) {
      return c.json({ error: "Invalid token (missing conversationId)" }, 401);
    }

    // Extract httpPort from query params (worker HTTP server registration)
    const httpPortParam = c.req.query("httpPort");
    const httpPort = httpPortParam ? parseInt(httpPortParam, 10) : undefined;

    // Create an SSE stream
    return stream(c, async (streamWriter) => {
      let isClosed = false;

      // Create an SSE writer adapter
      const sseWriter: SSEWriter = {
        write: (data: string): boolean => {
          try {
            void streamWriter.write(data);
            return true;
          } catch {
            return false;
          }
        },
        end: () => {
          try {
            streamWriter.close();
          } catch {
            // Already closed
          }
        },
        onClose: (callback: () => void) => {
          streamWriter.onAbort(() => {
            isClosed = true;
            callback();
          });
        },
      };

      // Set SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      // Clean up stale state before registering new connection.
      // When a container dies without cleanly closing its TCP socket,
      // the old SSE connection may still appear valid. Pause the BullMQ
      // worker first to prevent it from sending jobs to the dead connection,
      // then remove the stale connection so any in-flight handleJob will
      // fail and trigger a retry against the new connection.
      await this.jobRouter.pauseWorker(deploymentName);
      if (this.connectionManager.isConnected(deploymentName)) {
        logger.info(
          `Cleaning up stale connection for ${deploymentName} before new SSE`
        );
        // Intentionally no expectedWriter — always evict the old connection
        this.connectionManager.removeConnection(deploymentName);
      }

      // Register new (live) connection
      this.connectionManager.addConnection(
        deploymentName,
        userId,
        conversationId,
        agentId || "",
        sseWriter,
        httpPort
      );

      // Register BullMQ worker (idempotent) and resume job processing
      await this.jobRouter.registerWorker(deploymentName);
      await this.jobRouter.resumeWorker(deploymentName);

      // Handle client disconnect — only act if this is still the active writer
      sseWriter.onClose(() => {
        const current = this.connectionManager.getConnection(deploymentName);
        if (current && current.writer !== sseWriter) {
          logger.debug(
            `Ignoring stale disconnect for ${deploymentName} (replaced by newer SSE)`
          );
          return;
        }
        this.jobRouter.pauseWorker(deploymentName).catch((err) => {
          logger.error(`Failed to pause worker ${deploymentName}:`, err);
        });
        this.connectionManager.removeConnection(deploymentName);
      });

      // Keep the connection open until the stream is actually aborted.
      while (!isClosed) {
        await streamWriter.sleep(1000);
      }
    });
  }

  /**
   * Handle HTTP response from worker
   */
  private async handleWorkerResponse(c: Context): Promise<Response> {
    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName } = auth.tokenData;

    // Update connection activity
    this.connectionManager.touchConnection(deploymentName);

    try {
      const body = await c.req.json();
      const { jobId, ...responseData } = body;
      const enrichedResponse =
        auth.tokenData.connectionId &&
        (!responseData.platformMetadata ||
          typeof responseData.platformMetadata === "object")
          ? {
              ...responseData,
              platformMetadata: {
                ...(responseData.platformMetadata || {}),
                connectionId: auth.tokenData.connectionId,
              },
            }
          : responseData;

      // Acknowledge job completion if jobId provided
      if (jobId) {
        this.jobRouter.acknowledgeJob(jobId);
      }

      // Delivery receipts (worker ACKs) have no message payload — just acknowledge and return
      if (enrichedResponse.received) {
        if (enrichedResponse.heartbeat) {
          // touchConnection already ran above for all /worker/response calls,
          // keeping this worker alive in stale-cleanup.
          logger.debug(
            `[WORKER-GATEWAY] Received heartbeat ACK from ${deploymentName}`
          );
        }
        return c.json({ success: true });
      }

      // Log for debugging
      logger.info(
        `[WORKER-GATEWAY] Received response with fields: ${Object.keys(enrichedResponse).join(", ")}`
      );
      if (enrichedResponse.delta) {
        logger.info(
          `[WORKER-GATEWAY] Stream delta: deltaLength=${enrichedResponse.delta.length}`
        );
      }

      // Send response to thread_response queue
      await this.queue.send("thread_response", enrichedResponse);

      return c.json({ success: true });
    } catch (error) {
      logger.error(`Error handling worker response: ${error}`);
      return c.json({ error: "Failed to process response" }, 500);
    }
  }

  /**
   * Unified session context endpoint
   */
  private async handleSessionContextRequest(c: Context): Promise<Response> {
    if (!this.mcpConfigService || !this.instructionService) {
      return c.json({ error: "session_context_unavailable" }, 503);
    }

    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    try {
      const {
        userId,
        platform,
        sessionKey,
        conversationId,
        agentId,
        deploymentName,
      } = auth.tokenData;
      const baseUrl = this.getRequestBaseUrl(c);
      if (!conversationId) {
        return c.json({ error: "Invalid token (missing conversationId)" }, 401);
      }

      // Build instruction context
      const instructionContext: InstructionContext = {
        userId,
        agentId: agentId || "",
        sessionKey: sessionKey || "",
        workingDirectory: "/workspace",
        availableProjects: [],
      };

      // Build settings URL for soul-empty fallback
      const settingsUrl = new URL(
        agentId
          ? `/api/v1/agents/${encodeURIComponent(agentId)}/config`
          : "/api/v1/agents",
        baseUrl
      );

      // Fetch MCP config and session context in parallel
      const [mcpConfig, contextData] = await Promise.all([
        this.mcpConfigService.getWorkerConfig({
          baseUrl,
          workerToken: auth.token,
          deploymentName,
        }),
        this.instructionService.getSessionContext(
          platform || "unknown",
          instructionContext,
          { settingsUrl: settingsUrl.toString() }
        ),
      ]);

      // Fetch tool lists and instructions for ALL MCPs (unauthenticated ones
      // will attempt discovery without credentials)
      const mcpTools: Record<string, McpTool[]> = {};
      const mcpInstructions: Record<string, string> = {};
      if (this.mcpProxy && contextData.mcpStatus.length > 0) {
        const toolResults = await Promise.allSettled(
          contextData.mcpStatus.map(async (mcp) => {
            const result = await this.mcpProxy?.fetchToolsForMcp(
              mcp.id,
              agentId || userId,
              auth.tokenData
            );
            return { mcpId: mcp.id, ...(result || { tools: [] }) };
          })
        );

        for (const result of toolResults) {
          if (result.status === "fulfilled") {
            if (result.value.tools && result.value.tools.length > 0) {
              mcpTools[result.value.mcpId] = result.value.tools;
            }
            if (result.value.instructions) {
              mcpInstructions[result.value.mcpId] = result.value.instructions;
            }
          } else {
            logger.error("MCP tool fetch rejected", {
              reason:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }
      }

      // Resolve dynamic provider configuration (with template agent fallback)
      const agentSettings =
        this.settingsResolver && agentId
          ? await this.settingsResolver.getEffectiveSettings(agentId)
          : null;
      const providerConfig = await this.resolveProviderConfig(
        agentSettings?.templateAgentId || agentId || "",
        resolveEffectiveModelRef(agentSettings),
        baseUrl
      );

      // Fetch enabled skills with content for worker filesystem sync
      let skillsConfig: Array<{ name: string; content: string }> = [];
      const mcpContext: Record<string, string> = {};
      if (this.settingsResolver && agentId) {
        try {
          const settings =
            await this.settingsResolver.getEffectiveSettings(agentId);
          const skills = settings?.skillsConfig?.skills || [];
          skillsConfig = skills
            .filter((s) => s.enabled && s.content)
            .map((s) => ({ name: s.name, content: s.content! }));
          // Build MCP context map: MCP server ID → skill instructions
          for (const skill of skills) {
            if (
              skill.enabled &&
              skill.instructions?.trim() &&
              skill.mcpServers?.length
            ) {
              for (const mcp of skill.mcpServers) {
                mcpContext[mcp.id] = skill.instructions.trim();
              }
            }
          }
        } catch (error) {
          logger.error("Failed to fetch skills config for worker sync", {
            error,
          });
        }
      }

      let systemSkillsInstructions = "";
      if (this.systemSkillsService) {
        try {
          const runtimeSystemSkills =
            await this.systemSkillsService.getRuntimeSystemSkills();

          if (runtimeSystemSkills.length > 0) {
            // Only write SKILL.md files for system skills without instructions
            // (skills with instructions are fully inlined — no cat needed)
            const existingSkillNames = new Set(skillsConfig.map((s) => s.name));
            let hasSkillFiles = false;
            for (const skill of runtimeSystemSkills) {
              if (skill.instructions?.trim()) continue;
              const workspaceSkillName = `system-${skill.id}`;
              if (!existingSkillNames.has(workspaceSkillName)) {
                skillsConfig.push({
                  name: workspaceSkillName,
                  content: skill.content,
                });
                hasSkillFiles = true;
              }
            }

            const summaryLines = runtimeSystemSkills.map((skill, index) => {
              const description = skill.description
                ? ` - ${skill.description}`
                : "";
              const line = `${index + 1}. ${skill.name} (\`${skill.repo}\`)${description}`;
              if (skill.instructions?.trim()) {
                return `${line}\n   → ${skill.instructions.trim()}`;
              }
              return line;
            });

            const catHint = hasSkillFiles
              ? "\n\nRead full instructions using `cat .skills/system-*/SKILL.md` when needed."
              : "";

            systemSkillsInstructions =
              [
                "## Built-in System Skills",
                "",
                "These system skills are always available in this workspace:",
                "",
                ...summaryLines,
              ].join("\n") + catHint;
          }
        } catch (error) {
          logger.error("Failed to fetch runtime system skills", { error });
        }
      }

      const mergedSkillsInstructions = [
        contextData.skillsInstructions,
        systemSkillsInstructions,
      ]
        .filter(Boolean)
        .join("\n\n");

      logger.info(
        `Session context for ${userId}: ${Object.keys(mcpConfig.mcpServers || {}).length} MCPs, ${contextData.agentInstructions.length} chars agent instructions, ${contextData.platformInstructions.length} chars platform instructions, ${contextData.networkInstructions.length} chars network instructions, ${mergedSkillsInstructions.length} chars skills instructions, ${contextData.mcpStatus.length} MCP status entries, ${Object.keys(mcpTools).length} MCP tool lists, ${Object.keys(mcpInstructions).length} MCP instructions, ${skillsConfig.length} skills, provider: ${providerConfig.defaultProvider || "none"}`
      );

      return c.json({
        mcpConfig,
        agentInstructions: contextData.agentInstructions,
        platformInstructions: contextData.platformInstructions,
        networkInstructions: contextData.networkInstructions,
        skillsInstructions: mergedSkillsInstructions,
        mcpStatus: contextData.mcpStatus,
        mcpTools,
        mcpInstructions,
        mcpContext,
        providerConfig,
        skillsConfig,
      });
    } catch (error) {
      logger.error("Failed to generate session context", { error });
      return c.json({ error: "session_context_error" }, 500);
    }
  }

  private authenticateWorker(
    c: Context
  ): { tokenData: WorkerTokenData; token: string } | null {
    const authHeader = c.req.header("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const tokenData = verifyWorkerToken(token);

    if (!tokenData) {
      logger.warn("Invalid token");
      return null;
    }

    return { tokenData, token };
  }

  private getRequestBaseUrl(c: Context): string {
    const forwardedProto = c.req.header("x-forwarded-proto");
    const protocolCandidate = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(",")[0];
    const protocol = (protocolCandidate || "http").trim();
    const host = c.req.header("host");
    if (host) {
      return `${protocol}://${host}`;
    }
    return this.publicGatewayUrl;
  }

  /**
   * Get active worker connections
   */
  getActiveConnections(): string[] {
    return this.connectionManager.getActiveConnections();
  }

  /**
   * Resolve dynamic provider configuration for a given agent.
   * Mirrors the provider resolution logic in base-deployment-manager's
   * generateEnvironmentVariables() but returns config values instead of env vars.
   */
  private async resolveProviderConfig(
    agentId: string,
    agentModel?: string,
    requestBaseUrl?: string
  ): Promise<{
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
    configProviders?: Record<string, ConfigProviderMeta>;
  }> {
    if (!this.providerCatalogService || !agentId) {
      return {};
    }

    const effectiveProviders =
      await this.providerCatalogService.getInstalledModules(agentId);
    if (effectiveProviders.length === 0) {
      return {};
    }

    // Determine primary provider
    let primaryProvider = agentModel
      ? await this.providerCatalogService.findProviderForModel(
          agentModel,
          effectiveProviders
        )
      : undefined;

    if (!primaryProvider) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
    }

    // Build proxy base URL mappings for all installed providers
    // Use the request base URL (the worker's DISPATCHER_URL) for internal routing
    const proxyBaseUrl = `${requestBaseUrl || this.publicGatewayUrl}/api/proxy`;
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      Object.assign(
        providerBaseUrlMappings,
        provider.getProxyBaseUrlMappings(proxyBaseUrl, agentId)
      );
    }

    // Build CLI backend configs
    const cliBackends: Array<{
      providerId: string;
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      modelArg?: string;
      sessionArg?: string;
    }> = [];
    for (const provider of effectiveProviders) {
      const config = provider.getCliBackendConfig?.();
      if (config) {
        cliBackends.push({ providerId: provider.providerId, ...config });
      }
    }

    // Collect metadata from config-driven providers for worker model resolution
    const configProviders: Record<string, ConfigProviderMeta> = {};
    for (const provider of effectiveProviders) {
      const meta = (provider as ApiKeyProviderModule).getProviderMetadata?.();
      if (meta) {
        configProviders[provider.providerId] = meta;
      }
    }

    // Build credential placeholders for proxy mode — in-process workers need
    // these so the runtime doesn't reject requests before they reach the proxy.
    const credentialPlaceholders: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      if (provider.hasSystemKey() || (await provider.hasCredentials(agentId))) {
        const credVar = provider.getCredentialEnvVarName();
        const placeholder = provider.buildCredentialPlaceholder
          ? await provider.buildCredentialPlaceholder(agentId)
          : "lobu-proxy";
        credentialPlaceholders[credVar] = placeholder;
      }
    }

    const result: {
      credentialEnvVarName?: string;
      defaultProvider?: string;
      defaultModel?: string;
      cliBackends?: typeof cliBackends;
      providerBaseUrlMappings?: Record<string, string>;
      configProviders?: typeof configProviders;
      credentialPlaceholders?: Record<string, string>;
    } = {};

    if (primaryProvider) {
      result.credentialEnvVarName = primaryProvider.getCredentialEnvVarName();
      const upstream = primaryProvider.getUpstreamConfig?.();
      if (upstream?.slug) {
        result.defaultProvider = upstream.slug;
      }
    }

    if (agentModel) {
      result.defaultModel = agentModel;
    }

    if (Object.keys(providerBaseUrlMappings).length > 0) {
      result.providerBaseUrlMappings = providerBaseUrlMappings;
    }

    if (cliBackends.length > 0) {
      result.cliBackends = cliBackends;
    }

    if (Object.keys(configProviders).length > 0) {
      result.configProviders = configProviders;
    }

    if (Object.keys(credentialPlaceholders).length > 0) {
      result.credentialPlaceholders = credentialPlaceholders;
    }

    return result;
  }

  /**
   * Shutdown gateway
   */
  shutdown(): void {
    this.connectionManager.shutdown();
    this.jobRouter.shutdown();
  }
}
