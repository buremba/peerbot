#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger, type PluginsConfig, type ToolsConfig } from "@lobu/core";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { InteractionClient } from "../common/interaction-client";
import { BaseWorker } from "../core/base-worker";
import type {
  ProgressUpdate,
  SessionExecutionResult,
  WorkerConfig,
} from "../core/types";
import { createOpenClawCustomTools } from "./custom-tools";
import { OpenClawCoreInstructionProvider } from "./instructions";
import { loadPlugins } from "./plugin-loader";
import { OpenClawProgressProcessor } from "./processor";
import { getOpenClawSessionContext } from "./session-context";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
} from "./tool-policy";
import { createOpenClawTools } from "./tools";

const logger = createLogger("openclaw-worker");

export class OpenClawWorker extends BaseWorker {
  private interactionClient?: InteractionClient;
  private progressProcessor: OpenClawProgressProcessor;

  constructor(config: WorkerConfig, interactionClient?: InteractionClient) {
    super(config);
    this.interactionClient = interactionClient;
    this.progressProcessor = new OpenClawProgressProcessor();
  }

  protected getAgentName(): string {
    return "OpenClaw";
  }

  protected getCoreInstructionProvider(): OpenClawCoreInstructionProvider {
    return new OpenClawCoreInstructionProvider();
  }

  protected async runAISession(
    userPrompt: string,
    customInstructions: string,
    onProgress: (update: ProgressUpdate) => Promise<void>
  ): Promise<SessionExecutionResult> {
    const rawOptions = JSON.parse(this.config.agentOptions) as Record<
      string,
      unknown
    >;
    const modelRef =
      typeof rawOptions.model === "string" ? rawOptions.model : "";
    const verboseLogging = rawOptions.verboseLogging === true;

    this.progressProcessor.setVerboseLogging(verboseLogging);

    const { provider, modelId } = resolveModelRef(modelRef);
    const baseUrlOverride = resolveAnthropicBaseUrl(rawOptions);

    ensureAnthropicApiKey();

    // Set up auth storage with runtime API key overrides
    const authStorage = new AuthStorage();
    if (process.env.OPENAI_API_KEY) {
      authStorage.setRuntimeApiKey("openai-codex", process.env.OPENAI_API_KEY);
    }

    const baseModel = getModel(provider as any, modelId as any) as any;
    const model =
      baseUrlOverride && provider.toLowerCase() === "anthropic"
        ? { ...baseModel, baseUrl: baseUrlOverride }
        : baseModel;

    const workspaceDir = this.getWorkingDirectory();
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
    const sessionFile = path.join(workspaceDir, ".openclaw", "session.jsonl");

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

    let tools = createOpenClawTools(workspaceDir).filter((tool) =>
      isToolAllowedByPolicy(tool.name, toolsPolicy)
    );

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

    // Fetch session context from gateway
    const context = await getOpenClawSessionContext();
    const unansweredInteractions = context.unansweredInteractions || [];

    logger.info(
      `Startup state: ${unansweredInteractions.length} unanswered interactions`
    );

    // Merge gateway instructions into custom instructions
    const instructionParts = [context.gatewayInstructions, customInstructions];

    instructionParts.push(`## Conversation History

You have access to GetChannelHistory to view previous messages in this thread.
Use it when the user references past discussions or you need context.`);

    // Add pending interaction notes
    if (unansweredInteractions.length > 0) {
      logger.info(
        `Found ${unansweredInteractions.length} unanswered interactions - adding context note`
      );
      const pendingNote = this.buildPendingInteractionNote(
        unansweredInteractions
      );
      instructionParts.push(pendingNote);
    }

    const finalInstructions = instructionParts.filter(Boolean).join("\n\n");

    const customTools = createOpenClawCustomTools({
      gatewayUrl,
      workerToken,
      channelId: this.config.channelId,
      conversationId: this.config.conversationId,
      interactionClient: this.interactionClient,
      platform: this.config.platform,
    });

    // Load OpenClaw plugins (tools are captured as raw ToolDefinition — no bridging)
    const pluginsConfig = rawOptions.pluginsConfig as PluginsConfig | undefined;
    const loadedPlugins = await loadPlugins(pluginsConfig);
    const pluginTools = loadedPlugins.flatMap((p) => p.tools);

    if (pluginTools.length > 0) {
      customTools.push(...pluginTools);
      logger.info(
        `Loaded ${pluginTools.length} tool(s) from ${loadedPlugins.length} plugin(s)`
      );
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

    logger.info(
      `Starting OpenClaw session: provider=${provider}, model=${modelId}, tools=${tools.length}, customTools=${customTools.length}`
    );

    const { session } = await createAgentSession({
      cwd: workspaceDir,
      model,
      tools,
      customTools,
      sessionManager,
      settingsManager,
      authStorage,
      modelRegistry,
    });

    // Note: Using default streamFn (not streamSimple) for compatibility
    // with third-party Anthropic-compatible API proxies

    const basePrompt = session.systemPrompt;
    session.agent.setSystemPrompt(`${basePrompt}\n\n${finalInstructions}`);

    let doneResolve: (() => void) | undefined;
    let doneReject: ((err: Error) => void) | undefined;
    const done = new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });

    // Wire events through progress processor with delta batching
    let pendingDelta = "";
    let deltaTimer: Timer | null = null;
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

    session.subscribe((event) => {
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
          .then(() => doneResolve?.())
          .catch((err) => {
            logger.error("Failed to flush final delta:", err);
            doneResolve?.();
          });
      }
    });

    // Heartbeat timer to keep connection alive during long API calls
    const HEARTBEAT_INTERVAL_MS = 20000;
    let heartbeatTimer: Timer | null = null;
    let elapsedTime = 0;
    let lastHeartbeatTime = Date.now();

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

    try {
      heartbeatTimer = setInterval(() => {
        sendHeartbeat().catch((err) => {
          logger.error("Failed to send heartbeat:", err);
        });
      }, HEARTBEAT_INTERVAL_MS);

      await session.prompt(userPrompt);
      await done;
      session.dispose();
      return {
        success: true,
        exitCode: 0,
        output: "",
        sessionKey: this.config.sessionKey,
      };
    } catch (error) {
      session.dispose();
      doneReject?.(error as Error);
      return {
        success: false,
        exitCode: 1,
        output: "",
        error: error instanceof Error ? error.message : String(error),
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
    }
  }

  protected async processProgressUpdate(
    update: ProgressUpdate
  ): Promise<string | null> {
    if (typeof update.data === "string") {
      return update.data;
    }
    return null;
  }

  protected getFinalResult(): { text: string; isFinal: boolean } | null {
    return this.progressProcessor.getFinalResult();
  }

  protected resetProgressState(): void {
    this.progressProcessor.reset();
  }

  protected async cleanupSession(_sessionKey: string): Promise<void> {
    logger.info("Cleanup for OpenClaw session (no-op)");
  }

  private buildPendingInteractionNote(
    unanswered: Array<{ type: string; question: string }>
  ): string {
    const notes = unanswered.map((i) => {
      switch (i.type) {
        case "plan_approval":
          return "Note: You previously asked the user to approve executing your plan, but they haven't responded yet. They've now sent a new message instead. You can ask them again if needed, or proceed based on their new request.";
        case "tool_approval":
          return "Note: You previously asked the user to approve a tool execution, but they haven't responded yet. They've sent a new message instead.";
        case "question":
        case "form":
          return `Note: You asked the user: "${i.question.substring(0, 100)}${i.question.length > 100 ? "..." : ""}", but they sent a new message instead of answering.`;
        default:
          return `Note: You have an unanswered interaction with the user.`;
      }
    });

    return `## Pending Interactions\n\n${notes.join("\n\n")}`;
  }
}

function resolveModelRef(rawModelRef: string): {
  provider: string;
  modelId: string;
} {
  const defaultModelRef =
    process.env.OPENCLAW_DEFAULT_MODEL || "anthropic/claude-opus-4-5";
  const defaultProvider = process.env.OPENCLAW_DEFAULT_PROVIDER || "anthropic";

  const normalizedRaw = rawModelRef?.trim();
  const modelRef = normalizedRaw || defaultModelRef;

  const stripped = modelRef.toLowerCase().startsWith("openclaw/")
    ? modelRef.slice("openclaw/".length)
    : modelRef;

  const parts = stripped.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const provider = parts[0] ?? defaultProvider;
    return { provider, modelId: parts.slice(1).join("/") };
  }

  return { provider: defaultProvider, modelId: stripped };
}

function resolveAnthropicBaseUrl(
  options: Record<string, unknown>
): string | undefined {
  const raw = options.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function ensureAnthropicApiKey(): void {
  // ANTHROPIC_AUTH_TOKEN is the explicit override set by the gateway for this worker.
  // It takes priority over ANTHROPIC_API_KEY which may be inherited from the shell
  // (e.g. a Claude Code OAuth token that isn't valid for third-party API proxies).
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
  }
}

async function openOrCreateSessionManager(
  sessionFile: string,
  workspaceDir: string
): Promise<SessionManager> {
  try {
    await fs.stat(sessionFile);
    return SessionManager.open(sessionFile);
  } catch {
    const sessionManager = SessionManager.create(
      workspaceDir,
      path.dirname(sessionFile)
    );
    sessionManager.setSessionFile(sessionFile);
    return sessionManager;
  }
}
