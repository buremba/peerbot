import type { ProviderCredentialContext } from "../embedded.js";
import { getOrchestratorModules } from "../modules/module-system.js";
import type { DeploymentInfo } from "./deployment-manager.js";

/**
 * Build environment variables by integrating all registered modules
 */
export async function buildModuleEnvVars(
  agentId: string,
  baseEnv: Record<string, string>,
  context?: ProviderCredentialContext
): Promise<Record<string, string>> {
  let envVars = { ...baseEnv };

  const orchestratorModules = getOrchestratorModules();
  for (const module of orchestratorModules) {
    if (module.buildEnvVars) {
      envVars = await module.buildEnvVars(agentId, envVars, context);
    }
  }

  return envVars;
}

/**
 * Run an async action over `items` in parallel batches of `batchSize`
 * (Promise.allSettled per batch — one failure never blocks the rest of the
 * batch). Rejections are reported through `onError`; the return value is the
 * number of fulfilled actions.
 */
export async function runInBatches<T>(
  items: readonly T[],
  batchSize: number,
  action: (item: T) => Promise<unknown>,
  onError: (item: T, reason: unknown) => void
): Promise<number> {
  let fulfilled = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(action));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result?.status === "fulfilled") {
        fulfilled++;
      } else {
        onError(batch[j] as T, (result as PromiseRejectedResult).reason);
      }
    }
  }
  return fulfilled;
}

/**
 * How quiet a past-max-age worker must be before it is retired. Small but
 * non-zero so a worker that just acknowledged an SSE job has time to emit its
 * first status update. The durable turn-liveness check in reconciliation is the
 * authoritative protection against mid-turn teardown.
 */
export const MAX_AGE_IDLE_GRACE_MINUTES = 1;

export function buildDeploymentInfoSummary({
  deploymentName,
  lastActivity,
  startedAt,
  now,
  idleThresholdMinutes,
  maxAgeMinutes,
  veryOldDays,
  replicas,
}: {
  deploymentName: string;
  lastActivity: Date;
  /** When this worker was spawned. */
  startedAt: Date;
  now: number;
  idleThresholdMinutes: number;
  /** 0 disables age-based retirement. */
  maxAgeMinutes: number;
  veryOldDays: number;
  replicas: number;
}): DeploymentInfo {
  const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
  const daysSinceActivity = minutesIdle / (60 * 24);

  // Past the retirement age, shorten the idle threshold without ever
  // lengthening a deployment's configured threshold. Reconciliation separately
  // verifies durable turn liveness before acting on this classification.
  const minutesAlive = (now - startedAt.getTime()) / (1000 * 60);
  const isPastMaxAge =
    maxAgeMinutes > 0 &&
    minutesAlive >= maxAgeMinutes;
  const effectiveIdleThreshold = isPastMaxAge
    ? Math.min(idleThresholdMinutes, MAX_AGE_IDLE_GRACE_MINUTES)
    : idleThresholdMinutes;

  return {
    deploymentName,
    lastActivity,
    minutesIdle,
    daysSinceActivity,
    replicas,
    isIdle: minutesIdle >= effectiveIdleThreshold,
    isVeryOld: daysSinceActivity >= veryOldDays,
    isPastMaxAge,
  };
}
