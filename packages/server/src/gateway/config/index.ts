#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOptions, LogLevel, PluginConfig } from "@lobu/core";
import {
  DEFAULTS as CORE_DEFAULTS,
  createLogger,
  getOptionalBoolean,
  getOptionalEnv,
  getOptionalNumber,
  getRequiredEnv,
  TIME,
} from "@lobu/core";
import type { OrchestratorConfig } from "../orchestration/base-deployment-manager.js";
import { findEnclosingMonorepoRoot } from "../../utils/monorepo-root.js";

const __filename = fileURLToPath(import.meta.url);
const logger = createLogger("cli-config");
const LOBU_PLUGIN_SOURCE = "@lobu/openclaw-plugin";
const NATIVE_MEMORY_PLUGIN_SOURCE = "@openclaw/native-memory";
const WORKER_PACKAGE_JSON_CANDIDATES = [
  path.resolve(process.cwd(), "packages/agent-worker/package.json"),
  "/app/packages/agent-worker/package.json",
] as const;

// Gateway-specific constants; core ones (TIME, DEFAULTS) come from @lobu/core.
const GATEWAY_DEFAULTS = {
  HTTP_PORT: 3000,
  PUBLIC_GATEWAY_URL: "",
  QUEUE_DIRECT_MESSAGE: "direct_message",
  QUEUE_MESSAGE_QUEUE: "message_queue",
  WORKER_STARTUP_TIMEOUT_SECONDS: 90,
  WORKER_IDLE_CLEANUP_MINUTES: 60,
  MAX_WORKER_DEPLOYMENTS: 100,
  WORKER_STALE_TIMEOUT_MINUTES: 10,
  CLEANUP_INITIAL_DELAY_MS: TIME.FIVE_SECONDS_MS,
  CLEANUP_INTERVAL_MS: 60000,
  CLEANUP_VERY_OLD_DAYS: 7,
  LOBU_DEV_PROJECT_PATH: "/app",
  LOG_LEVEL: "INFO" as const,
  EMBEDDED_MAX_CONCURRENT_SESSIONS: 100,
  EMBEDDED_MAX_MEMORY_PER_SESSION_MB: 256,
  EMBEDDED_BASH_MAX_COMMAND_COUNT: 50_000,
  EMBEDDED_BASH_MAX_LOOP_ITERATIONS: 50_000,
  EMBEDDED_BASH_MAX_CALL_DEPTH: 50,
} as const;

const DEFAULTS = {
  ...CORE_DEFAULTS,
  ...GATEWAY_DEFAULTS,
} as const;

/** Recursively makes all properties optional */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

/**
 * Agent configuration passed programmatically via GatewayConfig.
 * Used in embedded mode to provision agents at startup without API calls.
 */
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  identityMd?: string;
  soulMd?: string;
  userMd?: string;
  providers?: Array<{
    id: string;
    model?: string;
    key?: string;
    secretRef?: string;
  }>;
  connections?: Array<{ type: string; config: Record<string, string> }>;
  skills?: { enabled?: string[]; mcp?: Record<string, any> };
  network?: { allowed?: string[]; denied?: string[] };
  nixPackages?: string[];
}

/**
 * Complete gateway configuration - single source of truth
 * Platform-specific configs (like Slack) are built separately
 */
export interface GatewayConfig {
  agents?: AgentConfig[];
  agentDefaults: Partial<AgentOptions>;
  sessionTimeoutMinutes: number;
  logLevel: LogLevel;
  queues: {
    directMessage: string;
    messageQueue: string;
    retryLimit: number;
    retryDelay: number;
    expireInHours: number;
  };
  anthropicProxy: {
    enabled: boolean;
    anthropicBaseUrl?: string;
  };
  orchestration: OrchestratorConfig;
  mcp: {
    publicGatewayUrl: string;
  };
  auth: {
    /** OIDC issuer used to validate external/service tokens. */
    issuerUrl?: string;
  };
  lobuMemory: {
    /** Public origin that serves org-scoped LOBU memory MCP endpoints under /mcp/:orgSlug. */
    publicBaseUrl?: string;
  };
  secrets: {
    /** Read-only AWS Secrets Manager backend for `aws-sm://` refs. */
    aws: {
      region?: string;
    };
  };
}

/**
 * Derive the internal gateway URL for worker→gateway communication.
 * Embedded workers are subprocesses on the same host; the gateway is
 * served by `@lobu/server` on `PORT` under the `/lobu` mount.
 * `DISPATCHER_URL` is honoured if set so a caller can override (e.g. a
 * separate network namespace).
 */
export function getInternalGatewayUrl(): string {
  if (process.env.DISPATCHER_URL) {
    return process.env.DISPATCHER_URL;
  }
  const port = process.env.PORT || process.env.GATEWAY_PORT || "8787";
  return `http://127.0.0.1:${port}/lobu`;
}

/**
 * Build the default memory plugin list. LOBU memory MCP routing is resolved by
 * the gateway at request time, so the worker only needs the stable gateway MCP
 * proxy URL; it must not depend on a process-global MEMORY_URL.
 */
function isPluginInstalled(source: string): boolean {
  const resolverPaths = new Set<string>([__filename]);
  const packagePathParts = source.split("/");

  for (const candidate of WORKER_PACKAGE_JSON_CANDIDATES) {
    if (existsSync(candidate)) {
      resolverPaths.add(candidate);
    }
  }

  for (const resolverPath of resolverPaths) {
    try {
      createRequire(resolverPath).resolve(source);
      return true;
    } catch {
      // require.resolve() can fail for ESM-only packages whose `exports` map
      // omits a `require`/`default` condition (e.g. @lobu/openclaw-plugin).
      // Fall back to walking up parent directories looking for the package
      // folder under any ancestor `node_modules`, mirroring Node's module
      // resolution algorithm.
      let dir = path.dirname(resolverPath);
      while (true) {
        const packageDir = path.join(dir, "node_modules", ...packagePathParts);
        if (existsSync(path.join(packageDir, "package.json"))) {
          return true;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }

  return false;
}

export function buildMemoryPlugins(options?: {
  hasLobuPlugin?: boolean;
  hasNativeMemoryPlugin?: boolean;
}): PluginConfig[] {
  const nativeMemoryPlugin: PluginConfig = {
    source: NATIVE_MEMORY_PLUGIN_SOURCE,
    slot: "memory",
    enabled: true,
  };
  const hasNativeMemoryPlugin =
    options?.hasNativeMemoryPlugin ??
    isPluginInstalled(NATIVE_MEMORY_PLUGIN_SOURCE);

  const hasLobuPlugin =
    options?.hasLobuPlugin ?? isPluginInstalled(LOBU_PLUGIN_SOURCE);
  if (!hasLobuPlugin) {
    if (hasNativeMemoryPlugin) {
      logger.warn(
        `${LOBU_PLUGIN_SOURCE} is not installed; falling back to ${NATIVE_MEMORY_PLUGIN_SOURCE}`
      );
      return [nativeMemoryPlugin];
    }
    logger.warn(
      `${LOBU_PLUGIN_SOURCE} is not installed and ${NATIVE_MEMORY_PLUGIN_SOURCE} is unavailable; continuing without a memory plugin`
    );
    return [];
  }

  const gatewayUrl = getInternalGatewayUrl();
  return [
    {
      source: LOBU_PLUGIN_SOURCE,
      slot: "memory",
      enabled: true,
      config: {
        mcpUrl: `${gatewayUrl}/mcp/lobu-memory`,
        gatewayAuthUrl: gatewayUrl,
      },
    },
  ];
}

/** Deep-merge utility: merges source into target, recursing into plain objects */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (
      tgtVal &&
      srcVal &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      result[key] = deepMerge(tgtVal as any, srcVal as any);
    } else {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

function buildEmbeddedWorkerPaths(projectRoot: string): {
  entryPoint: string;
  binPathEntries: string[];
} {
  // path.resolve so a relative LOBU_DEV_PROJECT_PATH still yields absolute
  // paths — workers are spawned with cwd=workspaceDir, so relative entries
  // would resolve against the workspace and fail.
  const explicitEntryPoint = process.env.LOBU_WORKER_ENTRYPOINT;
  const explicitBinPathEntries = process.env.LOBU_WORKER_BIN_PATHS?.split(
    path.delimiter
  ).filter(Boolean);

  const binPathsFor = (root: string) => [
    path.join(root, "node_modules/.bin"),
    path.join(root, "packages/agent-worker/node_modules/.bin"),
  ];

  // The passed root (LOBU_DEV_PROJECT_PATH / cwd) may be a project subdir
  // inside the monorepo — in that case the `src/index.ts` worker entry lives
  // at the enclosing workspace root, not under the subdir. Resolve it.
  const passedRoot = path.resolve(projectRoot);
  const monorepoRoot =
    existsSync(path.join(passedRoot, "packages/agent-worker/src/index.ts"))
      ? passedRoot
      : findEnclosingMonorepoRoot(passedRoot);

  if (explicitEntryPoint) {
    return {
      entryPoint: path.resolve(explicitEntryPoint),
      binPathEntries:
        explicitBinPathEntries ?? binPathsFor(monorepoRoot ?? passedRoot),
    };
  }

  if (monorepoRoot) {
    return {
      entryPoint: path.join(monorepoRoot, "packages/agent-worker/src/index.ts"),
      binPathEntries: binPathsFor(monorepoRoot),
    };
  }

  try {
    const workerPackageJson = createRequire(__filename).resolve(
      "@lobu/worker/package.json"
    );
    const workerPackageRoot = path.dirname(workerPackageJson);
    // Prefer the ESM TypeScript source (spawned via `bun run`): the published
    // CJS `dist/index.js` is a dead end because `@mariozechner/pi-coding-agent`
    // only exposes an `import` condition, so a `node`-loaded `require()` of it
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED. The package ships `src/` and a
    // `bun` exports condition for exactly this path. `bun` is a declared
    // peerDependency of `@lobu/worker`.
    const workerSrcEntry = path.join(workerPackageRoot, "src/index.ts");
    return {
      entryPoint: existsSync(workerSrcEntry)
        ? workerSrcEntry
        : path.join(workerPackageRoot, "dist/index.js"),
      binPathEntries: [
        path.join(workerPackageRoot, "node_modules/.bin"),
        path.resolve(workerPackageRoot, "..", "..", ".bin"),
      ],
    };
  } catch {
    return {
      entryPoint: path.join(
        passedRoot,
        "packages/agent-worker/src/index.ts"
      ),
      binPathEntries: binPathsFor(passedRoot),
    };
  }
}

/**
 * Build complete gateway configuration from environment variables,
 * optionally deep-merged with explicit overrides.
 *
 * @param overrides - Partial config that takes precedence over env vars.
 *   Useful for embedded mode where the host provides config programmatically.
 */
export function buildGatewayConfig(
  overrides?: DeepPartial<GatewayConfig>
): GatewayConfig {
  logger.debug("Building gateway configuration from environment variables");

  // DATABASE_URL is required; the queue / cache / probe paths read it directly
  // from process.env, so we just assert it's present here and let the rest of
  // the runtime trust the env.
  getRequiredEnv("DATABASE_URL");

  const defaultMemoryFlushEnabled = getOptionalBoolean(
    "AGENT_DEFAULT_MEMORY_FLUSH_ENABLED",
    true
  );
  const defaultMemoryFlushSoftThresholdTokens = getOptionalNumber(
    "AGENT_DEFAULT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS",
    4000
  );
  const defaultMemoryFlushSystemPrompt = getOptionalEnv(
    "AGENT_DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT",
    "Session nearing compaction. Store durable memories now."
  );
  const defaultMemoryFlushPrompt = getOptionalEnv(
    "AGENT_DEFAULT_MEMORY_FLUSH_PROMPT",
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store."
  );
  const publicGatewayUrl = getOptionalEnv(
    "PUBLIC_GATEWAY_URL",
    DEFAULTS.PUBLIC_GATEWAY_URL
  );
  const config: GatewayConfig = {
    agentDefaults: {
      allowedTools: process.env.ALLOWED_TOOLS?.split(","),
      disallowedTools: process.env.DISALLOWED_TOOLS?.split(","),
      runtime: process.env.AGENT_RUNTIME || process.env.AGENT_DEFAULT_RUNTIME,
      model: process.env.AGENT_DEFAULT_MODEL,
      timeoutMinutes: process.env.TIMEOUT_MINUTES
        ? Number(process.env.TIMEOUT_MINUTES)
        : undefined,
      compaction: {
        memoryFlush: {
          enabled: defaultMemoryFlushEnabled,
          softThresholdTokens: defaultMemoryFlushSoftThresholdTokens,
          systemPrompt: defaultMemoryFlushSystemPrompt,
          prompt: defaultMemoryFlushPrompt,
        },
      },
      pluginsConfig: {
        plugins: buildMemoryPlugins(),
      },
    },
    sessionTimeoutMinutes: getOptionalNumber(
      "SESSION_TIMEOUT_MINUTES",
      DEFAULTS.SESSION_TIMEOUT_MINUTES
    ),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || DEFAULTS.LOG_LEVEL,
    queues: {
      directMessage: getOptionalEnv(
        "QUEUE_DIRECT_MESSAGE",
        DEFAULTS.QUEUE_DIRECT_MESSAGE
      ),
      messageQueue: getOptionalEnv(
        "QUEUE_MESSAGE_QUEUE",
        DEFAULTS.QUEUE_MESSAGE_QUEUE
      ),
      retryLimit: getOptionalNumber(
        "QUEUE_RETRY_LIMIT",
        DEFAULTS.QUEUE_RETRY_LIMIT
      ),
      retryDelay: getOptionalNumber(
        "QUEUE_RETRY_DELAY",
        DEFAULTS.QUEUE_RETRY_DELAY_SECONDS
      ),
      expireInHours: getOptionalNumber(
        "QUEUE_EXPIRE_HOURS",
        DEFAULTS.QUEUE_EXPIRE_HOURS
      ),
    },
    anthropicProxy: {
      enabled: true,
      anthropicBaseUrl:
        process.env.SECRET_PROXY_UPSTREAM_URL || process.env.ANTHROPIC_BASE_URL,
    },
    orchestration: {
      queues: {
        retryLimit: getOptionalNumber(
          "QUEUE_RETRY_LIMIT",
          DEFAULTS.QUEUE_RETRY_LIMIT
        ),
        retryDelay: getOptionalNumber(
          "QUEUE_RETRY_DELAY",
          DEFAULTS.QUEUE_RETRY_DELAY_SECONDS
        ),
        expireInSeconds:
          getOptionalNumber("QUEUE_EXPIRE_HOURS", DEFAULTS.QUEUE_EXPIRE_HOURS) *
          TIME.HOUR_SECONDS,
      },
      worker: {
        startupTimeoutSeconds: getOptionalNumber(
          "WORKER_STARTUP_TIMEOUT_SECONDS",
          DEFAULTS.WORKER_STARTUP_TIMEOUT_SECONDS
        ),
        idleCleanupMinutes: getOptionalNumber(
          "WORKER_IDLE_CLEANUP_MINUTES",
          DEFAULTS.WORKER_IDLE_CLEANUP_MINUTES
        ),
        maxDeployments: getOptionalNumber(
          "MAX_WORKER_DEPLOYMENTS",
          DEFAULTS.MAX_WORKER_DEPLOYMENTS
        ),
        // Embedded-mode paths. Resolved from the monorepo root pointed at by
        // LOBU_DEV_PROJECT_PATH (defaults to cwd so CLI invocations from the
        // repo root still work). Published CLIs fall back to the installed
        // @lobu/worker package.
        ...buildEmbeddedWorkerPaths(
          process.env.LOBU_DEV_PROJECT_PATH || process.cwd()
        ),
      },
      cleanup: {
        initialDelayMs: getOptionalNumber(
          "CLEANUP_INITIAL_DELAY_MS",
          DEFAULTS.CLEANUP_INITIAL_DELAY_MS
        ),
        intervalMs: getOptionalNumber(
          "CLEANUP_INTERVAL_MS",
          DEFAULTS.CLEANUP_INTERVAL_MS
        ),
        veryOldDays: getOptionalNumber(
          "CLEANUP_VERY_OLD_DAYS",
          DEFAULTS.CLEANUP_VERY_OLD_DAYS
        ),
      },
    },
    mcp: {
      publicGatewayUrl,
    },
    auth: {
      issuerUrl: getOptionalEnv("EXTERNAL_AUTH_ISSUER_URL", undefined),
    },
    lobuMemory: {
      publicBaseUrl: getOptionalEnv("LOBU_MEMORY_PUBLIC_BASE_URL", undefined),
    },
    secrets: {
      aws: {
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      },
    },
  };

  logger.debug("Gateway configuration built successfully");

  if (overrides) {
    return deepMerge(config, overrides as Partial<GatewayConfig>);
  }

  return config;
}

