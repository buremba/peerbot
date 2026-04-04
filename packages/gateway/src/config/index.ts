#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
import { config as dotenvConfig } from "dotenv";
import type { OrchestratorConfig } from "../orchestration/base-deployment-manager";

const logger = createLogger("cli-config");
const OWLETTO_PLUGIN_SOURCE = "@lobu/owletto-openclaw";
const NATIVE_MEMORY_PLUGIN_SOURCE = "@openclaw/native-memory";
const WORKER_PACKAGE_JSON_CANDIDATES = [
  path.resolve(process.cwd(), "packages/worker/package.json"),
  "/app/packages/worker/package.json",
] as const;

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Gateway-specific constants
 * Core constants (TIME, REDIS_KEYS, core DEFAULTS) are imported from @lobu/core
 * This file contains gateway-specific configuration values
 */

// Gateway-specific default configuration values
const GATEWAY_DEFAULTS = {
  /** Default HTTP server port */
  HTTP_PORT: 3000,
  /** Default public gateway URL */
  PUBLIC_GATEWAY_URL: "",
  /** Default queue names */
  QUEUE_DIRECT_MESSAGE: "direct_message",
  QUEUE_MESSAGE_QUEUE: "message_queue",
  /** Default worker settings */
  WORKER_IMAGE_REPOSITORY: "lobu-worker",
  WORKER_IMAGE_TAG: "latest",
  WORKER_IMAGE_DIGEST: "",
  WORKER_IMAGE_PULL_POLICY: "Always",
  WORKER_IMAGE_PULL_SECRETS: "",
  WORKER_SERVICE_ACCOUNT_NAME: "lobu-worker",
  WORKER_RUNTIME_CLASS_NAME: "kata",
  WORKER_STARTUP_TIMEOUT_SECONDS: 90,
  WORKER_CPU_REQUEST: "100m",
  WORKER_MEMORY_REQUEST: "256Mi",
  WORKER_CPU_LIMIT: "1000m",
  WORKER_MEMORY_LIMIT: "2Gi",
  WORKER_IDLE_CLEANUP_MINUTES: 60,
  MAX_WORKER_DEPLOYMENTS: 100,
  WORKER_STALE_TIMEOUT_MINUTES: 10,
  /** Default Kubernetes namespace */
  KUBERNETES_NAMESPACE: "lobu",
  /** Default cleanup settings */
  CLEANUP_INITIAL_DELAY_MS: TIME.FIVE_SECONDS_MS,
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
  CLEANUP_VERY_OLD_DAYS: 7,
  /** Default socket health settings */
  SOCKET_HEALTH_CHECK_INTERVAL_MS: 5 * TIME.MINUTE_MS, // 5 minutes
  SOCKET_STALE_THRESHOLD_MS: 15 * TIME.MINUTE_MS, // 15 minutes
  SOCKET_PROTECT_ACTIVE_WORKERS: true,
  /** Default deployment settings */
  LOBU_DEV_PROJECT_PATH: "/app",
  COMPOSE_PROJECT_NAME: "lobu",
  DISPATCHER_SERVICE_NAME: "lobu-dispatcher",
  /** Default log level */
  LOG_LEVEL: "INFO" as const,
  /** Default kubeconfig path */
  KUBECONFIG: "~/.kube/config",
  /** Embedded mode defaults */
  EMBEDDED_MAX_CONCURRENT_SESSIONS: 100,
  EMBEDDED_MAX_MEMORY_PER_SESSION_MB: 256,
  EMBEDDED_BASH_MAX_COMMAND_COUNT: 50_000,
  EMBEDDED_BASH_MAX_LOOP_ITERATIONS: 50_000,
  EMBEDDED_BASH_MAX_CALL_DEPTH: 50,
} as const;

// Merged DEFAULTS with core and gateway-specific values (internal use only)
const DEFAULTS = {
  ...CORE_DEFAULTS,
  ...GATEWAY_DEFAULTS,
} as const;

// Display formatting (internal use only)
const DISPLAY = {
  /** Horizontal separator length */
  SEPARATOR_LENGTH: 50,
  /** Token preview length for logging */
  TOKEN_PREVIEW_LENGTH: 10,
} as const;

// ============================================================================
// TYPES
// ============================================================================

/** Recursively makes all properties optional */
export type DeepPartial<T> = {
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
  providers?: Array<{ id: string; model?: string; key?: string }>;
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
    connectionString: string;
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
    internalGatewayUrl: string;
  };
  health: {
    checkIntervalMs: number;
    staleThresholdMs: number;
    protectActiveWorkers: boolean;
  };
}

// ============================================================================
// CONFIGURATION BUILDERS
// ============================================================================

/**
 * Load environment variables from .env file if in non-production
 */
export function loadEnvFile(envPath?: string): void {
  if (process.env.NODE_ENV === "production") {
    logger.debug("Production mode - skipping .env file");
    return;
  }

  const envProvided = Boolean(envPath);
  const resolvedPath = envProvided
    ? path.resolve(process.cwd(), envPath!)
    : path.resolve(process.cwd(), ".env");

  if (existsSync(resolvedPath)) {
    dotenvConfig({ path: resolvedPath });
    logger.debug(`Loaded environment variables from ${resolvedPath}`);
  } else if (envProvided) {
    logger.warn(
      `Specified env file ${resolvedPath} was not found; continuing without it.`
    );
  } else {
    logger.debug("No .env file found; relying on process environment.");
  }
}

/**
 * Derive the internal gateway URL for worker→gateway communication.
 * In K8s, uses DISPATCHER_SERVICE_NAME + namespace. In Docker, defaults to "gateway".
 */
export function getInternalGatewayUrl(): string {
  const dispatcherService = process.env.DISPATCHER_SERVICE_NAME;
  if (dispatcherService) {
    const namespace = process.env.KUBERNETES_NAMESPACE || "lobu";
    return `http://${dispatcherService}.${namespace}.svc.cluster.local:8080`;
  }
  const port = process.env.GATEWAY_PORT || "8080";
  return `http://gateway:${port}`;
}

/**
 * Build the default memory plugin list based on MEMORY_URL env var.
 * MEMORY_URL set → Owletto MCP plugin (connect to that URL) when installed
 * MEMORY_URL empty → @openclaw/native-memory (filesystem-based)
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
      const packageDir = path.join(
        path.dirname(resolverPath),
        "node_modules",
        ...packagePathParts
      );
      if (existsSync(packageDir)) {
        return true;
      }
    }
  }

  return false;
}

export function buildMemoryPlugins(options?: {
  hasOwlettoPlugin?: boolean;
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

  if (!process.env.MEMORY_URL) {
    if (hasNativeMemoryPlugin) {
      return [nativeMemoryPlugin];
    }
    logger.warn(
      `${NATIVE_MEMORY_PLUGIN_SOURCE} is not installed; continuing without a memory plugin`
    );
    return [];
  }

  const hasOwlettoPlugin =
    options?.hasOwlettoPlugin ?? isPluginInstalled(OWLETTO_PLUGIN_SOURCE);
  if (!hasOwlettoPlugin) {
    if (hasNativeMemoryPlugin) {
      logger.warn(
        `${OWLETTO_PLUGIN_SOURCE} is not installed; falling back to ${NATIVE_MEMORY_PLUGIN_SOURCE}`
      );
      return [nativeMemoryPlugin];
    }
    logger.warn(
      `${OWLETTO_PLUGIN_SOURCE} is not installed and ${NATIVE_MEMORY_PLUGIN_SOURCE} is unavailable; continuing without a memory plugin`
    );
    return [];
  }

  const gatewayUrl = getInternalGatewayUrl();
  return [
    {
      source: OWLETTO_PLUGIN_SOURCE,
      slot: "memory",
      enabled: true,
      config: {
        mcpUrl: `${gatewayUrl}/mcp/owletto`,
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

  // Required variables (allow override to satisfy the requirement)
  const connectionString =
    overrides?.queues?.connectionString || getRequiredEnv("QUEUE_URL");

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
  // Build configuration
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
      connectionString,
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
      deploymentMode: process.env.DEPLOYMENT_MODE as
        | "embedded"
        | "docker"
        | "kubernetes"
        | undefined,
      queues: {
        connectionString,
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
        image: {
          repository: getOptionalEnv(
            "WORKER_IMAGE_REPOSITORY",
            DEFAULTS.WORKER_IMAGE_REPOSITORY
          ),
          tag: getOptionalEnv("WORKER_IMAGE_TAG", DEFAULTS.WORKER_IMAGE_TAG),
          digest: getOptionalEnv(
            "WORKER_IMAGE_DIGEST",
            DEFAULTS.WORKER_IMAGE_DIGEST
          ),
          pullPolicy: getOptionalEnv(
            "WORKER_IMAGE_PULL_POLICY",
            DEFAULTS.WORKER_IMAGE_PULL_POLICY
          ),
        },
        imagePullSecrets: getOptionalEnv(
          "WORKER_IMAGE_PULL_SECRETS",
          DEFAULTS.WORKER_IMAGE_PULL_SECRETS
        )
          .split(",")
          .map((secret) => secret.trim())
          .filter(Boolean),
        serviceAccountName: getOptionalEnv(
          "WORKER_SERVICE_ACCOUNT_NAME",
          DEFAULTS.WORKER_SERVICE_ACCOUNT_NAME
        ),
        runtimeClassName: getOptionalEnv(
          "WORKER_RUNTIME_CLASS_NAME",
          DEFAULTS.WORKER_RUNTIME_CLASS_NAME
        ),
        startupTimeoutSeconds: getOptionalNumber(
          "WORKER_STARTUP_TIMEOUT_SECONDS",
          DEFAULTS.WORKER_STARTUP_TIMEOUT_SECONDS
        ),
        resources: {
          requests: {
            cpu: getOptionalEnv(
              "WORKER_CPU_REQUEST",
              DEFAULTS.WORKER_CPU_REQUEST
            ),
            memory: getOptionalEnv(
              "WORKER_MEMORY_REQUEST",
              DEFAULTS.WORKER_MEMORY_REQUEST
            ),
          },
          limits: {
            cpu: getOptionalEnv("WORKER_CPU_LIMIT", DEFAULTS.WORKER_CPU_LIMIT),
            memory: getOptionalEnv(
              "WORKER_MEMORY_LIMIT",
              DEFAULTS.WORKER_MEMORY_LIMIT
            ),
          },
        },
        idleCleanupMinutes: getOptionalNumber(
          "WORKER_IDLE_CLEANUP_MINUTES",
          DEFAULTS.WORKER_IDLE_CLEANUP_MINUTES
        ),
        maxDeployments: getOptionalNumber(
          "MAX_WORKER_DEPLOYMENTS",
          DEFAULTS.MAX_WORKER_DEPLOYMENTS
        ),
      },
      kubernetes: {
        namespace: getOptionalEnv(
          "KUBERNETES_NAMESPACE",
          DEFAULTS.KUBERNETES_NAMESPACE
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
      internalGatewayUrl: getInternalGatewayUrl(),
    },
    health: {
      checkIntervalMs: getOptionalNumber(
        "SOCKET_HEALTH_CHECK_INTERVAL_MS",
        DEFAULTS.SOCKET_HEALTH_CHECK_INTERVAL_MS
      ),
      staleThresholdMs: getOptionalNumber(
        "SOCKET_STALE_THRESHOLD_MS",
        DEFAULTS.SOCKET_STALE_THRESHOLD_MS
      ),
      protectActiveWorkers: getOptionalBoolean(
        "SOCKET_PROTECT_ACTIVE_WORKERS",
        DEFAULTS.SOCKET_PROTECT_ACTIVE_WORKERS
      ),
    },
  };

  logger.debug("Gateway configuration built successfully");

  if (overrides) {
    return deepMerge(config, overrides as Partial<GatewayConfig>);
  }

  return config;
}

/**
 * Display gateway configuration (platform-agnostic parts only)
 * Platform-specific display should be handled by platform modules
 */
export function displayGatewayConfig(config: GatewayConfig): void {
  const separator = "=".repeat(DISPLAY.SEPARATOR_LENGTH);

  console.log("Gateway Configuration:");
  console.log(separator);

  console.log("\nQueues:");
  console.log(
    `  Connection: ${config.queues.connectionString.substring(0, 30)}...`
  );
  console.log(`  Retry Limit: ${config.queues.retryLimit}`);
  console.log(`  Retry Delay: ${config.queues.retryDelay}s`);

  console.log("\nMCP:");
  console.log(
    `  Public Gateway: ${config.mcp.publicGatewayUrl || "(not set)"}`
  );

  console.log("\nOrchestration:");
  console.log(
    `  Worker Image: ${config.orchestration.worker.image.repository}`
  );
  console.log(`  Worker Tag: ${config.orchestration.worker.image.tag}`);
  if (config.orchestration.worker.image.digest) {
    console.log(`  Worker Digest: ${config.orchestration.worker.image.digest}`);
  }
  console.log(
    `  Max Deployments: ${config.orchestration.worker.maxDeployments}`
  );

  console.log("\nHealth:");
  console.log(`  Socket Check Interval: ${config.health.checkIntervalMs}ms`);
  console.log(`  Socket Stale Threshold: ${config.health.staleThresholdMs}ms`);
  console.log(
    `  Protect Active Workers: ${config.health.protectActiveWorkers}`
  );

  console.log(`\n${separator}`);
}
