#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createLogger,
  type PluginsConfig,
  type ToolsConfig,
  type WorkerTransport,
} from "@lobu/core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as Sentry from "@sentry/node";
import { handleExecutionError } from "../core/error-handler";
import { listAppDirectories } from "../core/project-scanner";
import type {
  ProgressUpdate,
  SessionExecutionResult,
  WorkerConfig,
  WorkerExecutor,
} from "../core/types";
import { WorkspaceManager } from "../core/workspace";
import { HttpWorkerTransport } from "../gateway/gateway-integration";
import { generateCustomInstructions } from "../instructions/builder";
import { ProjectsInstructionProvider } from "../instructions/providers";
import { fetchAudioProviderSuggestions } from "../shared/audio-provider-suggestions";
import {
  getApiKeyEnvVarForProvider,
  getProviderAuthHintFromError,
} from "../shared/provider-auth-hints";
import {
  type GatewayParams,
  generateImage,
} from "../shared/tool-implementations";
import {
  createMcpAuthToolDefinitions,
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "./custom-tools";
import {
  OpenClawCoreInstructionProvider,
  OpenClawPromptIntentInstructionProvider,
} from "./instructions";
import {
  DEFAULT_PROVIDER_BASE_URL_ENV,
  openOrCreateSessionManager,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "./model-resolver";
import { checkSandboxLeak } from "./sandbox-leak";
import {
  loadPlugins,
  runPluginHooks,
  startPluginServices,
  stopPluginServices,
} from "./plugin-loader";
import { OpenClawProgressProcessor } from "./processor";
import { getOpenClawSessionContext } from "./session-context";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
} from "./tool-policy";
import { createOpenClawTools } from "./tools";

const logger = createLogger("worker");

const MEMORY_FLUSH_STATE_CUSTOM_TYPE = "lobu.memory_flush_state";
const APPROX_IMAGE_TOKENS = 1200;

interface ResolvedMemoryFlushConfig {
  enabled: boolean;
  softThresholdTokens: number;
  systemPrompt: string;
  prompt: string;
}

interface MemoryFlushStateData {
  compactionCount: number;
  outcome: "no_reply" | "stored";
  timestamp: number;
}

const DEFAULT_MEMORY_FLUSH_CONFIG: ResolvedMemoryFlushConfig = {
  enabled: true,
  softThresholdTokens: 4000,
  systemPrompt: "Session nearing compaction. Store durable memories now.",
  prompt:
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store.",
};

/**
 * Pi-coding-agent's buildSystemPrompt() (in `@mariozechner/pi-coding-agent`)
 * always opens the system prompt with this exact sentence. Lobu agents can
 * override their identity via IDENTITY.md, but unless we strip out this
 * opener the model sees two competing role declarations and tends to favour
 * "expert coding assistant" because it appears first.
 *
 * This helper substitutes the opener with the agent's identity and keeps the
 * rest of the base prompt (tools list, guidelines, docs paths, cwd) intact.
 *
 * If the upstream package ever changes the opener wording, this becomes a
 * no-op and `replaced === original`. In that case we fall back to prepending
 * the identity with a small framing note so identity still wins ordering.
 */
const PI_CODING_AGENT_OPENER_RE =
  /^You are an expert coding assistant operating inside pi, a coding agent harness\.[^\n]*/;

export function replaceBasePromptIdentity(
  basePrompt: string,
  identity: string
): string {
  if (PI_CODING_AGENT_OPENER_RE.test(basePrompt)) {
    return basePrompt.replace(PI_CODING_AGENT_OPENER_RE, identity);
  }
  // Upstream wording drifted — prepend identity with a framing note rather
  // than silently letting the upstream opener win.
  return `${identity}\n\nThe section below describes the runtime tooling available to you. It does not change your role.\n\n${basePrompt}`;
}

function isLikelyImageGenerationRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const explicitToolInstruction =
    lower.includes("generateimage tool") || lower.includes("use generateimage");
  const directShortcutEnabled =
    process.env.WORKER_ENABLE_DIRECT_IMAGE_SHORTCUT === "true";
  return directShortcutEnabled && explicitToolInstruction;
}

function extractToolTextContent(result: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (item): item is { type: string; text: string } =>
        item?.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringOrFallback(
  value: unknown,
  fallback: string,
  allowEmpty = false
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) {
    return fallback;
  }
  return allowEmpty ? value : trimmed;
}

function readNonNegativeNumberOrFallback(
  value: unknown,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function countCompactionsOnCurrentBranch(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number {
  const branch = sessionManager.getBranch();
  return branch.reduce((count, entry) => {
    if (entry.type === "compaction") {
      return count + 1;
    }
    return count;
  }, 0);
}

function readLastFlushedCompactionCount(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number | null {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type !== "custom") continue;
    if (entry.customType !== MEMORY_FLUSH_STATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) continue;
    const compactionCount = entry.data.compactionCount;
    if (
      typeof compactionCount === "number" &&
      Number.isFinite(compactionCount) &&
      compactionCount >= 0
    ) {
      return compactionCount;
    }
  }
  return null;
}

function getLatestAssistantText(
  messages: unknown[]
): { text: string; normalizedNoReply: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .flatMap((block) => {
          if (!isRecord(block)) return [];
          if (block.type !== "text") return [];
          return typeof block.text === "string" ? [block.text] : [];
        })
        .join("");
    }

    const normalized = text.trim().toUpperCase();
    return {
      text,
      normalizedNoReply: normalized === "NO_REPLY",
    };
  }
  return null;
}

export function estimatePromptTokenCost(
  promptText: string,
  imageCount: number
): number {
  const textTokens = Math.ceil(promptText.length / 4);
  const imageTokens = Math.max(0, imageCount) * APPROX_IMAGE_TOKENS;
  return textTokens + imageTokens;
}

export function resolveMemoryFlushConfig(
  rawOptions: Record<string, unknown>
): ResolvedMemoryFlushConfig {
  const compaction = isRecord(rawOptions.compaction)
    ? rawOptions.compaction
    : undefined;
  const memoryFlush =
    compaction && isRecord(compaction.memoryFlush)
      ? compaction.memoryFlush
      : undefined;

  return {
    enabled:
      typeof memoryFlush?.enabled === "boolean"
        ? memoryFlush.enabled
        : DEFAULT_MEMORY_FLUSH_CONFIG.enabled,
    softThresholdTokens: readNonNegativeNumberOrFallback(
      memoryFlush?.softThresholdTokens,
      DEFAULT_MEMORY_FLUSH_CONFIG.softThresholdTokens
    ),
    systemPrompt: readStringOrFallback(
      memoryFlush?.systemPrompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.systemPrompt
    ),
    prompt: readStringOrFallback(
      memoryFlush?.prompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.prompt
    ),
  };
}

export class OpenClawWorker implements WorkerExecutor {
  private workspaceManager: WorkspaceManager;
  public workerTransport: WorkerTransport;
  private config: WorkerConfig;
  private progressProcessor: OpenClawProgressProcessor;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workspaceManager = new WorkspaceManager(config.workspace);
    this.progressProcessor = new OpenClawProgressProcessor();

    // Verify required environment variables
    const gatewayUrl = process.env.DISPATCHER_URL;
    const workerToken = process.env.WORKER_TOKEN;

    if (!gatewayUrl || !workerToken) {
      throw new Error(
        "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
      );
    }

    if (!config.teamId) {
      throw new Error("teamId is required for worker initialization");
    }
    if (!config.conversationId) {
      throw new Error("conversationId is required for worker initialization");
    }
    this.workerTransport = new HttpWorkerTransport({
      gatewayUrl,
      workerToken,
      userId: config.userId,
      channelId: config.channelId,
      conversationId: config.conversationId,
      originalMessageTs: config.responseId,
      botResponseTs: config.botResponseId,
      teamId: config.teamId,
      platform: config.platform,
      platformMetadata: config.platformMetadata,
    });
  }

  /**
   * Main execution workflow
   */
  async execute(): Promise<void> {
    const executeStartTime = Date.now();

    try {
      this.progressProcessor.reset();

      logger.info(
        `🚀 Starting OpenClaw worker for session: ${this.config.sessionKey}`
      );
      logger.info(
        `[TIMING] Worker execute() started at: ${new Date(executeStartTime).toISOString()}`
      );

      // Decode user prompt
      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString(
        "utf-8"
      );
      logger.info(`User prompt: ${userPrompt.substring(0, 100)}...`);

      // Setup workspace
      logger.info("Setting up workspace...");

      await Sentry.startSpan(
        {
          name: "worker.workspace_setup",
          op: "worker.setup",
          attributes: {
            "user.id": this.config.userId,
            "session.key": this.config.sessionKey,
          },
        },
        async () => {
          await this.workspaceManager.setupWorkspace(
            this.config.userId,
            this.config.sessionKey
          );

          const { initModuleWorkspace } = await import("../modules/lifecycle");
          await initModuleWorkspace({
            workspaceDir: this.workspaceManager.getCurrentWorkingDirectory(),
            username: this.config.userId,
            sessionKey: this.config.sessionKey,
          });
        }
      );

      // Setup I/O directories for file handling
      await this.setupIODirectories();

      // Download input files if any
      await this.downloadInputFiles();

      // Generate custom instructions
      let customInstructions = await generateCustomInstructions(
        [
          new OpenClawCoreInstructionProvider(),
          new OpenClawPromptIntentInstructionProvider(),
          new ProjectsInstructionProvider(),
        ],
        {
          userId: this.config.userId,
          agentId: this.config.agentId,
          sessionKey: this.config.sessionKey,
          workingDirectory: this.workspaceManager.getCurrentWorkingDirectory(),
          userPrompt,
          availableProjects: listAppDirectories(
            this.workspaceManager.getCurrentWorkingDirectory()
          ),
        }
      );

      // Call module onSessionStart hooks to allow modules to modify system prompt
      try {
        const { onSessionStart } = await import("../modules/lifecycle");
        const moduleContext = await onSessionStart({
          platform: this.config.platform,
          channelId: this.config.channelId,
          userId: this.config.userId,
          conversationId: this.config.conversationId,
          messageId: this.config.responseId,
          workingDirectory: this.workspaceManager.getCurrentWorkingDirectory(),
          customInstructions,
        });
        if (moduleContext.customInstructions) {
          customInstructions = moduleContext.customInstructions;
        }
      } catch (error) {
        logger.error("Failed to call onSessionStart hooks:", error);
      }

      // Add file I/O instructions AFTER module hooks so they aren't overwritten
      customInstructions += this.getFileIOInstructions();

      // Execute AI session
      logger.info(
        `[TIMING] Starting OpenClaw session at: ${new Date().toISOString()}`
      );
      const aiStartTime = Date.now();
      logger.info(
        `[TIMING] Total worker startup time: ${aiStartTime - executeStartTime}ms`
      );

      if (isLikelyImageGenerationRequest(userPrompt)) {
        logger.info("Direct image-generation shortcut triggered");
        const gatewayUrl = process.env.DISPATCHER_URL;
        const workerToken = process.env.WORKER_TOKEN;
        if (!gatewayUrl || !workerToken) {
          throw new Error(
            "DISPATCHER_URL and WORKER_TOKEN are required for image generation"
          );
        }

        const gatewayParams: GatewayParams = {
          gatewayUrl,
          workerToken,
          channelId: this.config.channelId,
          conversationId: this.config.conversationId,
          platform: this.config.platform,
        };
        const toolResult = await generateImage(gatewayParams, {
          prompt: userPrompt,
        });
        const toolText =
          extractToolTextContent(toolResult) || "Image request processed.";
        await this.workerTransport.sendStreamDelta(toolText, false, true);
        await this.workerTransport.signalDone();
        logger.info("Direct image-generation shortcut completed");
        return;
      }

      let firstOutputLogged = false;

      let sawUploadedFileEvent = false;

      const result = await Sentry.startSpan(
        {
          name: "worker.openclaw_execution",
          op: "ai.inference",
          attributes: {
            "user.id": this.config.userId,
            "session.key": this.config.sessionKey,
            "conversation.id": this.config.conversationId,
            agent: "OpenClaw",
          },
        },
        async () => {
          return await this.runAISession(
            userPrompt,
            customInstructions,
            async (update) => {
              if (!firstOutputLogged && update.type === "output") {
                logger.info(
                  `[TIMING] First OpenClaw output at: ${new Date().toISOString()} (${Date.now() - aiStartTime}ms after start)`
                );
                firstOutputLogged = true;
              }

              if (update.type === "output" && update.data) {
                const delta =
                  typeof update.data === "string" ? update.data : null;
                if (delta) {
                  await this.workerTransport.sendStreamDelta(delta, false);
                }
              } else if (update.type === "status_update") {
                await this.workerTransport.sendStatusUpdate(
                  update.data.elapsedSeconds,
                  update.data.state
                );
              } else if (update.type === "custom_event") {
                if (update.data.name === "file-uploaded") {
                  sawUploadedFileEvent = true;
                }
                await this.workerTransport.sendCustomEvent(
                  update.data.name,
                  update.data.payload
                );
              }
            }
          );
        }
      );

      // Collect module data before sending final response
      const { collectModuleData } = await import("../modules/lifecycle");
      const moduleData = await collectModuleData({
        workspaceDir: this.workspaceManager.getCurrentWorkingDirectory(),
        userId: this.config.userId,
        conversationId: this.config.conversationId,
      });
      this.workerTransport.setModuleData(moduleData);

      // Handle result
      if (result.success) {
        const outputSnapshot = this.progressProcessor.getOutputSnapshot();
        const hintGatewayUrl = process.env.DISPATCHER_URL;
        const hintWorkerToken = process.env.WORKER_TOKEN;
        const audioPermissionHint =
          hintGatewayUrl && hintWorkerToken
            ? await this.maybeBuildAudioPermissionHintMessage(
                outputSnapshot,
                hintGatewayUrl,
                hintWorkerToken
              )
            : null;
        const finalResult = this.progressProcessor.getFinalResult();
        if (finalResult) {
          const leakCheck = checkSandboxLeak(
            finalResult.text,
            sawUploadedFileEvent
          );
          if (leakCheck.leaked) {
            logger.warn(
              "Detected unfulfilled file-delivery claim in final message; redacting link targets"
            );
          }
          const finalText = audioPermissionHint
            ? `${leakCheck.redactedText}\n\n${audioPermissionHint}`
            : leakCheck.redactedText;
          logger.info(
            `📤 Sending final result (${finalText.length} chars) with deduplication flag`
          );
          // When a leak was redacted, the already-streamed content contains the
          // pre-redaction URLs — a delta-append would leave them on the client.
          // Force a full replacement so the client discards the leaky prefix.
          await this.workerTransport.sendStreamDelta(
            finalText,
            leakCheck.leaked,
            finalResult.isFinal
          );
        } else if (audioPermissionHint) {
          logger.info("📤 Sending audio permission settings hint to user");
          await this.workerTransport.sendStreamDelta(
            `\n\n${audioPermissionHint}`,
            false
          );
        } else {
          logger.info(
            "Session completed successfully - all content already streamed"
          );
        }
        await this.workerTransport.signalDone();
      } else {
        const errorMsg = result.error || "Unknown error";
        const isTimeout = result.exitCode === 124;

        if (isTimeout) {
          logger.info(
            `Session timed out (exit code 124) - will be retried automatically, not showing error to user`
          );
          throw new Error("SESSION_TIMEOUT");
        } else {
          const isAuthError =
            /no.credentials.configured|no_credentials|invalid.*api.key|incorrect.*api.key|token.*expired/i.test(
              errorMsg
            );
          const userMessage = isAuthError
            ? "Your AI provider credentials are invalid or expired. End-user provider setup is not available in chat yet. Ask an admin to reconnect the base agent provider."
            : `❌ Session failed: ${errorMsg}`;
          await this.workerTransport.sendStreamDelta(userMessage, true, true);
          if (isAuthError) {
            await this.workerTransport.signalDone();
          } else {
            await this.workerTransport.signalError(new Error(errorMsg));
          }
        }
      }

      logger.info(
        `Worker completed with ${result.success ? "success" : "failure"}`
      );
    } catch (error) {
      await handleExecutionError(error, this.workerTransport);
    }
  }

  async cleanup(): Promise<void> {
    try {
      logger.info("Cleaning up worker resources...");
      logger.info("Worker cleanup completed");
    } catch (error) {
      logger.error("Error during cleanup:", error);
    }
  }

  getWorkerTransport(): WorkerTransport | null {
    return this.workerTransport;
  }

  private getWorkingDirectory(): string {
    return this.workspaceManager.getCurrentWorkingDirectory();
  }

  private async maybeRunPreCompactionMemoryFlush(params: {
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>;
    settingsManager: SettingsManager;
    memoryFlushConfig: ResolvedMemoryFlushConfig;
    incomingPromptText: string;
    incomingImageCount: number;
    runSilentPrompt: (prompt: string) => Promise<void>;
  }): Promise<void> {
    const {
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig,
      incomingPromptText,
      incomingImageCount,
      runSilentPrompt,
    } = params;

    if (!memoryFlushConfig.enabled) {
      return;
    }

    if (!settingsManager.getCompactionEnabled()) {
      return;
    }

    const contextUsage = session.getContextUsage();
    if (!contextUsage) {
      return;
    }

    const reserveTokens = settingsManager.getCompactionReserveTokens();
    const currentCompactionCount =
      countCompactionsOnCurrentBranch(sessionManager);
    const lastFlushedCompactionCount =
      readLastFlushedCompactionCount(sessionManager);

    if (lastFlushedCompactionCount === currentCompactionCount) {
      return;
    }

    const incomingPromptTokens = estimatePromptTokenCost(
      incomingPromptText,
      incomingImageCount
    );
    const thresholdTokens =
      contextUsage.contextWindow -
      reserveTokens -
      memoryFlushConfig.softThresholdTokens;
    const projectedContextTokens = contextUsage.tokens + incomingPromptTokens;

    if (projectedContextTokens < thresholdTokens) {
      return;
    }

    const flushPrompt = `${memoryFlushConfig.systemPrompt}\n\n${memoryFlushConfig.prompt}`;
    logger.info(
      `Running silent pre-compaction memory flush: projected=${projectedContextTokens}, threshold=${thresholdTokens}, compactionCount=${currentCompactionCount}`
    );

    try {
      await runSilentPrompt(flushPrompt);
      const lastAssistant = getLatestAssistantText(
        session.messages as unknown[]
      );
      const outcome: MemoryFlushStateData["outcome"] =
        lastAssistant?.normalizedNoReply === true ? "no_reply" : "stored";

      sessionManager.appendCustomEntry(MEMORY_FLUSH_STATE_CUSTOM_TYPE, {
        compactionCount: currentCompactionCount,
        outcome,
        timestamp: Date.now(),
      } satisfies MemoryFlushStateData);
    } catch (error) {
      logger.warn(
        `Silent pre-compaction memory flush failed, continuing main prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // AI session
  // ---------------------------------------------------------------------------

  private async runAISession(
    userPrompt: string,
    customInstructions: string,
    onProgress: (update: ProgressUpdate) => Promise<void>
  ): Promise<SessionExecutionResult> {
    let rawOptions: Record<string, unknown>;
    try {
      rawOptions = JSON.parse(this.config.agentOptions) as Record<
        string,
        unknown
      >;
    } catch (error) {
      logger.error(
        `Failed to parse agentOptions: ${error instanceof Error ? error.message : String(error)}`
      );
      rawOptions = {};
    }
    const verboseLogging = rawOptions.verboseLogging === true;
    const memoryFlushConfig = resolveMemoryFlushConfig(rawOptions);

    this.progressProcessor.setVerboseLogging(verboseLogging);

    // Resolve how MCP tools should be exposed to the agent. In embedded mode,
    // operators can swap the many first-class MCP tools for a small set of
    // per-server just-bash CLIs (keeps the tool list lean).
    const configuredMcpExposure = (
      rawOptions.toolsConfig as ToolsConfig | undefined
    )?.mcpExposure;
    const envMcpExposure = process.env.LOBU_MCP_EXPOSURE;
    const requestedMcpExposure: "tools" | "cli" =
      configuredMcpExposure === "cli" || envMcpExposure === "cli"
        ? "cli"
        : "tools";
    const isEmbedded = process.env.DEPLOYMENT_MODE === "embedded";
    if (requestedMcpExposure === "cli" && !isEmbedded) {
      logger.warn(
        "mcpExposure='cli' requested but DEPLOYMENT_MODE is not 'embedded' — falling back to 'tools'."
      );
    }
    const mcpExposure: "tools" | "cli" =
      requestedMcpExposure === "cli" && isEmbedded ? "cli" : "tools";

    // Fetch session context BEFORE model resolution so AGENT_DEFAULT_PROVIDER
    // is available when resolveModelRef() needs a fallback provider. Pass
    // `mcpExposure` so MCP setup instructions use the right call syntax.
    const context = await getOpenClawSessionContext({ mcpExposure });

    // Sync enabled skills to workspace filesystem so the agent can `cat` them.
    // Remove stale skill directories to avoid serving removed/disabled skills.
    const skillsWorkspaceDir = this.getWorkingDirectory();
    const skillsRoot = path.join(skillsWorkspaceDir, ".skills");
    await fs.mkdir(skillsRoot, { recursive: true });

    const nextSkillNames = new Set(
      context.skillsConfig
        .map((skill) => path.basename((skill.name || "").trim()))
        .filter(Boolean)
    );

    const existingSkillEntries = await fs
      .readdir(skillsRoot, { withFileTypes: true })
      .catch(() => []);

    for (const entry of existingSkillEntries) {
      if (!entry.isDirectory()) continue;
      if (!nextSkillNames.has(entry.name)) {
        await fs.rm(path.join(skillsRoot, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }

    for (const skill of context.skillsConfig) {
      const skillName = path.basename((skill.name || "").trim());
      if (!skillName) continue;
      if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
        logger.warn(`Skipping skill with invalid name: ${skillName}`);
        continue;
      }
      const skillDir = path.join(skillsRoot, skillName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        skill.content,
        "utf-8"
      );
    }

    logger.info(
      `Synced ${context.skillsConfig.length} skill(s) to .skills/ directory`
    );

    // Store credentials in a local map instead of mutating process.env
    // to prevent leaking secrets between sessions via persistent env vars.
    const credentialStore = new Map<string, string>();

    const pc = context.providerConfig;
    if (pc.credentialEnvVarName) {
      credentialStore.set("CREDENTIAL_ENV_VAR_NAME", pc.credentialEnvVarName);
    }
    if (pc.providerBaseUrlMappings) {
      for (const [envVar, url] of Object.entries(pc.providerBaseUrlMappings)) {
        credentialStore.set(envVar, url);
      }
    }
    if (pc.credentialPlaceholders) {
      for (const [envVar, placeholder] of Object.entries(
        pc.credentialPlaceholders
      )) {
        credentialStore.set(envVar, placeholder);
      }
    }

    // Register config-driven providers so resolveModelRef() can handle them
    if (pc.configProviders) {
      for (const [id, meta] of Object.entries(pc.configProviders)) {
        registerDynamicProvider(id, meta);
      }
    }

    const modelRef =
      typeof rawOptions.model === "string" ? rawOptions.model : "";

    const { provider: rawProvider, modelId } = resolveModelRef(modelRef, {
      defaultModel: pc.defaultModel,
      defaultProvider: pc.defaultProvider,
    });
    // Map gateway slug to model-registry provider name (e.g. "z-ai" → "zai")
    const provider = PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;

    // Dynamic provider base URL from agentOptions.providerBaseUrlMappings
    let providerBaseUrl: string | undefined;
    const dynamicMappings = rawOptions.providerBaseUrlMappings as
      | Record<string, string>
      | undefined;
    if (dynamicMappings && typeof dynamicMappings === "object") {
      const fallbackEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
      if (fallbackEnvVar && dynamicMappings[fallbackEnvVar]) {
        providerBaseUrl = dynamicMappings[fallbackEnvVar];
      }
      for (const [envVar, url] of Object.entries(dynamicMappings)) {
        if (!credentialStore.has(envVar)) {
          credentialStore.set(envVar, url);
        }
      }
    }
    if (!providerBaseUrl) {
      providerBaseUrl =
        typeof rawOptions.providerBaseUrl === "string"
          ? rawOptions.providerBaseUrl.trim() || undefined
          : undefined;
    }
    if (!providerBaseUrl) {
      const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
      if (baseUrlEnvVar) {
        const baseUrlValue =
          credentialStore.get(baseUrlEnvVar) || process.env[baseUrlEnvVar];
        if (baseUrlValue) {
          providerBaseUrl = baseUrlValue;
        }
      }
    }

    let baseModel = getModel(provider as any, modelId as any) as any;
    if (!baseModel) {
      // For OpenAI-compatible providers (e.g. nvidia, together-ai), create a
      // dynamic model entry since these models aren't in the static registry.
      const registryProvider =
        PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
      if (registryProvider === "openai" || rawProvider !== provider) {
        logger.info(
          `Creating dynamic model entry for ${rawProvider}/${modelId} (openai-compatible)`
        );
        baseModel = {
          id: modelId,
          name: modelId,
          api: "openai-completions",
          provider: registryProvider,
          baseUrl: providerBaseUrl || "https://api.openai.com/v1",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        };
      } else {
        throw new Error(
          `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
        );
      }
    }
    const model = providerBaseUrl
      ? { ...baseModel, baseUrl: providerBaseUrl }
      : baseModel;

    const workspaceDir = this.getWorkingDirectory();
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });

    const sessionFile = path.join(workspaceDir, ".openclaw", "session.jsonl");
    const providerStateFile = path.join(
      workspaceDir,
      ".openclaw",
      "provider.json"
    );

    // Detect provider change and reset session if needed
    let sessionSummary: string | undefined;
    try {
      const raw = await fs.readFile(providerStateFile, "utf-8");
      const prevState = JSON.parse(raw) as {
        provider: string;
        modelId: string;
      };
      if (prevState.provider && prevState.provider !== provider) {
        logger.info(
          `Provider changed from ${prevState.provider} to ${provider}, resetting session`
        );

        // Read old session content for summary context
        try {
          const sessionContent = await fs.readFile(sessionFile, "utf-8");
          const lineCount = sessionContent.split("\n").filter(Boolean).length;
          if (lineCount > 0) {
            // Provide a brief context note instead of a full summary
            // to avoid an expensive API call to the new model
            sessionSummary = `[System note: The AI provider was just changed from ${prevState.provider} to ${provider}. Previous conversation history (${lineCount} turns) has been cleared. Continue helping the user from this point forward.]`;
          }
        } catch {
          // No existing session file
        }

        // Delete old session file to start fresh
        try {
          await fs.unlink(sessionFile);
        } catch {
          // File may not exist
        }
      }
    } catch (error) {
      // Log a warning for parse failures (vs. missing file which is expected on first run)
      const isFileNotFound =
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isFileNotFound) {
        logger.warn(
          `Failed to read provider state file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Persist current provider state
    await fs.writeFile(
      providerStateFile,
      JSON.stringify({ provider, modelId }),
      "utf-8"
    );

    const sessionManager = await openOrCreateSessionManager(
      sessionFile,
      workspaceDir
    );
    const settingsManager = SettingsManager.inMemory();

    const toolsPolicy = buildToolPolicy({
      toolsConfig: rawOptions.toolsConfig as ToolsConfig | undefined,
      allowedTools: rawOptions.allowedTools as string | string[] | undefined,
      disallowedTools: rawOptions.disallowedTools as
        | string
        | string[]
        | undefined,
    });

    // Build a mutable snapshot of MCP runtime state. The embedded CLI handlers
    // read through `mcpRuntimeRef.current` so that `auth check` / `logout` can
    // swap in refreshed tools/state without rebuilding Bash. `refresh()` re-
    // fetches session context — `checkMcpLogin`/`logoutMcp` already invalidate
    // the gateway cache, so the next fetch reaches the gateway.
    const mcpRuntimeRef = {
      current: {
        mcpTools: context.mcpTools,
        mcpStatus: context.mcpStatus,
        mcpContext: context.mcpContext,
      },
      ...(mcpExposure === "cli" && {
        refresh: async () => {
          try {
            const fresh = await getOpenClawSessionContext({ mcpExposure });
            return {
              mcpTools: fresh.mcpTools,
              mcpStatus: fresh.mcpStatus,
              mcpContext: fresh.mcpContext,
            };
          } catch (err) {
            logger.warn(
              `Failed to refresh MCP session context after auth: ${err instanceof Error ? err.message : String(err)}`
            );
            return null;
          }
        },
      }),
    };

    const gwParams: GatewayParams = {
      gatewayUrl: process.env.DISPATCHER_URL ?? "",
      workerToken: process.env.WORKER_TOKEN ?? "",
      channelId: this.config.channelId,
      conversationId: this.config.conversationId,
      platform: this.config.platform,
    };

    let embeddedBashOps:
      | import("@mariozechner/pi-coding-agent").BashOperations
      | undefined;
    if (isEmbedded) {
      const { createEmbeddedBashOps } = await import(
        "../embedded/just-bash-bootstrap"
      );
      embeddedBashOps = await createEmbeddedBashOps({
        mcpRuntimeRef,
        gw: gwParams,
        mcpExposure,
      });
    }
    let tools = createOpenClawTools(workspaceDir, {
      bashOperations: embeddedBashOps,
    }).filter((tool) => isToolAllowedByPolicy(tool.name, toolsPolicy));

    if (
      toolsPolicy.bashPolicy.allowPrefixes.length > 0 ||
      toolsPolicy.bashPolicy.denyPrefixes.length > 0
    ) {
      tools = tools.map((tool) => {
        if (tool.name !== "bash") {
          return tool;
        }
        return {
          ...tool,
          execute: async (toolCallId, params, signal, onUpdate) => {
            const command =
              params && typeof params === "object" && "command" in params
                ? String((params as { command?: unknown }).command ?? "")
                : "";
            enforceBashCommandPolicy(command, toolsPolicy.bashPolicy);
            return tool.execute(toolCallId, params as any, signal, onUpdate);
          },
        };
      });
    }

    const gatewayUrl = process.env.DISPATCHER_URL ?? "";
    const workerToken = process.env.WORKER_TOKEN ?? "";

    // Credential injection — resolve API key from the in-memory credential store,
    // falling back to process.env only for values that were present at startup.
    const authStorage = new AuthStorage();
    const credEnvVar = credentialStore.get("CREDENTIAL_ENV_VAR_NAME") || null;
    const credValue = credEnvVar
      ? credentialStore.get(credEnvVar) || process.env[credEnvVar]
      : null;
    if (credEnvVar && credValue) {
      authStorage.setRuntimeApiKey(provider, credValue);
      logger.info(`Set runtime API key for ${provider}`);
    } else {
      // Look up the env var by the canonical gateway slug (e.g. "z-ai" → Z_AI_API_KEY),
      // not the model-registry alias (e.g. "zai" → ZAI_API_KEY which nobody sets).
      const fallbackEnvVar = getApiKeyEnvVarForProvider(rawProvider);
      const fallbackValue =
        credentialStore.get(fallbackEnvVar) || process.env[fallbackEnvVar];
      if (fallbackValue) {
        authStorage.setRuntimeApiKey(provider, fallbackValue);
        logger.info(`Set runtime API key for ${provider}`);
      }
    }

    // Re-resolve provider base URL after session context may have updated mappings
    if (!providerBaseUrl) {
      const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
      if (baseUrlEnvVar) {
        const baseUrlValue =
          credentialStore.get(baseUrlEnvVar) || process.env[baseUrlEnvVar];
        if (baseUrlValue) {
          providerBaseUrl = baseUrlValue;
        }
      }
    }

    // Merge gateway instructions into custom instructions
    const instructionParts = [context.gatewayInstructions, customInstructions];

    // Prefer CLI backends from dynamic session context, fall back to env var
    let cliBackendsFromEnv:
      | Array<{ name: string; command: string; args?: string[] }>
      | undefined;
    if (!pc.cliBackends?.length && process.env.CLI_BACKENDS) {
      try {
        cliBackendsFromEnv = JSON.parse(process.env.CLI_BACKENDS) as Array<{
          name: string;
          command: string;
          args?: string[];
        }>;
      } catch (error) {
        logger.error(
          `Failed to parse CLI_BACKENDS env var: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const cliBackends = pc.cliBackends?.length
      ? pc.cliBackends
      : cliBackendsFromEnv;
    if (cliBackends?.length) {
      const agentList = cliBackends
        .map((b) => {
          const cmd = `${b.command} ${(b.args || []).join(" ")}`;
          const aliases = [b.name, (b as any).providerId].filter(
            (v, i, a) => v && a.indexOf(v) === i
          );
          return `### ${aliases.join(" / ")}
Run via Bash exactly as shown (do NOT modify the command):
\`\`\`bash
${cmd} "YOUR_PROMPT_HERE"
\`\`\``;
        })
        .join("\n\n");
      instructionParts.push(
        `## Available Coding Agents

You have access to the following AI coding agents. When the user mentions any of these by name (e.g. "use claude", "ask chatgpt"), you MUST run the exact command shown below via the Bash tool. Do NOT attempt to install or locate the CLI yourself — the command handles everything.

${agentList}

Replace "YOUR_PROMPT_HERE" with the user's request. These agents can read/write files, install packages, and run commands in the working directory.`
      );
    }

    instructionParts.push(`## Conversation History

You have access to GetChannelHistory to view previous messages in this thread.
Use it when the user references past discussions or you need context.`);

    const customTools = createOpenClawCustomTools({
      ...gwParams,
      onCustomEvent: async (name, data) => {
        await onProgress({
          type: "custom_event",
          data: { name, payload: data },
          timestamp: Date.now(),
        });
      },
    });

    // Register first-class MCP tools + auth tools. Skipped entirely in CLI
    // mode — MCP tools are instead reachable via the per-server just-bash CLI
    // wired in above, and `<server> auth login|check|logout` supersedes the
    // `<id>_login` / `<id>_login_check` / `<id>_logout` trio.
    if (mcpExposure === "cli") {
      logger.info(
        "mcpExposure='cli' — skipping first-class MCP tool registration (tools reachable via <server> <tool> in Bash)."
      );
    } else {
      const mcpToolDefs = createMcpToolDefinitions(
        context.mcpTools,
        gwParams,
        context.mcpContext
      );
      if (mcpToolDefs.length > 0) {
        customTools.push(...mcpToolDefs);
        logger.info(
          `Registered ${mcpToolDefs.length} MCP tool(s): ${mcpToolDefs.map((t) => t.name).join(", ")}`
        );
      }
    }

    // Load OpenClaw plugins
    const pluginsConfig = rawOptions.pluginsConfig as PluginsConfig | undefined;
    const loadedPlugins = await loadPlugins(pluginsConfig, workspaceDir);
    const pluginTools = loadedPlugins.flatMap((p) => p.tools);

    if (pluginTools.length > 0) {
      customTools.push(...pluginTools);
      logger.info(
        `Loaded ${pluginTools.length} tool(s) from ${loadedPlugins.length} plugin(s)`
      );
    }

    if (mcpExposure !== "cli") {
      const authToolDefs = createMcpAuthToolDefinitions(
        context.mcpStatus,
        gwParams,
        new Set(customTools.map((tool) => tool.name))
      );
      if (authToolDefs.length > 0) {
        customTools.push(...authToolDefs);
        logger.info(
          `Registered ${authToolDefs.length} MCP auth tool(s): ${authToolDefs.map((t) => t.name).join(", ")}`
        );
      }
    }

    // Apply plugin provider registrations to ModelRegistry
    const modelRegistry = new ModelRegistry(authStorage);
    const allProviders = loadedPlugins.flatMap((p) => p.providers);
    for (const reg of allProviders) {
      try {
        modelRegistry.registerProvider(reg.name, reg.config as any);
        logger.info(`Registered provider "${reg.name}" from plugin`);
      } catch (err) {
        logger.error(
          `Failed to register provider "${reg.name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    await startPluginServices(loadedPlugins);

    // Proactive owletto login: call owletto_login to check auth status.
    // If not authenticated, inject the login link into instructions so the model
    // can relay it to the user without needing to call tools itself.
    {
      const loginTool = pluginTools.find((t) => t.name === "owletto_login");
      if (loginTool) {
        logger.info("Checking Owletto auth status via proactive login");
        try {
          const loginResult = await loginTool.execute(
            "proactive-login",
            {},
            undefined,
            undefined,
            undefined as any
          );
          const resultText =
            loginResult?.content
              ?.filter(
                (
                  c
                ): c is {
                  type: "text";
                  text: string;
                } => c.type === "text" && typeof c.text === "string"
              )
              .map((c) => c.text)
              .join("\n") || "";
          logger.info(`Owletto login result: ${resultText.slice(0, 200)}`);
          const parsed = JSON.parse(resultText);
          if (parsed.status === "login_started" && parsed.verification_url) {
            // Send login link directly to the user — don't rely on the model
            const loginMessage = `🔑 Memory requires login. Open this link to connect:\n${parsed.verification_url}${parsed.user_code ? `\nCode: ${parsed.user_code}` : ""}\n\n`;
            await onProgress({
              type: "output",
              data: loginMessage,
              timestamp: Date.now(),
            });
            logger.info(
              "Proactive owletto login started — login link sent directly to user"
            );
            instructionParts.push(
              `\n\n## Owletto Login In Progress\nThe login link and code have already been sent directly to the user by the system. Do not repeat the verification URL or code unless the user explicitly asks. Do not call owletto_login again while authentication is pending. If the current request depends on Owletto, tell the user briefly to complete login and reply once done.`
            );
          } else if (parsed.status === "already_authenticated") {
            logger.info("Owletto already authenticated");
          } else if (parsed.status === "error") {
            logger.warn(`Owletto login returned error: ${parsed.message}`);
            instructionParts.push(
              `\n\n## Owletto Memory Not Connected\nOwletto memory is not connected and login could not be started automatically. Tell the user they need to connect their Owletto memory. If owletto_login tool is available, call it to try again. Otherwise tell them an admin or an existing auth flow is required.`
            );
          }
        } catch (err) {
          logger.warn(
            `Proactive owletto login failed: ${err instanceof Error ? err.message : String(err)}`
          );
          instructionParts.push(
            `\n\n## Owletto Memory Not Connected\nOwletto memory is not connected. Tell the user they need to connect their memory via Owletto. If the owletto_login tool is available, call it to start the login flow.`
          );
        }
      }
    }

    // Rebuild final instructions after possible login link injection
    const finalInstructionsUpdated = instructionParts
      .filter(Boolean)
      .join("\n\n");

    logger.info(
      `Starting OpenClaw session: provider=${provider}, model=${modelId}, tools=${tools.length}, customTools=${customTools.length}`
    );

    // Heartbeat timer to keep connection alive during long API calls
    const HEARTBEAT_INTERVAL_MS = 20000;
    let heartbeatTimer: Timer | null = null;
    let deltaTimer: Timer | null = null;
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>["session"]
      | null = null;
    const pluginHookContext: Record<string, unknown> = {
      cwd: workspaceDir,
      sessionKey: this.config.sessionKey,
      messageProvider: this.config.platform,
    };

    try {
      const createdSession = await createAgentSession({
        cwd: workspaceDir,
        model,
        tools,
        customTools,
        sessionManager,
        settingsManager,
        authStorage,
        modelRegistry,
      });
      session = createdSession.session;

      // Pi-coding-agent's base prompt opens with "You are an expert coding
      // assistant operating inside pi, a coding agent harness…" — that anchor
      // overrides any IDENTITY.md the agent ships with. Replace just that
      // opener with the agent's real identity (or the lobu default) so the
      // tools/guidelines/cwd footer below it still applies, but the role on
      // top is the one we actually want.
      const basePrompt = session.systemPrompt;
      const identity = context.agentInstructions?.trim();
      const finalSystemPrompt = identity
        ? [
            replaceBasePromptIdentity(basePrompt, identity),
            finalInstructionsUpdated,
          ]
            .filter(Boolean)
            .join("\n\n---\n\n")
        : [basePrompt, finalInstructionsUpdated]
            .filter(Boolean)
            .join("\n\n---\n\n");
      session.agent.setSystemPrompt(finalSystemPrompt);

      let resolveTurnDone: (() => void) | null = null;
      let turnNonce = 0;
      let suppressProgressOutput = false;

      // Wire events through progress processor with delta batching
      let pendingDelta = "";
      const DELTA_BATCH_INTERVAL_MS = 150;

      const flushDelta = async () => {
        if (pendingDelta) {
          const toSend = pendingDelta;
          pendingDelta = "";
          await onProgress({
            type: "output",
            data: toSend,
            timestamp: Date.now(),
          });
        }
        if (deltaTimer) {
          clearTimeout(deltaTimer);
          deltaTimer = null;
        }
      };

      const scheduleDeltaFlush = () => {
        if (!deltaTimer) {
          deltaTimer = setTimeout(() => {
            flushDelta().catch((err) => {
              logger.error("Failed to flush delta:", err);
            });
          }, DELTA_BATCH_INTERVAL_MS);
        }
      };

      const runPromptTurn = async (
        promptText: string,
        options?: { images?: ImageContent[]; silent?: boolean }
      ): Promise<void> => {
        const currentSession = session;
        if (!currentSession) {
          throw new Error("OpenClaw session is not initialized");
        }

        turnNonce += 1;
        const currentTurnNonce = turnNonce;

        const turnDone = new Promise<void>((resolve) => {
          resolveTurnDone = () => {
            if (currentTurnNonce !== turnNonce) {
              return;
            }
            resolveTurnDone = null;
            resolve();
          };
        });

        suppressProgressOutput = options?.silent === true;

        try {
          if (options?.images) {
            await currentSession.prompt(promptText, { images: options.images });
          } else {
            await currentSession.prompt(promptText);
          }
          await turnDone;
        } finally {
          suppressProgressOutput = false;
          if (resolveTurnDone && currentTurnNonce === turnNonce) {
            resolveTurnDone = null;
          }
        }
      };

      session.subscribe((event) => {
        if (suppressProgressOutput) {
          if (event.type === "agent_end") {
            resolveTurnDone?.();
          }
          return;
        }

        const hasUpdate = this.progressProcessor.processEvent(event);
        if (hasUpdate) {
          const delta = this.progressProcessor.getDelta();
          if (delta) {
            pendingDelta += delta;
            scheduleDeltaFlush();
          }
        }

        if (event.type === "agent_end") {
          flushDelta()
            .then(() => resolveTurnDone?.())
            .catch((err) => {
              logger.error("Failed to flush final delta:", err);
              resolveTurnDone?.();
            });
        }
      });

      let elapsedTime = 0;
      let lastHeartbeatTime = Date.now();
      const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
      let consecutiveHeartbeatFailures = 0;

      const sendHeartbeat = async () => {
        const now = Date.now();
        elapsedTime += now - lastHeartbeatTime;
        lastHeartbeatTime = now;
        const seconds = Math.floor(elapsedTime / 1000);

        logger.warn(
          `⏳ Still running after ${seconds}s - no response from API yet`
        );

        await onProgress({
          type: "status_update",
          data: {
            elapsedSeconds: seconds,
            state: "is running..",
          },
          timestamp: Date.now(),
        });
      };

      heartbeatTimer = setInterval(() => {
        sendHeartbeat()
          .then(() => {
            consecutiveHeartbeatFailures = 0;
          })
          .catch((err) => {
            consecutiveHeartbeatFailures += 1;
            logger.error(
              `Failed to send heartbeat (${consecutiveHeartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}):`,
              err
            );
            if (
              consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES
            ) {
              logger.error(
                "Gateway unresponsive after consecutive heartbeat failures, aborting session"
              );
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
              }
              if (session) {
                session.dispose();
              }
            }
          });
      }, HEARTBEAT_INTERVAL_MS);

      // Session reset: run unconditional memory flush, delete session file, and return early
      if ((this.config as any).platformMetadata?.sessionReset === true) {
        logger.info(
          "Session reset requested — running unconditional memory flush"
        );

        const flushPrompt = `${memoryFlushConfig.systemPrompt}\n\n${memoryFlushConfig.prompt}`;
        try {
          await runPromptTurn(flushPrompt, { silent: true });
          logger.info("Memory flush completed for session reset");
        } catch (error) {
          logger.warn(
            `Memory flush failed during session reset: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Delete session file so next run starts with a clean history
        try {
          await fs.unlink(sessionFile);
          logger.info("Deleted session file for session reset");
        } catch {
          // File may not exist
        }

        // Send visible confirmation to user
        await onProgress({
          type: "output",
          data: "Context saved. Starting fresh.",
          timestamp: Date.now(),
        });

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (deltaTimer) clearTimeout(deltaTimer);
        await stopPluginServices(loadedPlugins);

        return {
          success: true,
          exitCode: 0,
          output: "",
          sessionKey: this.config.sessionKey,
        };
      }

      // Consume any pending config change notifications from SSE events
      const { consumePendingConfigNotifications } = await import(
        "../gateway/sse-client"
      );
      const configNotifications = consumePendingConfigNotifications();

      let configNotice = "";
      if (configNotifications.length > 0) {
        const lines = configNotifications.map((n) => {
          let line = `- ${n.summary}`;
          if (n.details?.length) {
            line += `: ${n.details.join("; ")}`;
          }
          return line;
        });
        configNotice = `[System notice: Your configuration was updated since the last message]\n${lines.join("\n")}\n\n`;
      }

      const beforeAgentStartResults = await runPluginHooks({
        plugins: loadedPlugins,
        hook: "before_agent_start",
        event: {
          prompt: userPrompt,
          messages: session.messages as unknown as Record<string, unknown>[],
        },
        ctx: pluginHookContext,
      });
      const prependContexts = beforeAgentStartResults
        .flatMap((result) => {
          if (!result || typeof result !== "object") return [];
          const prepend = (result as Record<string, unknown>).prependContext;
          if (typeof prepend !== "string" || !prepend.trim()) return [];
          return [prepend.trim()];
        })
        .join("\n\n");

      const effectivePromptText = `${configNotice}${sessionSummary ? `${sessionSummary}\n\n` : ""}${prependContexts ? `${prependContexts}\n\n` : ""}${userPrompt}`;

      // Load image attachments for vision-capable models
      const images = await this.loadImageAttachments();
      if (images.length > 0) {
        logger.info(`Including ${images.length} image(s) in prompt for vision`);
      }

      await this.maybeRunPreCompactionMemoryFlush({
        session,
        sessionManager,
        settingsManager,
        memoryFlushConfig,
        incomingPromptText: effectivePromptText,
        incomingImageCount: images.length,
        runSilentPrompt: async (prompt) => {
          await runPromptTurn(prompt, { silent: true });
        },
      });

      await runPromptTurn(effectivePromptText, { images });

      const sessionError = this.progressProcessor.consumeFatalErrorMessage();
      if (sessionError) {
        await runPluginHooks({
          plugins: loadedPlugins,
          hook: "agent_end",
          event: {
            success: false,
            error: sessionError,
            messages: session.messages as unknown as Record<string, unknown>[],
          },
          ctx: pluginHookContext,
        });
        const errorWithHint = await this.maybeBuildAuthHintMessage(
          sessionError,
          rawProvider,
          modelId,
          gatewayUrl,
          workerToken
        );
        return {
          success: false,
          exitCode: 1,
          output: "",
          error: errorWithHint,
          sessionKey: this.config.sessionKey,
        };
      }

      await runPluginHooks({
        plugins: loadedPlugins,
        hook: "agent_end",
        event: {
          success: true,
          messages: session.messages as unknown as Record<string, unknown>[],
        },
        ctx: pluginHookContext,
      });

      return {
        success: true,
        exitCode: 0,
        output: "",
        sessionKey: this.config.sessionKey,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (session) {
        await runPluginHooks({
          plugins: loadedPlugins,
          hook: "agent_end",
          event: {
            success: false,
            error: errorMsg,
            messages: session.messages as unknown as Record<string, unknown>[],
          },
          ctx: pluginHookContext,
        });
      }
      const errorWithHint = await this.maybeBuildAuthHintMessage(
        errorMsg,
        provider,
        modelId,
        gatewayUrl,
        workerToken
      );

      return {
        success: false,
        exitCode: 1,
        output: "",
        error: errorWithHint,
        sessionKey: this.config.sessionKey,
      };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        logger.debug("Heartbeat timer cleared");
      }
      if (deltaTimer) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
        logger.debug("Delta batch timer cleared");
      }
      if (session) {
        session.dispose();
        session = null;
      }
      await stopPluginServices(loadedPlugins);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async setupIODirectories(): Promise<void> {
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const inputDir = path.join(workspaceDir, "input");
    const outputDir = path.join(workspaceDir, "output");
    const tempDir = path.join(workspaceDir, "temp");

    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const files = await fs.readdir(outputDir);
      for (const file of files) {
        await fs.unlink(path.join(outputDir, file)).catch(() => {
          /* intentionally empty */
        });
      }
    } catch (error) {
      logger.debug("Could not clear output directory:", error);
    }

    logger.info("I/O directories setup completed");
  }

  private async downloadInputFiles(): Promise<void> {
    const files = this.uploadedFiles;
    if (files.length === 0) {
      return;
    }

    logger.info(`Downloading ${files.length} input files...`);
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const inputDir = path.join(workspaceDir, "input");

    for (const file of files) {
      try {
        if (!file.downloadUrl) {
          logger.warn(
            { fileName: file.name, fileId: file.id },
            "Inbound file has no downloadUrl; gateway must publish it as an artifact before forwarding"
          );
          continue;
        }
        logger.info(`Downloading file: ${file.name} (${file.id})`);

        // The gateway pre-publishes every inbound attachment as a signed,
        // time-limited artifact and embeds the URL in `downloadUrl`. We
        // fetch through the worker's egress proxy — no platform tokens or
        // worker JWT cross this boundary anymore.
        const response = await fetch(file.downloadUrl, {
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
          logger.error(
            `Failed to download file ${file.name}: ${response.statusText}`
          );
          continue;
        }

        // Sanitize file name to prevent path traversal
        const safeName = path.basename(file.name);
        if (!safeName || safeName === "." || safeName === "..") {
          logger.warn(`Skipping file with invalid name: ${file.name}`);
          continue;
        }
        if (safeName !== file.name) {
          logger.warn(
            `Sanitized file name from "${file.name}" to "${safeName}"`
          );
        }

        if (!response.body) {
          logger.error(`Response body is null for file ${safeName}`);
          continue;
        }

        const destPath = path.join(inputDir, safeName);
        const fileStream = Readable.fromWeb(response.body as any);
        const writeStream = (await import("node:fs")).createWriteStream(
          destPath
        );

        await pipeline(fileStream, writeStream);
        logger.info(`Downloaded: ${safeName} to input directory`);
      } catch (error) {
        logger.error(`Error downloading file ${file.name}:`, error);
      }
    }
  }

  private get uploadedFiles(): Array<{
    id: string;
    name: string;
    mimetype: string;
    downloadUrl?: string;
  }> {
    return (this.config as any).platformMetadata?.files || [];
  }

  private static isImage(mimetype?: string): boolean {
    return !!mimetype?.startsWith("image/");
  }

  private getFileIOInstructions(): string {
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const files = this.uploadedFiles;

    if (files.length === 0) {
      return `

## File Generation & Output

**When to Create Files:**
Create and show files for any output that helps answer the user's request by using \`UploadUserFile\` tool:
- **Charts & visualizations**: pie charts, bar graphs, plots, diagrams via \`matplotlib\`
- **Reports & documents**: analysis reports, summaries, PDFs
- **Data files**: CSV exports, JSON data, spreadsheets
- **Code files**: scripts, configurations, examples
- **Images**: generated images, processed photos, screenshots.
- If the user asked you to send, share, attach, upload, export, or make a file downloadable, this sequence is required: create the file, call \`UploadUserFile\`, then tell the user it was sent only if the tool succeeds.
- **Never** present \`sandbox:/\`, workspace paths, or local filesystem links as if they were real user-downloadable files.
- **Never** say a file was sent unless \`UploadUserFile\` actually succeeded.
`;
    }

    const fileListing = files
      .map(
        (f) =>
          `- \`${workspaceDir}/input/${f.name}\` (${f.mimetype || "unknown type"})`
      )
      .join("\n");

    const hasImages = files.some((f) => OpenClawWorker.isImage(f.mimetype));
    const hasNonImages = files.some((f) => !OpenClawWorker.isImage(f.mimetype));

    let hints = "";
    if (hasImages) {
      hints +=
        "\nImage files have been included directly in this message for visual analysis.";
    }
    if (hasNonImages) {
      hints +=
        "\nYou can read non-image files with standard commands like `cat`, `less`, or `head`.";
    }

    return `

## File Generation & Output

**When to Create Files:**
Create and show files for any output that helps answer the user's request by using \`UploadUserFile\` tool:
- **Charts & visualizations**: pie charts, bar graphs, plots, diagrams via \`matplotlib\`
- **Reports & documents**: analysis reports, summaries, PDFs
- **Data files**: CSV exports, JSON data, spreadsheets
- **Code files**: scripts, configurations, examples
- **Images**: generated images, processed photos, screenshots.
- If the user asked you to send, share, attach, upload, export, or make a file downloadable, this sequence is required: create the file, call \`UploadUserFile\`, then tell the user it was sent only if the tool succeeds.
- **Never** present \`sandbox:/\`, workspace paths, or local filesystem links as if they were real user-downloadable files.
- **Never** say a file was sent unless \`UploadUserFile\` actually succeeded.

### User-Uploaded Files
The user has uploaded ${files.length} file(s) for you to analyze:
${fileListing}

**Use these files to answer the user's request.**${hints}
`;
  }

  /** Max image size to embed in prompt (20 MB). Larger files are skipped. */
  private static readonly MAX_IMAGE_BYTES = 20 * 1024 * 1024;

  private async loadImageAttachments(): Promise<ImageContent[]> {
    const imageFiles = this.uploadedFiles.filter((f) =>
      OpenClawWorker.isImage(f.mimetype)
    );
    if (imageFiles.length === 0) return [];

    const inputDir = path.join(
      this.workspaceManager.getCurrentWorkingDirectory(),
      "input"
    );
    const results: ImageContent[] = [];

    for (const file of imageFiles) {
      try {
        // Sanitize file name to prevent path traversal
        const safeName = path.basename(file.name);
        if (!safeName || safeName === "." || safeName === "..") {
          logger.warn(`Skipping image with invalid name: ${file.name}`);
          continue;
        }
        if (safeName !== file.name) {
          logger.warn(
            `Sanitized image file name from "${file.name}" to "${safeName}"`
          );
        }
        const data = await fs.readFile(path.join(inputDir, safeName));
        if (data.length > OpenClawWorker.MAX_IMAGE_BYTES) {
          logger.warn(
            `Skipping image ${file.name}: ${Math.round(data.length / 1024 / 1024)}MB exceeds limit`
          );
          continue;
        }
        results.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: file.mimetype,
        });
        logger.info(
          `Loaded image: ${file.name} (${file.mimetype}, ${Math.round(data.length / 1024)}KB)`
        );
      } catch (error) {
        logger.warn(`Failed to load image ${file.name}:`, error);
      }
    }

    return results;
  }

  private async maybeBuildAuthHintMessage(
    errorMessage: string,
    provider: string,
    modelId: string,
    gatewayUrl: string,
    workerToken: string
  ): Promise<string> {
    void gatewayUrl;
    void workerToken;

    const authHint = getProviderAuthHintFromError(errorMessage, provider);
    if (!authHint) {
      return errorMessage;
    }

    return `To use ${modelId}, an admin needs to connect ${authHint.providerName} on the base agent. Ask an admin to configure ${authHint.providerName} and then try again.`;
  }

  private async maybeBuildAudioPermissionHintMessage(
    outputText: string,
    gatewayUrl: string,
    workerToken: string
  ): Promise<string | null> {
    const lower = outputText.toLowerCase();
    if (!lower.includes("api.model.audio.request")) {
      return null;
    }

    if (
      lower.includes("settings button has been sent") ||
      lower.includes("connect button has been sent") ||
      lower.includes("open settings") ||
      lower.includes("secure connect link")
    ) {
      return null;
    }

    try {
      const suggestions = await fetchAudioProviderSuggestions({
        gatewayUrl,
        workerToken,
      });
      const providerList =
        suggestions.providerDisplayList || "an audio-capable provider";

      return `Voice generation needs an audio-capable provider (${providerList}) connected on the base agent. Ask an admin to connect one of these providers, then try again.`;
    } catch (error) {
      logger.error("Failed to fetch audio provider suggestions", error);
      return null;
    }
  }
}
