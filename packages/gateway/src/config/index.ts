#!/usr/bin/env bun

import { existsSync } from "node:fs";
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

/**
 * Complete gateway configuration - single source of truth
 * Platform-specific configs (like Slack) are built separately
 */
export interface GatewayConfig {
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
function getInternalGatewayUrl(): string {
  const dispatcherService = process.env.DISPATCHER_SERVICE_NAME;
  if (dispatcherService) {
    const namespace = process.env.KUBERNETES_NAMESPACE || "lobu";
    return `http://${dispatcherService}.${namespace}.svc.cluster.local:8080`;
  }
  const port = process.env.GATEWAY_PORT || "8080";
  return `http://gateway:${port}`;
}

/**
 * Build the default memory plugin list based on MEMORY_PLUGIN env var.
 * "owletto" (default) → Owletto MCP plugin
 * "native" → @openclaw/native-memory (filesystem-based)
 */
export function buildMemoryPlugins(): PluginConfig[] {
  const memoryPlugin = getOptionalEnv("MEMORY_PLUGIN", "owletto");

  if (memoryPlugin === "native") {
    return [
      { source: "@openclaw/native-memory", slot: "memory", enabled: true },
    ];
  }

  const gatewayUrl = getInternalGatewayUrl();
  return [
    {
      source: "@lobu/owletto-openclaw",
      slot: "memory",
      enabled: true,
      config: {
        mcpUrl: `${gatewayUrl}/mcp/owletto`,
        gatewayAuthUrl: gatewayUrl,
      },
    },
  ];
}

/**
 * Build complete gateway configuration from environment variables
 * This is the SINGLE source of truth for all configuration
 */
export function buildGatewayConfig(): GatewayConfig {
  logger.debug("Building gateway configuration from environment variables");

  // Required variables
  const connectionString = getRequiredEnv("QUEUE_URL");

  // Log warning if no system key is available (providers check their own env vars)
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logger.debug(
      "No system ANTHROPIC_API_KEY configured. " +
        "Users will need to authenticate via OAuth."
    );
  }

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
