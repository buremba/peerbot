#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createLogger,
  getOptionalEnv,
  type PluginsConfig,
  type ToolsConfig,
  type WorkerTransport,
} from "@lobu/core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
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
import type { GatewayParams } from "../shared/tool-implementations";
import {
  createMcpAuthToolDefinitions,
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "./custom-tools";
import { TurnController, wrapToolsWithTurnGuard } from "./turn-controller";
import {
  OpenClawCoreInstructionProvider,
  OpenClawPromptIntentInstructionProvider,
} from "./instructions";
import {
  buildDynamicOpenAIModel,
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
  wrapToolsWithPluginToolHooks,
} from "./plugin-loader";
import { OpenClawProgressProcessor } from "./processor";
import { checkSandboxLeak } from "./sandbox-leak";
import { buildAgentSession } from "./session-builder";
import { getOpenClawSessionContext } from "./session-context";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
} from "./tool-policy";
import { buildToolUseEventPayload } from "./tool-use-events";
import { createOpenClawTools } from "./tools";
import {
  clearSnapshots,
  hydrateFromSnapshot,
  type TerminalStatus,
  writeSnapshot,
} from "./transcript-snapshot";

const logger = createLogger("worker");

const MEMORY_FLUSH_STATE_CUSTOM_TYPE = "lobu.memory_flush_state";
const APPROX_IMAGE_TOKENS = 1200;

const LOBU_MEMORY_PLUGIN_SOURCE = "@lobu/openclaw-plugin";

/**
 * Inject the bound agentId into the Lobu memory plugin's config so its
 * autoCapture path stamps `metadata.agent_id` on save_memory calls. Other
 * plugins are passed through unchanged. Returns a new PluginsConfig — does
 * not mutate input.
 */
function injectAgentIdIntoLobuPlugin(
  pluginsConfig: PluginsConfig | undefined,
  agentId: string | undefined
): PluginsConfig | undefined {
  if (!pluginsConfig?.plugins?.length || !agentId) return pluginsConfig;
  const plugins = pluginsConfig.plugins.map((plugin) => {
    if (plugin.source !== LOBU_MEMORY_PLUGIN_SOURCE) return plugin;
    return {
      ...plugin,
      config: {
        ...plugin.config,
        agentId,
      },
    };
  });
  return { ...pluginsConfig, plugins };
}

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

/**
 * Returns true iff the given URL points at OpenAI's real API host.
 * Uses URL parsing + exact host match so spoofed hosts like
 * `https://api.openai.com.evil.example/v1` are not mistaken for real OpenAI.
 */
function isRealOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
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
  /**
   * Terminal status for the current run, used by `cleanup()` to discriminate
   * the snapshot row. Defaults to `failed` (pessimistic) so an early crash
   * before any return-path assignment is recorded as a failure, not silently
   * accepted as a completion. Set to `completed` only on the success path
   * in `execute()`. Resets on every `execute()` invocation.
   */
  private terminalStatus: TerminalStatus = "failed";
  /**
   * Path to the OpenClaw session file for the current run. Captured in
   * `runAISession()` (where SessionManager opens it) so `cleanup()` can
   * read it back for the snapshot without re-deriving the path.
   */
  private sessionFilePath: string | null = null;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workspaceManager = new WorkspaceManager(config.workspace);
    this.progressProcessor = new OpenClawProgressProcessor();

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
    // Reset terminal status for this run. Defaults to `failed` (pessimistic);
    // assigned to `completed` only on the success path below. SESSION_TIMEOUT
    // throws and is reassigned in the catch block.
    this.terminalStatus = "failed";

    // Fail loud when snapshot mode is enabled but the per-run scope the
    // gateway is supposed to provide hasn't reached this job. A silent
    // skip in cleanup() would hide a configuration bug across many
    // turns; throwing here surfaces it on the first turn and the runs
    // queue's retry path handles re-delivery. Codex round 2 quality
    // win D on PR #865.
    //
    // Phase 5: snapshot is the default; setting LOBU_SESSION_STORE=file
    // opts out (legacy / local-dev path that keeps reading session.jsonl
    // straight off disk without writing to Postgres).
    if (process.env.LOBU_SESSION_STORE !== "file") {
      if (typeof this.config.runId !== "number") {
        throw new Error(
          "Snapshot mode (LOBU_SESSION_STORE != 'file') but WorkerConfig.runId is missing — runs-queue dispatch did not stamp runId on the job payload"
        );
      }
      if (!this.config.runJobToken) {
        throw new Error(
          "Snapshot mode (LOBU_SESSION_STORE != 'file') but WorkerConfig.runJobToken is missing — MessageConsumer did not mint a per-run worker token"
        );
      }
    }

    try {
      this.progressProcessor.reset();

      logger.info(
        `🚀 Starting OpenClaw worker for session: ${this.config.sessionKey}`
      );
      logger.info(
        `[TIMING] Worker execute() started at: ${new Date(executeStartTime).toISOString()}`
      );

      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString(
        "utf-8"
      );
      logger.info(`User prompt: ${userPrompt.substring(0, 100)}...`);

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
        }
      );

      await this.setupIODirectories();
      await this.downloadInputFiles();

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

      customInstructions += this.getFileIOInstructions();

      logger.info(
        `[TIMING] Starting OpenClaw session at: ${new Date().toISOString()}`
      );
      const aiStartTime = Date.now();
      logger.info(
        `[TIMING] Total worker startup time: ${aiStartTime - executeStartTime}ms`
      );

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

      if (result.success) {
        // Snapshot writer in cleanup() reads this to discriminate the row.
        // Hydrate skips non-completed snapshots, so getting this right is
        // what stops a failed turn from poisoning the next attempt.
        this.terminalStatus = "completed";
        await this.deliverFinalResult(sawUploadedFileEvent);
        await this.workerTransport.signalDone();
      } else {
        const errorMsg = result.error || "Unknown error";
        const isTimeout = result.exitCode === 124;

        if (isTimeout) {
          // Mark the snapshot as `timeout` instead of `failed` so operators
          // can distinguish runaway agents from genuine failures in the
          // dashboard. The catch block below sees `SESSION_TIMEOUT` and
          // keeps this assignment intact (it only forces `failed` on
          // exceptions that aren't already marked).
          this.terminalStatus = "timeout";
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

      if (result.success) {
        logger.info("Worker completed with success");
      } else {
        // Log the actual failure reason. Without this the run is marked
        // failed (and the reply silently dropped) with no clue why — the
        // `error`/`exitCode` came back from runAISession but were never
        // surfaced, making prod failures undiagnosable from logs alone.
        logger.error(
          { err: result.error, exitCode: result.exitCode },
          "Worker completed with failure"
        );
      }
    } catch (error) {
      await handleExecutionError(error, this.workerTransport);
    }
  }

  async cleanup(): Promise<void> {
    // Snapshot the post-run session.jsonl to Postgres so the next worker
    // (possibly on a different pod) can hydrate from it. Hydrate filters
    // `terminal_status='completed'`, so we ONLY POST on the success path
    // — writing `failed`/`timeout`/`cancelled` rows is pure network
    // waste (codex round 2 quality win C on PR #865). Default-on in
    // Phase 5; LOBU_SESSION_STORE=file opts out for legacy/local-dev.
    //
    // The runs queue has already moved this run to a terminal state by
    // the time cleanup() fires (sse-client.ts:865 finally block runs
    // after execute() returns). We POST in the worker's own dying
    // breath; the gateway-side advisory lock held by the spawner is
    // released when the subprocess exits, so by the next claim's boot
    // this snapshot is the visible "latest" row.
    if (
      process.env.LOBU_SESSION_STORE !== "file" &&
      this.sessionFilePath &&
      this.terminalStatus === "completed"
    ) {
      const gatewayUrl = process.env.DISPATCHER_URL;
      const runId = this.config.runId;
      // Per-run JWT minted by the gateway's MessageConsumer alongside
      // `runId`. The snapshot route requires `tokenData.runId ===
      // body.runId`, so the deployment-lifetime WORKER_TOKEN cannot be
      // used here — it would carry no `runId` and the route would 403.
      // Codex round 2 finding A.
      const runJobToken = this.config.runJobToken;
      if (gatewayUrl && runJobToken && typeof runId === "number") {
        await writeSnapshot({
          sessionFile: this.sessionFilePath,
          gatewayUrl,
          workerToken: runJobToken,
          terminalStatus: this.terminalStatus,
          runId,
        });
      } else if (gatewayUrl) {
        // Missing per-run scope (legacy direct-enqueue path or token
        // mint failure on the gateway). Skip the snapshot rather than
        // risk a mis-attributed row; the next run will hydrate from
        // the previous completed snapshot the next time a normal
        // runs-queue dispatch comes through.
        logger.warn(
          `Skipping transcript snapshot: ${
            typeof runId !== "number"
              ? "WorkerConfig.runId is missing"
              : "WorkerConfig.runJobToken is missing"
          } (legacy enqueue path)`
        );
      }
    }
    logger.info("Worker cleanup completed");
  }

  getWorkerTransport(): WorkerTransport | null {
    return this.workerTransport;
  }

  private async maybeRunPreCompactionMemoryFlush(params: {
    session: Awaited<ReturnType<typeof buildAgentSession>>["session"];
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
    const mcpExposure: "tools" | "cli" =
      configuredMcpExposure === "cli" || envMcpExposure === "cli"
        ? "cli"
        : "tools";

    // Fetch session context BEFORE model resolution so AGENT_DEFAULT_PROVIDER
    // is available when resolveModelRef() needs a fallback provider. Pass
    // `mcpExposure` so MCP setup instructions use the right call syntax.
    const context = await getOpenClawSessionContext({ mcpExposure });

    // Sync enabled skills to workspace filesystem so the agent can `cat` them.
    // Remove stale skill directories to avoid serving removed/disabled skills.
    const skillsWorkspaceDir =
      this.workspaceManager.getCurrentWorkingDirectory();
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
        const baseUrlValue = credentialStore.get(baseUrlEnvVar);
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
        // Throws if a non-OpenAI provider's base URL is unresolved, rather
        // than silently routing to OpenAI's public endpoint.
        baseModel = buildDynamicOpenAIModel({
          rawProvider,
          registryProvider,
          modelId,
          providerBaseUrl,
        });
      } else {
        throw new Error(
          `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
        );
      }
    }
    const resolvedModel = providerBaseUrl
      ? { ...baseModel, baseUrl: providerBaseUrl }
      : baseModel;

    // Defensive: any `openai-completions` model whose baseUrl is not real
    // OpenAI is a third-party compat endpoint (Gemini, Nvidia, Together, z.ai,
    // etc.). These reject unknown fields and 400 with "Unknown name 'store'"
    // if pi-ai sends `store: false`. Force it off regardless of whether the
    // model came from the static registry or the dynamic fallback above.
    //
    // Host comparison uses URL parsing (not `.startsWith`) so that a baseUrl
    // like `https://api.openai.com.evil.example/v1` doesn't get mistaken for
    // real OpenAI. Malformed URLs are treated as third-party (safer default).
    const isThirdPartyOpenAICompat =
      resolvedModel.api === "openai-completions" &&
      typeof resolvedModel.baseUrl === "string" &&
      !isRealOpenAIBaseUrl(resolvedModel.baseUrl);
    const model = isThirdPartyOpenAICompat
      ? {
          ...resolvedModel,
          compat: { ...(resolvedModel.compat ?? {}), supportsStore: false },
        }
      : resolvedModel;

    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });

    const sessionFile = path.join(workspaceDir, ".openclaw", "session.jsonl");
    // Capture for cleanup() — it reads the file back to write the snapshot
    // at terminal time. Set unconditionally so file-mode opt-outs
    // still get a defined value (snapshot writer no-ops when
    // LOBU_SESSION_STORE=file).
    this.sessionFilePath = sessionFile;
    const providerStateFile = path.join(
      workspaceDir,
      ".openclaw",
      "provider.json"
    );

    // Hydrate from the latest completed Postgres snapshot BEFORE the
    // provider-state check or SessionManager.open(). Phase 5: snapshot
    // mode is the default; LOBU_SESSION_STORE=file opts out and keeps
    // the legacy file-only behaviour for local-dev / single-replica
    // self-hosters.
    //
    // Order matters: hydrate → provider check (may unlink) →
    // SessionManager.open(). The provider-change unlink at line ~925 still
    // does the right thing after hydrate: it drops the file we just wrote
    // and SessionManager creates a fresh one, exactly like a first-turn
    // boot. The next snapshot will have its own run_id, so the historical
    // PG rows remain readable without poisoning the new conversation
    // (hydrate would only resurrect them if a subsequent run completes
    // successfully and overwrites the latest pointer).
    if (process.env.LOBU_SESSION_STORE !== "file") {
      const gatewayUrl = process.env.DISPATCHER_URL;
      const workerToken = process.env.WORKER_TOKEN;
      if (gatewayUrl && workerToken) {
        try {
          await hydrateFromSnapshot({
            sessionFile,
            gatewayUrl,
            workerToken,
          });
        } catch (err) {
          // Hydrate failure is non-fatal — fall back to whatever's on disk.
          // Worst case the worker boots without history and the user re-
          // grounds the conversation. Better than refusing to start.
          logger.warn(
            `Snapshot hydrate failed; continuing with local session file: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        logger.warn(
          "Snapshot mode active (LOBU_SESSION_STORE != 'file') but DISPATCHER_URL or WORKER_TOKEN missing; snapshot disabled"
        );
      }
    }

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
      gatewayUrl: getOptionalEnv("DISPATCHER_URL", ""),
      workerToken: getOptionalEnv("WORKER_TOKEN", ""),
      channelId: this.config.channelId,
      conversationId: this.config.conversationId,
      platform: this.config.platform,
      workspaceDir,
    };

    const { createEmbeddedBashOps } = await import(
      "../embedded/just-bash-bootstrap"
    );
    const embeddedBashOps: import("@mariozechner/pi-coding-agent").BashOperations =
      await createEmbeddedBashOps({
        workspaceDir,
        mcpRuntimeRef,
        gw: gwParams,
        mcpExposure,
      });
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
        const baseUrlValue = credentialStore.get(baseUrlEnvVar);
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

    // Owns the decision to force-end a turn so it never depends on the model
    // voluntarily stopping. AskUser calls `terminate("ask-user")` after posting
    // (via onAskUserPosted); the runaway guards (identical-tool loop + total
    // tool-call cap) trip inside the synchronous tool-execute wrapper applied
    // below. The abort function is attached once the session exists.
    const turnController = new TurnController({
      onTerminate: ({ message }) => {
        logger.warn(`Turn force-terminated: ${message}`);
      },
    });

    const customTools = createOpenClawCustomTools({
      ...gwParams,
      workspaceDir,
      onCustomEvent: async (name, data) => {
        await onProgress({
          type: "custom_event",
          data: { name, payload: data },
          timestamp: Date.now(),
        });
      },
      onAskUserPosted: () =>
        turnController.terminate(
          "ask-user",
          "AskUserQuestion posted — ending the turn so the model can't re-post."
        ),
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

    // Load OpenClaw plugins. Inject the worker's bound agentId into the Lobu
    // memory plugin's config so its autoCapture path can stamp
    // `metadata.agent_id` on every save_memory call — that's the
    // memory-scope axis search_memory's `agent_id` filter reads.
    const pluginsConfig = injectAgentIdIntoLobuPlugin(
      rawOptions.pluginsConfig as PluginsConfig | undefined,
      this.config.agentId
    );
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
      | Awaited<ReturnType<typeof buildAgentSession>>["session"]
      | null = null;
    const pluginHookContext: Record<string, unknown> = {
      cwd: workspaceDir,
      sessionKey: this.config.sessionKey,
      messageProvider: this.config.platform,
    };

    try {
      const createdSession = await buildAgentSession({
        cwd: workspaceDir,
        model,
        // pi's createAgentSession() uses `tools` only to derive active tool
        // names and rebuilds the base tools internally (bash via getShellEnv()
        // = {...process.env}, no env strip, no embedded BashOperations).
        // buildAgentSession() swaps those rebuilt built-ins back to these
        // Lobu instances after construction so the agent's bash actually runs
        // with the spawnHook that strips WORKER_TOKEN/DISPATCHER_URL and with
        // the embedded BashOperations + tool policy wired in above.
        // Wrap built-ins with the synchronous runaway guard so the per-turn
        // tool-call cap and identical-call guard bound bash/read/edit/write
        // too. The guard runs inside execute (before the tool body), so the
        // bound is tight — unlike the agent's async tool_execution_start event,
        // which lags several turns behind real execution.
        tools: wrapToolsWithTurnGuard(tools, turnController),
        // Wrap custom tools (plugin + MCP) so plugin before_tool_call/
        // after_tool_call hooks fire around in-process execution — these never
        // hit the gateway proxy, so this is the only place the hooks can run.
        // Then layer the runaway guard on top so AskUser/MCP/plugin tools are
        // bounded identically.
        customTools: wrapToolsWithTurnGuard(
          wrapToolsWithPluginToolHooks(
            customTools,
            loadedPlugins,
            pluginHookContext
          ),
          turnController
        ),
        sessionManager,
        settingsManager,
        authStorage,
        modelRegistry,
      });
      session = createdSession.session;

      // Wire the turn controller's abort to the live agent. `agent.abort()`
      // fires the shared AbortController: the in-flight/next LLM stream sees the
      // aborted signal and the loop emits `agent_end` with NO further model
      // iteration. Tool results recorded before the abort are already persisted
      // to the session, so the resume path (next inbound message → new turn) is
      // unaffected.
      turnController.attachAbort(() => {
        createdSession.session.agent.abort();
      });

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

        // Reset per-turn runaway guards so cap/identical-call tracking is scoped
        // to this turn only.
        turnController.startTurn();

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

      // Track tool-call input args across tool_execution_start → _end. pi-agent
      // only includes `args` on the start event; the end event carries
      // `toolCallId`, `toolName`, `result`, `isError`. The worker emits one
      // SSE `tool_use` per finished call, so it needs to remember the input.
      const pendingToolArgs = new Map<string, unknown>();
      // Tool-use SSE emits are awaited at agent_end so the `complete` event
      // can't race ahead of late tool_use events on slow networks.
      const inFlightToolUse: Set<Promise<void>> = new Set();

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

        // Capture the input args at tool start so we can attach them when the
        // matching end event fires. (The runaway guard runs synchronously in
        // the tool-execute wrapper, not here — this event stream lags several
        // turns behind real execution.)
        if (event.type === "tool_execution_start") {
          pendingToolArgs.set(event.toolCallId, event.args);
        }

        // Surface tool-use traces to SSE clients (promptfoo provider, CLI eval,
        // any client subscribed via `event: tool_use`). Worker emits one record
        // per tool call at `tool_execution_end` so the result is included.
        if (event.type === "tool_execution_end") {
          const args = pendingToolArgs.get(event.toolCallId);
          pendingToolArgs.delete(event.toolCallId);
          const payload = buildToolUseEventPayload({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args,
            result: event.result,
            isError: event.isError,
          });
          const promise = onProgress({
            type: "custom_event",
            data: {
              name: "tool_use",
              payload: payload as unknown as Record<string, unknown>,
            },
            timestamp: Date.now(),
          }).catch((err) => {
            logger.warn(
              `Failed to emit tool_use custom event for ${event.toolName}:`,
              err
            );
          });
          inFlightToolUse.add(promise);
          promise.finally(() => inFlightToolUse.delete(promise));
        }

        if (event.type === "agent_end") {
          flushDelta()
            .then(async () => {
              // Wait for any pending tool_use emits so clients don't see
              // `complete` arrive before all tool_use records (the provider
              // returns on `complete`, and a slow tool_use POST mid-flight
              // would otherwise be lost).
              if (inFlightToolUse.size > 0) {
                await Promise.allSettled(Array.from(inFlightToolUse));
              }
              resolveTurnDone?.();
            })
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
              // Unblock any in-flight prompt turn FIRST — disposing the session
              // without resolving `turnDone` leaves `runPromptTurn` (and the
              // outer `runAISession`) wedged on `await turnDone` until the
              // deployment manager force-kills the worker.
              resolveTurnDone?.();
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

        // Also purge the Postgres snapshots for this (org, agent, conv)
        // — in snapshot mode (the Phase 5 default) the next worker boot
        // would otherwise rehydrate from the now-flushed conversation
        // and the user-visible "Starting fresh" would be a lie. Best-
        // effort: a failure here is logged but doesn't block the reset
        // since the local unlink already happened and the snapshot
        // helper is a no-op in file mode.
        if (process.env.LOBU_SESSION_STORE !== "file") {
          const gatewayUrl = process.env.DISPATCHER_URL;
          const workerToken = process.env.WORKER_TOKEN;
          if (gatewayUrl && workerToken) {
            await clearSnapshots({ gatewayUrl, workerToken });
          }
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
        const errorWithHint = this.maybeBuildAuthHintMessage(
          sessionError,
          rawProvider,
          modelId
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

      // Hand the fully-streamed assistant output to the progress processor so
      // the success path's checkSandboxLeak() (worker.execute) actually runs
      // against user-facing text. Without this, getFinalResult() is always
      // null in production and the sandbox-leak redaction never fires.
      this.progressProcessor.setFinalResult({
        text: this.progressProcessor.getOutputSnapshot(),
        isFinal: true,
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
      const errorWithHint = this.maybeBuildAuthHintMessage(
        errorMsg,
        provider,
        modelId
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
      await Promise.all(
        files.map((file) =>
          fs.unlink(path.join(outputDir, file)).catch(() => {
            /* intentionally empty */
          })
        )
      );
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

    const fileOutputRules = `
**Mandatory workflow for ANY file you create or generate:**
1. Write the file to disk (e.g. \`output/report.pdf\`).
2. Call \`UploadUserFile\` with the file path — this is the ONLY way the user can access it.
3. Confirm delivery ONLY after \`UploadUserFile\` succeeds.

**Workspace paths are not accessible to users.** Paths like \`/workspace/...\` or \`/app/workspaces/...\` are internal sandbox paths. Never show them as file locations, download links, or "saved at" references. The user cannot reach them. Always use \`UploadUserFile\` instead.`;

    const common = `

## File Generation & Output

${fileOutputRules}

**When to Create Files:**
Create and show files for any output that helps answer the user's request:
- **Charts & visualizations**: pie charts, bar graphs, plots, diagrams via \`matplotlib\`
- **Reports & documents**: analysis reports, summaries, PDFs
- **Data files**: CSV exports, JSON data, spreadsheets
- **Code files**: scripts, configurations, examples
- **Images**: generated images, processed photos, screenshots.
`;

    if (files.length === 0) {
      return common;
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

    return `${common}
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

  /**
   * Finalize a successful turn: run the sandbox-leak safety net against the
   * agent's user-facing output and, when a leak is detected, re-send a redacted
   * full-replacement so the client discards the already-streamed leaky prefix.
   *
   * The content has normally already been streamed delta-by-delta, so the
   * no-leak path does NOT re-send (that would duplicate the message). The final
   * result must be populated by runAISession() on the success path (via
   * progressProcessor.setFinalResult) — when it is left null, getFinalResult()
   * returns null here and the leak check never runs.
   */
  private async deliverFinalResult(
    sawUploadedFileEvent: boolean
  ): Promise<void> {
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
    const leakCheck = finalResult
      ? checkSandboxLeak(finalResult.text, sawUploadedFileEvent)
      : null;
    if (leakCheck?.leaked && finalResult) {
      logger.warn(
        "Detected unfulfilled file-delivery claim in final message; redacting link targets"
      );
      // The already-streamed content still contains the pre-redaction URLs —
      // a delta-append would leave them on the client. Force a full
      // replacement so the client discards the leaky prefix.
      const finalText = audioPermissionHint
        ? `${leakCheck.redactedText}\n\n${audioPermissionHint}`
        : leakCheck.redactedText;
      logger.info(
        `📤 Re-sending redacted final result (${finalText.length} chars) as full replacement`
      );
      await this.workerTransport.sendStreamDelta(
        finalText,
        true,
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
  }

  private maybeBuildAuthHintMessage(
    errorMessage: string,
    provider: string,
    modelId: string
  ): string {
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
