import { moduleRegistry } from "@lobu/core";
import { platformRegistry } from "../platform";
import type {
  DeploymentInfo,
  MessagePayload,
  OrchestratorConfig,
} from "./base-deployment-manager";

/**
 * Shared types and utilities for deployment managers
 * Reduces code duplication between Docker and K8s implementations
 */

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resource parsing utilities for memory and CPU limits
 */
export class ResourceParser {
  /**
   * Parse memory string (e.g., "256Mi", "1Gi", "512M") to bytes
   */
  static parseMemory(memoryStr: string): number {
    const units: Record<string, number> = {
      Ki: 1024,
      Mi: 1024 * 1024,
      Gi: 1024 * 1024 * 1024,
      k: 1000,
      M: 1000 * 1000,
      G: 1000 * 1000 * 1000,
    };

    for (const [unit, multiplier] of Object.entries(units)) {
      if (memoryStr.endsWith(unit)) {
        const value = parseFloat(memoryStr.replace(unit, ""));
        return value * multiplier;
      }
    }

    // If no unit is specified, assume bytes
    return parseInt(memoryStr, 10);
  }

  /**
   * Parse CPU string (e.g., "100m", "1", "2.5") to nanocores
   * Used by Docker which expects nanocores (1 core = 1e9 nanocores)
   */
  static parseCpu(cpuStr: string): number {
    if (cpuStr.endsWith("m")) {
      // Millicores to nanocores
      const millicores = parseInt(cpuStr.replace("m", ""), 10);
      return (millicores / 1000) * 1e9;
    }

    // Assume whole cores to nanocores
    const cores = parseFloat(cpuStr);
    return cores * 1e9;
  }
}

/**
 * Build environment variables by integrating all registered modules
 */
export async function buildModuleEnvVars(
  userId: string,
  agentId: string,
  baseEnv: Record<string, string>
): Promise<Record<string, string>> {
  let envVars = { ...baseEnv };

  const orchestratorModules = moduleRegistry.getOrchestratorModules();
  for (const module of orchestratorModules) {
    if (module.buildEnvVars) {
      envVars = await module.buildEnvVars(userId, agentId, envVars);
    }
  }

  return envVars;
}

export const LOBU_FINALIZER = "lobu.io/cleanup";

export const BASE_WORKER_LABELS = {
  "app.kubernetes.io/name": "lobu",
  "app.kubernetes.io/component": "worker",
  "lobu/managed-by": "orchestrator",
} as const;

/**
 * Worker security constants - must match Dockerfile.worker user configuration
 * The 'claude' user is created with UID/GID 1001 in the worker image
 */
export const WORKER_SECURITY = {
  USER_ID: 1001,
  GROUP_ID: 1001,
  // Tmpfs volume sizes (in-memory, matches Docker Tmpfs settings)
  TMP_SIZE_LIMIT: "100Mi",
  BUN_CACHE_SIZE_LIMIT: "200Mi",
} as const;

export const WORKER_SELECTOR_LABELS = {
  "app.kubernetes.io/name": BASE_WORKER_LABELS["app.kubernetes.io/name"],
  "app.kubernetes.io/component":
    BASE_WORKER_LABELS["app.kubernetes.io/component"],
} as const;

export function resolvePlatformDeploymentMetadata(
  messageData?: MessagePayload
): Record<string, string> {
  if (
    !messageData?.platform ||
    !messageData.channelId ||
    !messageData.conversationId ||
    !messageData.platformMetadata
  ) {
    return {};
  }

  const platform = platformRegistry.get(messageData.platform);
  if (!platform) {
    return {};
  }

  return platform.buildDeploymentMetadata(
    messageData.conversationId,
    messageData.channelId,
    messageData.platformMetadata
  );
}

export function getVeryOldThresholdDays(config: OrchestratorConfig): number {
  return config.cleanup?.veryOldDays ?? 7;
}

export function buildDeploymentInfoSummary({
  deploymentName,
  lastActivity,
  now,
  idleThresholdMinutes,
  veryOldDays,
  replicas,
}: {
  deploymentName: string;
  lastActivity: Date;
  now: number;
  idleThresholdMinutes: number;
  veryOldDays: number;
  replicas: number;
}): DeploymentInfo {
  const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
  const daysSinceActivity = minutesIdle / (60 * 24);

  return {
    deploymentName,
    lastActivity,
    minutesIdle,
    daysSinceActivity,
    replicas,
    isIdle: minutesIdle >= idleThresholdMinutes,
    isVeryOld: daysSinceActivity >= veryOldDays,
  };
}
