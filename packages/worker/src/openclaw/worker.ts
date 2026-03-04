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
import {
  getApiKeyEnvVarForProvider,
  getProviderAuthHintFromError,
} from "../shared/provider-auth-hints";
import { createOpenClawCustomTools } from "./custom-tools";
import { OpenClawCoreInstructionProvider } from "./instructions";
import {
  DEFAULT_PROVIDER_BASE_URL_ENV,
  openOrCreateSessionManager,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "./model-resolver";
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
        new OpenClawCoreInstructionProvider(),
        {
          userId: this.config.userId,
          agentId: this.config.agentId,
          sessionKey: this.config.sessionKey,
          workingDirectory: this.workspaceManager.getCurrentWorkingDirectory(),
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

      let firstOutputLogged = false;

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
        const finalResult = this.progressProcessor.getFinalResult();
        if (finalResult) {
          logger.info(
            `📤 Sending final result (${finalResult.text.length} chars) with deduplication flag`
          );
          await this.workerTransport.sendStreamDelta(
            finalResult.text,
            false,
            finalResult.isFinal
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
          await this.workerTransport.sendStreamDelta(
            `❌ Session failed: ${errorMsg}`,
            true,
            true
          );
          await this.workerTransport.signalError(new Error(errorMsg));
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

  // ---------------------------------------------------------------------------
  // AI session
  // ---------------------------------------------------------------------------

  private async runAISession(
    userPrompt: string,
    customInstructions: string,
    onProgress: (update: ProgressUpdate) => Promise<void>
  ): Promise<SessionExecutionResult> {
    const rawOptions = JSON.parse(this.config.agentOptions) as Record<
      string,
      unknown
    >;
    const verboseLogging = rawOptions.verboseLogging === true;

    this.progressProcessor.setVerboseLogging(verboseLogging);

    // Fetch session context BEFORE model resolution so AGENT_DEFAULT_PROVIDER
    // is available when resolveModelRef() needs a fallback provider.
    const context = await getOpenClawSessionContext();
    const pc = context.providerConfig;
    if (pc.credentialEnvVarName) {
      process.env.CREDENTIAL_ENV_VAR_NAME = pc.credentialEnvVarName;
    }
    if (pc.defaultProvider) {
      process.env.AGENT_DEFAULT_PROVIDER = pc.defaultProvider;
    }
    if (pc.defaultModel) {
      process.env.AGENT_DEFAULT_MODEL = pc.defaultModel;
    }
    if (pc.providerBaseUrlMappings) {
      for (const [envVar, url] of Object.entries(pc.providerBaseUrlMappings)) {
        process.env[envVar] = url;
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

    const { provider: rawProvider, modelId } = resolveModelRef(modelRef);
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
        if (!process.env[envVar]) {
          process.env[envVar] = url;
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
      if (baseUrlEnvVar && process.env[baseUrlEnvVar]) {
        providerBaseUrl = process.env[baseUrlEnvVar];
      }
    }

    const baseModel = getModel(provider as any, modelId as any) as any;
    if (!baseModel) {
      throw new Error(
        `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
      );
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
    } catch {
      // No previous provider state file - first run
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

    // Credential injection — must happen AFTER session context applies
    // CREDENTIAL_ENV_VAR_NAME to process.env (above).
    const authStorage = new AuthStorage();
    const credEnvVar = process.env.CREDENTIAL_ENV_VAR_NAME || null;
    if (credEnvVar && process.env[credEnvVar]) {
      authStorage.setRuntimeApiKey(provider, process.env[credEnvVar]!);
      logger.info(`Set runtime API key for ${provider} from ${credEnvVar}`);
    } else {
      const fallbackEnvVar = getApiKeyEnvVarForProvider(provider);
      if (process.env[fallbackEnvVar]) {
        authStorage.setRuntimeApiKey(provider, process.env[fallbackEnvVar]!);
        logger.info(
          `Set runtime API key for ${provider} from fallback ${fallbackEnvVar}`
        );
      }
    }

    // Re-resolve provider base URL after session context may have updated mappings
    if (!providerBaseUrl) {
      const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
      if (baseUrlEnvVar && process.env[baseUrlEnvVar]) {
        providerBaseUrl = process.env[baseUrlEnvVar];
      }
    }

    // Merge gateway instructions into custom instructions
    const instructionParts = [context.gatewayInstructions, customInstructions];

    // Prefer CLI backends from dynamic session context, fall back to env var
    const cliBackends = pc.cliBackends?.length
      ? pc.cliBackends
      : process.env.CLI_BACKENDS
        ? (JSON.parse(process.env.CLI_BACKENDS) as Array<{
            name: string;
            command: string;
            args?: string[];
          }>)
        : undefined;
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

    const finalInstructions = instructionParts.filter(Boolean).join("\n\n");

    const customTools = createOpenClawCustomTools({
      gatewayUrl,
      workerToken,
      channelId: this.config.channelId,
      conversationId: this.config.conversationId,
      platform: this.config.platform,
    });

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

      const basePrompt = session.systemPrompt;
      session.agent.setSystemPrompt(`${basePrompt}\n\n${finalInstructions}`);

      let doneResolve: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        doneResolve = resolve;
      });

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

      heartbeatTimer = setInterval(() => {
        sendHeartbeat().catch((err) => {
          logger.error("Failed to send heartbeat:", err);
        });
      }, HEARTBEAT_INTERVAL_MS);

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
      await session.prompt(effectivePromptText, { images });
      await done;

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
    const dispatcherUrl = process.env.DISPATCHER_URL!;
    const workerToken = process.env.WORKER_TOKEN!;

    for (const file of files) {
      try {
        logger.info(`Downloading file: ${file.name} (${file.id})`);

        const response = await fetch(
          `${dispatcherUrl}/internal/files/download?fileId=${file.id}`,
          {
            headers: {
              Authorization: `Bearer ${workerToken}`,
            },
            signal: AbortSignal.timeout(60_000),
          }
        );

        if (!response.ok) {
          logger.error(
            `Failed to download file ${file.name}: ${response.statusText}`
          );
          continue;
        }

        const destPath = path.join(inputDir, file.name);
        const fileStream = Readable.fromWeb(response.body as any);
        const writeStream = (await import("node:fs")).createWriteStream(
          destPath
        );

        await pipeline(fileStream, writeStream);
        logger.info(`Downloaded: ${file.name} to input directory`);
      } catch (error) {
        logger.error(`Error downloading file ${file.name}:`, error);
      }
    }
  }

  private get uploadedFiles(): Array<{
    id: string;
    name: string;
    mimetype: string;
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
        const data = await fs.readFile(path.join(inputDir, file.name));
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
    const authHint = getProviderAuthHintFromError(errorMessage, provider);
    if (!authHint) {
      return errorMessage;
    }

    try {
      const resp = await fetch(`${gatewayUrl}/internal/settings-link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          reason: `Connect your ${authHint.providerName} account to use ${modelId} models`,
          prefillEnvVars: [authHint.envVar],
        }),
      });

      if (resp.ok) {
        const { url } = (await resp.json()) as { url: string };
        return `To use ${modelId}, you need to connect your ${authHint.providerName} account.\n\nOpen settings to add your API key: ${url}`;
      }
    } catch (linkError) {
      logger.error(
        "Failed to generate settings link for missing API key",
        linkError
      );
    }

    return errorMessage;
  }
}
