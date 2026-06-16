/**
 * session-runner.ts — extracted runAISession orchestration.
 *
 * This module contains the core AI session run logic, extracted from
 * OpenClawWorker to keep worker.ts focused on lifecycle (execute/cleanup/
 * transport). All behaviour, event handling, heartbeat, memory-flush, and
 * plugin-hook ordering is identical to the original implementation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createLogger,
  getOptionalEnv,
  type PluginsConfig,
  type ToolsConfig,
} from "@lobu/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ProgressUpdate, SessionExecutionResult } from "../core/types";
import { createEmbeddedBashOps } from "../embedded/just-bash-bootstrap";
import { consumePendingConfigNotifications } from "../gateway/pending-config-notifications";
import { getApiKeyEnvVarForProvider } from "../shared/provider-auth-hints";
import type { GatewayParams } from "../shared/tool-implementations";
import { isRecord } from "../shared/type-guards";
import {
  createMcpAuthToolDefinitions,
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "./custom-tools";
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
import type { OpenClawProgressProcessor } from "./processor";
import { getOpenClawSessionContext } from "./session-context";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
} from "./tool-policy";
import { buildToolUseEventPayload } from "./tool-use-events";
import { createOpenClawTools } from "./tools";
import { clearSnapshots, hydrateFromSnapshot } from "./transcript-snapshot";
import { TurnController, wrapToolsWithTurnGuard } from "./turn-controller";

const logger = createLogger("worker");

// ---------------------------------------------------------------------------
// Agent session construction
// ---------------------------------------------------------------------------

/**
 * Built-in tool names that Lobu rebuilds itself (via createOpenClawTools).
 * These carry the security-sensitive behavior — most importantly the bash
 * spawnHook that strips SENSITIVE_WORKER_ENV_KEYS and the embedded
 * BashOperations that route MCP/just-bash through the gateway. They must be
 * the instances the agent actually runs.
 */
const OVERRIDABLE_BUILTIN_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

/**
 * Build an agent session and ensure the Lobu-built built-in tools are the ones
 * the agent actually executes.
 *
 * Background: pi's `createAgentSession({ tools })` uses the `tools` option only
 * to derive the active tool NAMES — it rebuilds the underlying built-in tools
 * internally via `createAllTools(cwd, { bash: { commandPrefix } })`, whose bash
 * uses `getShellEnv()` = `{ ...process.env }` with no env strip and no custom
 * BashOperations. That silently discards the worker's hardened bash (the
 * spawnHook that strips WORKER_TOKEN/DISPATCHER_URL and the embedded
 * BashOperations), so the agent's general bash would inherit the worker's real
 * gateway credentials.
 *
 * The session keeps the active tool array on `agent.state.tools`, and tool
 * calls are resolved from that array by name at execution time. We swap the
 * rebuilt built-ins for the caller-provided Lobu instances after construction,
 * preserving every other aspect of `createAgentSession` (model resolution,
 * session restore, image blocking, extension/custom-tool wiring).
 */
export async function buildAgentSession(
  options: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult> {
  const result = await createAgentSession(options);
  const { session } = result;

  const lobuBuiltins = new Map<string, AgentTool<any>>();
  for (const tool of options.tools ?? []) {
    if (OVERRIDABLE_BUILTIN_NAMES.has(tool.name)) {
      lobuBuiltins.set(tool.name, tool as AgentTool<any>);
    }
  }
  if (lobuBuiltins.size === 0) {
    return result;
  }

  const activeTools = session.agent.state.tools;
  const patched = activeTools.map(
    (tool) => lobuBuiltins.get(tool.name) ?? tool
  );
  session.agent.setTools(patched);

  return result;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ResolvedMemoryFlushConfig {
  enabled: boolean;
  softThresholdTokens: number;
  systemPrompt: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Memory-flush / compaction utilities
// (also used by OpenClawWorker.maybeRunPreCompactionMemoryFlush in worker.ts)
// ---------------------------------------------------------------------------

export const MEMORY_FLUSH_STATE_CUSTOM_TYPE = "lobu.memory_flush_state";
const APPROX_IMAGE_TOKENS = 1200;

const DEFAULT_MEMORY_FLUSH_CONFIG: ResolvedMemoryFlushConfig = {
  enabled: true,
  softThresholdTokens: 4000,
  systemPrompt: "Session nearing compaction. Store durable memories now.",
  prompt:
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store.",
};

function readStringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
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

export function estimatePromptTokenCost(
  promptText: string,
  imageCount: number
): number {
  const textTokens = Math.ceil(promptText.length / 4);
  const imageTokens = Math.max(0, imageCount) * APPROX_IMAGE_TOKENS;
  return textTokens + imageTokens;
}

export function countCompactionsOnCurrentBranch(
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

export function readLastFlushedCompactionCount(
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

export function getLatestAssistantText(
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

// ---------------------------------------------------------------------------
// System-prompt identity replacement
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// LOBU memory plugin helper — inject agentId into config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL helper (only needed inside runAISession)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Params interface
// ---------------------------------------------------------------------------

interface RunAISessionParams {
  // Inputs from the caller
  userPrompt: string;
  customInstructions: string;
  onProgress: (update: ProgressUpdate) => Promise<void>;

  // Worker config fields needed by the session
  agentOptions: string;
  sessionKey: string;
  channelId: string;
  conversationId: string;
  platform: string;
  /** Arbitrary platform-level metadata (e.g. { sessionReset: true, files: [...] }). */
  platformMetadata: unknown;
  agentId: string | undefined;
  /**
   * Per-run worker token minted by the dispatcher (carries `source` + `runId`).
   * Used for gateway calls (interactions, MCP) so headless-run cards are stamped
   * with their origin; falls back to the deployment WORKER_TOKEN when absent.
   */
  runJobToken?: string;

  // Resolved workspace directory (from WorkspaceManager)
  workspaceDir: string;

  // Progress processor (class-owned state; passed by reference)
  progressProcessor: OpenClawProgressProcessor;

  // Callbacks back into OpenClawWorker for class-level state mutations
  /**
   * Called once the session file path has been determined so the worker can
   * capture it for cleanup()/snapshot writing.
   */
  onSessionFilePathResolved: (sessionFilePath: string) => void;
  /**
   * Called as soon as the model ref is resolved to a (provider, modelId) pair
   * so the worker can tag Sentry captures with which provider/model a later
   * failure belongs to. Fires before any provider call can fail.
   */
  onModelResolved: (provider: string, modelId: string) => void;

  // Methods delegated from OpenClawWorker (kept on the class; passed here as
  // plain function references so the class can share them with tests without
  // also exposing the full worker instance to this module).
  loadImageAttachments: () => Promise<ImageContent[]>;
  maybeRunPreCompactionMemoryFlush: (params: {
    session: Awaited<ReturnType<typeof buildAgentSession>>["session"];
    sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>;
    settingsManager: SettingsManager;
    memoryFlushConfig: ReturnType<typeof resolveMemoryFlushConfig>;
    incomingPromptText: string;
    incomingImageCount: number;
    runSilentPrompt: (prompt: string) => Promise<void>;
  }) => Promise<void>;
  maybeBuildAuthHintMessage: (
    errorMessage: string,
    provider: string,
    modelId: string
  ) => string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runAISession(
  params: RunAISessionParams
): Promise<SessionExecutionResult> {
  const {
    userPrompt,
    customInstructions,
    onProgress,
    agentOptions,
    sessionKey,
    channelId,
    conversationId,
    platform,
    platformMetadata,
    agentId,
    runJobToken,
    workspaceDir,
    progressProcessor,
    onSessionFilePathResolved,
    onModelResolved,
    loadImageAttachments,
    maybeRunPreCompactionMemoryFlush,
    maybeBuildAuthHintMessage,
  } = params;

  let rawOptions: Record<string, unknown>;
  try {
    rawOptions = JSON.parse(agentOptions) as Record<string, unknown>;
  } catch (error) {
    logger.error(
      `Failed to parse agentOptions: ${error instanceof Error ? error.message : String(error)}`
    );
    rawOptions = {};
  }
  const verboseLogging = rawOptions.verboseLogging === true;
  const memoryFlushConfig = resolveMemoryFlushConfig(rawOptions);

  progressProcessor.setVerboseLogging(verboseLogging);

  // Resolve how MCP tools should be exposed to the agent. In embedded mode,
  // operators can swap the many first-class MCP tools for a small set of
  // per-server just-bash CLIs (keeps the tool list lean).
  const configuredMcpExposure = (
    rawOptions.toolsConfig as ToolsConfig | undefined
  )?.mcpExposure;
  const mcpExposure: "tools" | "cli" =
    configuredMcpExposure === "cli" ? "cli" : "tools";

  // Fetch session context BEFORE model resolution. Pass `mcpExposure` so
  // MCP setup instructions use the right call syntax.
  const context = await getOpenClawSessionContext({ mcpExposure });

  // Sync enabled skills to workspace filesystem so the agent can `cat` them.
  // Remove stale skill directories to avoid serving removed/disabled skills.
  const skillsRoot = path.join(workspaceDir, ".skills");
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
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.content, "utf-8");
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

  const modelRef = typeof rawOptions.model === "string" ? rawOptions.model : "";

  const { provider: rawProvider, modelId } = resolveModelRef(modelRef, {
    defaultModel: pc.defaultModel,
    defaultProvider: pc.defaultProvider,
  });
  // Map gateway slug to model-registry provider name (e.g. "z-ai" → "zai")
  const provider = PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
  onModelResolved(provider, modelId);

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

  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });

  const sessionFile = path.join(workspaceDir, ".openclaw", "session.jsonl");
  // Notify the worker so cleanup() can capture it for snapshot writing at
  // terminal time.
  onSessionFilePathResolved(sessionFile);
  const providerStateFile = path.join(
    workspaceDir,
    ".openclaw",
    "provider.json"
  );

  // Hydrate from the latest completed Postgres snapshot BEFORE the
  // provider-state check or SessionManager.open().
  //
  // Order matters: hydrate → provider check (may unlink) →
  // SessionManager.open(). The provider-change unlink at line ~925 still
  // does the right thing after hydrate: it drops the file we just wrote
  // and SessionManager creates a fresh one, exactly like a first-turn
  // boot. The next snapshot will have its own run_id, so the historical
  // PG rows remain readable without poisoning the new conversation
  // (hydrate would only resurrect them if a subsequent run completes
  // successfully and overwrites the latest pointer).
  {
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
        "Snapshot hydrate skipped: DISPATCHER_URL or WORKER_TOKEN missing"
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
    // Prefer the per-run token: it carries the headless `source`, so interaction
    // and MCP cards from headless turns are stamped headless (and skip the
    // SSE-owner gate) instead of dead-lettering. The deployment WORKER_TOKEN is
    // the fallback for legacy direct-enqueue runs with no per-run token.
    workerToken: runJobToken || getOptionalEnv("WORKER_TOKEN", ""),
    channelId,
    conversationId,
    platform,
    workspaceDir,
  };

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

  // CLI backends are delivered via session context from the gateway.
  const cliBackends = pc.cliBackends;
  if (cliBackends?.length) {
    const agentList = cliBackends
      .map((b) => {
        const cmd = `${b.command} ${(b.args || []).join(" ")}`;
        const aliases = [b.name, b.providerId].filter(
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

You have access to get_channel_history to view previous messages in this thread.
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
        "ask_user posted — ending the turn so the model can't re-post."
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
    agentId
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
  let session: Awaited<ReturnType<typeof buildAgentSession>>["session"] | null =
    null;
  const pluginHookContext: Record<string, unknown> = {
    cwd: workspaceDir,
    sessionKey,
    messageProvider: platform,
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

      const hasUpdate = progressProcessor.processEvent(event);
      if (hasUpdate) {
        const delta = progressProcessor.getDelta();
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
              // Null it so the outer `finally` (which also disposes when
              // `session` is set) doesn't dispose a second time — a
              // non-idempotent dispose would throw during cleanup.
              session = null;
            }
          }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // Session reset: run unconditional memory flush, delete session file, and return early
    if ((platformMetadata as any)?.sessionReset === true) {
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
      // — the next worker boot would otherwise rehydrate from the
      // now-flushed conversation and the user-visible "Starting fresh"
      // would be a lie. Best-effort: a failure here is logged but
      // doesn't block the reset since the local unlink already
      // happened.
      {
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
        sessionKey,
      };
    }

    // Consume any pending config change notifications from SSE events.
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
    const images = await loadImageAttachments();
    if (images.length > 0) {
      logger.info(`Including ${images.length} image(s) in prompt for vision`);
    }

    await maybeRunPreCompactionMemoryFlush({
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

    const sessionError = progressProcessor.consumeFatalErrorMessage();
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
      const errorWithHint = maybeBuildAuthHintMessage(
        sessionError,
        rawProvider,
        modelId
      );
      return {
        success: false,
        exitCode: 1,
        output: "",
        error: errorWithHint,
        sessionKey,
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
    progressProcessor.setFinalResult({
      text: progressProcessor.getOutputSnapshot(),
      isFinal: true,
    });

    return {
      success: true,
      exitCode: 0,
      output: "",
      sessionKey,
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
    const errorWithHint = maybeBuildAuthHintMessage(
      errorMsg,
      provider,
      modelId
    );

    return {
      success: false,
      exitCode: 1,
      output: "",
      error: errorWithHint,
      sessionKey,
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
